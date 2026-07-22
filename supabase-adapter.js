/**
 * ADAPTER SUPABASE
 * File ini menggantikan peran Google Apps Script (scriptURL / API_URL).
 * Diisi terlebih dahulu SUPABASE_URL & SUPABASE_ANON_KEY di bawah,
 * ambil dari Supabase Dashboard -> Project Settings -> API.
 *
 * === TAMBAHAN PENCATATAN (lihat schema_upgrade.sql) ===
 * - genId(prefix)            : ID unik anti-tabrakan (ganti Date.now()).
 * - getPetugasSesi()         : nama petugas per-sesi browser, dipakai
 *                               otomatis sebagai "oleh" di audit log.
 * - cekPeriodeTerkunci(tgl)  : dipanggil di awal setiap insert/update/
 *                               delete transaksi -> menolak jika periode
 *                               (bulan) tsb sudah "tutup buku".
 * - logAudit(...)            : mencatat jejak perubahan (audit trail).
 * - Modul baru: Tutup Buku, Audit Log, Neraca (pos manual), Rekonsiliasi
 *   Kas/Bank, dan Backup Data Lengkap.
 */
const SUPABASE_URL = "https://biidkqkrfpdnqawdgxzs.supabase.co";       // contoh: https://xxxxxxxx.supabase.co
const SUPABASE_ANON_KEY = "sb_publishable_7GGbKw6wLd2nwdvV7XcesA_oU7hm2HD";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);


// ================== DOKUMEN SK BANK SAMPAH UNIT ==================
// Dokumen disimpan pada Supabase Storage bucket `dokumen-bsu`.
// Bucket dan policy dibuat oleh upgrade_dokumen_sk_bsu.sql.
const DOKUMEN_BSU_BUCKET = 'dokumen-bsu';
const MAKS_DOKUMEN_BSU_BYTES = 10 * 1024 * 1024; // 10 MB

function namaFileAman(nama) {
  return String(nama || 'dokumen.pdf')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'dokumen.pdf';
}

function idPathAman(id) {
  return String(id || 'BSU').replace(/[^a-zA-Z0-9_-]+/g, '_');
}

// ================== UTIL: ID UNIK ==================
// Pengganti pola lama `PREFIX + Date.now()` yang berisiko kecil bentrok
// jika dua entri tersimpan di milidetik yang sama. crypto.randomUUID()
// tersedia di semua browser modern pada konteks aman (https / localhost).
function genId(prefix) {
  let unik;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    unik = crypto.randomUUID();
  } else {
    // Fallback untuk lingkungan tanpa crypto.randomUUID (browser lama / http non-aman)
    unik = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  return (prefix ? prefix + '-' : '') + unik;
}

// ================== UTIL: IDENTITAS PETUGAS PER-SESI ==================
// Dipakai untuk mengisi kolom "oleh" di audit_log tanpa perlu login
// terpisah per pengguna. Ditanya sekali per sesi tab browser, lalu
// disimpan di sessionStorage. Bisa diganti lewat resetPetugasSesi().
function getPetugasSesi() {
  try {
    let nama = sessionStorage.getItem('NAMA_PETUGAS_SESI');
    if (!nama) {
      nama = (typeof prompt === 'function')
        ? prompt('Untuk jejak audit (audit trail), masukkan nama Anda (petugas yang sedang login):')
        : null;
      nama = (nama && nama.trim()) ? nama.trim() : 'Tidak diketahui';
      sessionStorage.setItem('NAMA_PETUGAS_SESI', nama);
    }
    return nama;
  } catch (e) { return 'Tidak diketahui'; }
}
function resetPetugasSesi() {
  try { sessionStorage.removeItem('NAMA_PETUGAS_SESI'); } catch (e) {}
  return getPetugasSesi();
}

// ================== UTIL: PARSER TANGGAL FLEKSIBEL ==================
// Beberapa bagian aplikasi menyimpan tanggal transaksi dalam format ISO
// (yyyy-mm-dd, dari <input type="date"> di induk.html), tapi bagian lain
// (unit.html, penarikan tabungan BSU) menyimpan format lokal Indonesia
// "DD/MM/YYYY HH:mm". new Date(str) bawaan JS TIDAK bisa diandalkan untuk
// format kedua (bisa salah dibaca sebagai MM/DD/YYYY). Fungsi ini dipakai
// supaya cekPeriodeTerkunci() menghitung bulan/tahun dengan benar untuk
// SEMUA format tanggal yang dipakai di aplikasi ini.
function parseTanggalFleksibel(str) {
  if (!str) return new Date(NaN);
  if (str instanceof Date) return str;
  const s = String(str).trim();

  // Format ISO: yyyy-mm-dd atau yyyy-mm-ddTHH:mm:ss...
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));

  // Format dengan garis miring: bisa DD/MM/YYYY (locale id-ID, dipakai unit.html)
  // atau MM/DD/YYYY. Jika salah satu angka > 12, itu pasti posisi HARI.
  if (s.includes('/')) {
    const cleanStr = s.split(' ')[0];
    const parts = cleanStr.split('/');
    if (parts.length >= 3) {
      let a = parseInt(parts[0], 10), b = parseInt(parts[1], 10), y = parseInt(parts[2], 10);
      if (y < 100) y += 2000;
      let day, month;
      if (a > 12) { day = a; month = b; }
      else if (b > 12) { day = b; month = a; }
      else { day = a; month = b; } // ambigu -> default format Indonesia DD/MM/YYYY
      if (!isNaN(day) && !isNaN(month) && !isNaN(y)) return new Date(y, month - 1, day);
    }
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date(NaN) : d;
}

// ================== UTIL: TUTUP BUKU (CEK KUNCI PERIODE) ==================
// Mengembalikan {tahun, bulan} jika periode dari tanggal tsb berstatus
// 'tertutup', atau null jika masih terbuka / tanggal tidak valid.
async function cekPeriodeTerkunci(tglStr) {
  if (!tglStr) return null;
  const d = parseTanggalFleksibel(tglStr);
  if (isNaN(d.getTime())) return null;
  const tahun = d.getFullYear(), bulan = d.getMonth() + 1;
  try {
    const { data } = await sb.from('periode_tutup_buku').select('status').eq('tahun', tahun).eq('bulan', bulan).maybeSingle();
    return (data && data.status === 'tertutup') ? { tahun, bulan } : null;
  } catch (e) { return null; } // jika tabel migrasi belum dijalankan, jangan blokir aplikasi
}
function pesanPeriodeTerkunci(kunci) {
  return `Gagal: Periode ${String(kunci.bulan).padStart(2, '0')}/${kunci.tahun} sudah TUTUP BUKU. ` +
    `Hubungi Admin Pusat (menu "Tutup Buku Periode") untuk membuka kembali periode ini sebelum melakukan perubahan.`;
}

// ================== UTIL: AUDIT LOG ==================
// Best-effort: kegagalan mencatat audit TIDAK membatalkan operasi utama
// (supaya migrasi belum jalan / gangguan jaringan tidak mengunci aplikasi),
// tapi tetap dicatat di console untuk keperluan debug.
async function logAudit(tabel, record_id, aksi, data_lama, data_baru, keterangan) {
  try {
    await sb.from('audit_log').insert({
      tabel, record_id: String(record_id), aksi,
      oleh: getPetugasSesi(),
      data_lama: data_lama != null ? data_lama : null,
      data_baru: data_baru != null ? data_baru : null,
      keterangan: keterangan || null
    });
  } catch (e) { console.warn('Gagal mencatat audit log (' + tabel + '/' + aksi + '):', e); }
}

// Catatan: fitur cetak QR "Cek Saldo Mandiri" TIDAK lagi memuat pustaka QR/PDF
// dari CDN sama sekali -- QRCode.js sudah disematkan langsung (inline) di
// <head> induk.html & unit.html, dan pencetakan memakai window.print() bawaan
// browser (bukan jsPDF), supaya fitur ini tetap berfungsi meski CDN eksternal
// diblokir jaringan.

// ================== UTIL: RESTORE DATA DARI BACKUP ==================
// Tabel-tabel yang bisa di-restore langsung dengan pola upsert-per-id biasa
// (primary key kolom "id", tanpa constraint unik lain yang perlu ditangani
// khusus, dan tanpa kolom rahasia yang harus disamarkan).
const TABEL_RESTORE_SEDERHANA = [
  'nasabah', 'kategori', 'transaksi', 'penjualan', 'bantuan_hibah', 'pembinaan_bsu',
  'kejadian_darurat', 'alat', 'biaya_operasional', 'pemeliharaan_investasi',
  'neraca_pos', 'rekonsiliasi_kas', 'stock_opname', 'kas_mutasi'
];
// Urutan hapus (mode Ganti Total): tabel "anak" dulu, baru "induk" (bsu paling akhir)
// supaya tidak melanggar foreign key (nasabah & transaksi merujuk ke bsu.id).
const URUTAN_HAPUS_TOTAL = [
  'transaksi', 'nasabah', 'penjualan', 'bantuan_hibah', 'pembinaan_bsu', 'kejadian_darurat',
  'alat', 'biaya_operasional', 'pemeliharaan_investasi', 'neraca_pos', 'rekonsiliasi_kas',
  'stock_opname', 'kas_mutasi', 'periode_tutup_buku', 'kategori', 'bsu'
];
// Urutan insert (mode Ganti Total): kebalikan dari urutan hapus (induk dulu).
const URUTAN_INSERT_TOTAL = ['bsu', 'kategori', 'nasabah', 'transaksi', 'penjualan', 'bantuan_hibah',
  'pembinaan_bsu', 'kejadian_darurat', 'alat', 'biaya_operasional', 'pemeliharaan_investasi',
  'neraca_pos', 'rekonsiliasi_kas', 'stock_opname', 'kas_mutasi'];

// Upsert baris BSU dari backup TANPA menimpa password yang sudah ada di server.
// BSU yang tidak ditemukan di server (berarti sebelumnya terhapus) akan dibuatkan
// password sementara acak, dan wajib direset manual oleh Admin Pusat setelahnya.
async function restoreBsuAman(rowsBackup) {
  if (!Array.isArray(rowsBackup) || !rowsBackup.length) return { ok: true, jumlah: 0 };
  const { data: existing } = await sb.from('bsu').select('id');
  const existingIds = new Set((existing || []).map(r => r.id));
  const perluReset = [];
  const rows = rowsBackup.map(r => {
    const row = { ...r };
    delete row.password; // field ini memang tidak ada di backup, dijaga eksplisit
    if (!existingIds.has(row.id)) {
      row.password = 'RESET-' + genId().slice(0, 8).toUpperCase();
      perluReset.push(row.id);
    }
    return row;
  });
  const { error } = await sb.from('bsu').upsert(rows, { onConflict: 'id' });
  if (error) return { ok: false, error: error.message };
  logAudit('bsu', 'RESTORE-' + rows.length + '-BARIS', 'update', null, { jumlah: rows.length }, 'Restore (gabung) dari file backup oleh ' + getPetugasSesi());
  return { ok: true, jumlah: rows.length, perluResetPassword: perluReset };
}

// periode_tutup_buku punya constraint unik di (tahun, bulan), bukan di kolom id
// (id-nya bigserial dan tidak stabil untuk dipulihkan persis). Kolom id dari
// backup sengaja dibuang supaya id baru dibuat otomatis oleh database.
async function restorePeriodeTutupBuku(rowsBackup) {
  if (!Array.isArray(rowsBackup) || !rowsBackup.length) return { ok: true, jumlah: 0 };
  const rows = rowsBackup.map(({ id, ...rest }) => rest);
  const { error } = await sb.from('periode_tutup_buku').upsert(rows, { onConflict: 'tahun,bulan' });
  if (error) return { ok: false, error: error.message };
  return { ok: true, jumlah: rows.length };
}

async function upsertTabelSederhana(tabel, rowsBackup) {
  if (!Array.isArray(rowsBackup) || !rowsBackup.length) return { ok: true, jumlah: 0 };
  const { error } = await sb.from(tabel).upsert(rowsBackup, { onConflict: 'id' });
  if (error) return { ok: false, error: error.message };
  return { ok: true, jumlah: rowsBackup.length };
}

async function insertTabelSederhana(tabel, rowsBackup) {
  if (!Array.isArray(rowsBackup) || !rowsBackup.length) return { ok: true, jumlah: 0 };
  const { error } = await sb.from(tabel).insert(rowsBackup);
  if (error) return { ok: false, error: error.message };
  return { ok: true, jumlah: rowsBackup.length };
}

// Menghapus SEMUA baris di sebuah tabel. `.not('id','is',null)` cocok untuk
// kolom id bertipe teks maupun angka (selalu true untuk primary key, karena
// PK tidak pernah NULL) -> dipakai sebagai filter "match semua baris" yang
// aman tanpa perlu tahu tipe kolom id persis di tiap tabel.
async function hapusSemuaBaris(tabel) {
  const { error } = await sb.from(tabel).delete().not('id', 'is', null);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

const AdapterAPI = {

  // ================== LOGIN (dipakai index.html) ==================
  // Password dicek di server (Edge Function), TIDAK PERNAH dikirim mentah ke browser.
  async loginServer(username, password) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ username, password })
    });
    return res.json(); // { ok:true, role, id_unit, nama } atau { ok:false, error }
  },

  // Ubah ID/password Admin Pusat. Dicek & disimpan di server (Edge Function),
  // password lama wajib benar dulu sebelum diizinkan mengganti.
  async updateAdminAccount({ currentPassword, newUsername, newPassword }) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/update-admin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ currentPassword, newUsername, newPassword })
    });
    return res.json(); // { ok:true, username } atau { ok:false, error }
  },

  // ================== DATA UNTUK INDUK.HTML ==================
  async getBundleBSI() {
    const [{ data: kategori }, { data: bsuList }, { data: transaksi }, { data: hibah }] = await Promise.all([
      sb.from('kategori').select('*').order('id'),
      sb.from('bsu').select('*'),
      sb.from('transaksi').select('*').eq('level', 'unit_ke_induk').order('tgl', { ascending: false }),
      sb.from('bantuan_hibah').select('*')
    ]);
    return { kategori: kategori || [], nasabah: bsuList || [], transaksi: transaksi || [], hibah: hibah || [] };
  },

  async tambahBantuanHibah(form) {
    const id = 'HBH-' + genId();
    const row = { id, ...form };
    const { error } = await sb.from('bantuan_hibah').insert(row);
    if (error) return 'Gagal: ' + error.message;
    logAudit('bantuan_hibah', id, 'insert', null, row);
    return 'Sukses tersimpan';
  },
  async deleteBantuanHibah(id) {
    const { data: lama } = await sb.from('bantuan_hibah').select('*').eq('id', id).maybeSingle();
    const { error } = await sb.from('bantuan_hibah').delete().eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('bantuan_hibah', id, 'delete', lama || null, null);
    return 'Sukses dihapus';
  },

  // ================== DOKUMEN LAPORAN ==================
  async getDokumenLaporanBundle() {
    const [{ data: pembinaan }, { data: darurat }] = await Promise.all([
      sb.from('pembinaan_bsu').select('*'),
      sb.from('kejadian_darurat').select('*')
    ]);
    return { pembinaan: pembinaan || [], darurat: darurat || [] };
  },
  async tambahPembinaan(form) {
    const id = 'PBN-' + genId();
    const row = { id, ...form };
    const { error } = await sb.from('pembinaan_bsu').insert(row);
    if (error) return 'Gagal: ' + error.message;
    logAudit('pembinaan_bsu', id, 'insert', null, row);
    return 'Sukses tersimpan';
  },
  async deletePembinaan(id) {
    const { data: lama } = await sb.from('pembinaan_bsu').select('*').eq('id', id).maybeSingle();
    const { error } = await sb.from('pembinaan_bsu').delete().eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('pembinaan_bsu', id, 'delete', lama || null, null);
    return 'Sukses dihapus';
  },
  async tambahKejadianDarurat(form) {
    const id = 'DRT-' + genId();
    const row = { id, ...form };
    const { error } = await sb.from('kejadian_darurat').insert(row);
    if (error) return 'Gagal: ' + error.message;
    logAudit('kejadian_darurat', id, 'insert', null, row);
    return 'Sukses tersimpan';
  },
  async deleteKejadianDarurat(id) {
    const { data: lama } = await sb.from('kejadian_darurat').select('*').eq('id', id).maybeSingle();
    const { error } = await sb.from('kejadian_darurat').delete().eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('kejadian_darurat', id, 'delete', lama || null, null);
    return 'Sukses dihapus';
  },

  async getRingkasanDashboard() {
    const { count: unit } = await sb.from('bsu').select('*', { count: 'exact', head: true });
    const { data: trxBulanIni } = await sb
      .from('transaksi')
      .select('berat, total, tgl')
      .eq('level', 'unit_ke_induk')
      .gt('berat', 0);

    const now = new Date();
    const bulanIni = trxBulanIni.filter(t => {
      const d = new Date(t.tgl);
      return !isNaN(d) && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
    const totalSampah = trxBulanIni.reduce((a, t) => a + (parseFloat(t.berat) || 0), 0);

    return { ringkasan: { unit: unit || 0, setoran_bulan: bulanIni.length, total_sampah: totalSampah.toFixed(1) } };
  },

  async getTransaksiInternalBSU(namaBsu) {
    const { data: bsuRow } = await sb.from('bsu').select('id').eq('nama', namaBsu).single();
    if (!bsuRow) return { transaksi: [] };
    const { data } = await sb.from('transaksi').select('*').eq('id_unit', bsuRow.id).eq('level', 'nasabah_ke_unit');
    return { transaksi: data || [] };
  },

  // Semua transaksi nasabah->BSU (SEMUA unit) + master data nasabah, dipakai untuk
  // menu Saldo/Tabungan BSU di induk.html.
  async getSemuaTransaksiNasabah() {
    const [{ data: transaksi }, { data: nasabah }] = await Promise.all([
      sb.from('transaksi').select('*').eq('level', 'nasabah_ke_unit'),
      sb.from('nasabah').select('*')
    ]);
    return { transaksi: transaksi || [], nasabah: nasabah || [] };
  },

  // ---- Transaksi (level BSI: BSU -> BSI) ----
  async tambahTransaksiInduk({ tgl, nama, id_unit, jenis, berat, total, oleh }) {
    const kunci = await cekPeriodeTerkunci(tgl);
    if (kunci) return pesanPeriodeTerkunci(kunci);

    const id = 'TRX-' + genId();
    const row = { id, id_unit, level: 'unit_ke_induk', nama, tgl, jenis, berat, total };
    const { error } = await sb.from('transaksi').insert(row);
    if (error) return 'Gagal: ' + error.message;
    logAudit('transaksi', id, 'insert', null, row, oleh ? ('dicatat oleh ' + oleh) : null);
    return 'Sukses tersimpan';
  },

  // Tarik Tabungan BSU (BSI membayar tunai/transfer ke BSU, mengurangi saldo BSU di BSI)
  async tambahPenarikanBSU({ nomorTransaksi, tgl, nama, id_unit, jumlah, metode, status, disetujuiOleh }) {
    const kunci = await cekPeriodeTerkunci(tgl);
    if (kunci) return pesanPeriodeTerkunci(kunci);

    const id = nomorTransaksi || genId('TRX');
    const row = {
      id, id_unit, level: 'unit_ke_induk', nama, tgl,
      jenis: 'Penarikan Tabungan', berat: 0, total: -Math.abs(jumlah),
      metode, status, disetujui_oleh: disetujuiOleh
    };
    const { error } = await sb.from('transaksi').insert(row);
    if (error) return 'Gagal: ' + error.message;
    logAudit('transaksi', id, 'insert', null, row, 'Penarikan tabungan, disetujui oleh ' + (disetujuiOleh || '-'));
    return 'Sukses tersimpan';
  },

  async updateTransaksi({ id, tgl, jenis, berat, total, oleh }) {
    const { data: lama } = await sb.from('transaksi').select('*').eq('id', id).maybeSingle();
    if (!lama) return 'Gagal: Data transaksi tidak ditemukan.';

    // Kunci periode dicek untuk tanggal LAMA maupun tanggal BARU (kalau tanggal diubah
    // lintas periode), supaya tidak bisa memindahkan transaksi keluar dari periode terkunci
    // ataupun mengedit transaksi yang berada di periode yang sudah tutup buku.
    const kunciLama = await cekPeriodeTerkunci(lama.tgl);
    if (kunciLama) return pesanPeriodeTerkunci(kunciLama);
    const kunciBaru = await cekPeriodeTerkunci(tgl);
    if (kunciBaru) return pesanPeriodeTerkunci(kunciBaru);

    const dataBaru = { tgl, jenis, berat, total };
    const { error } = await sb.from('transaksi').update(dataBaru).eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('transaksi', id, 'update', lama, { ...lama, ...dataBaru }, oleh ? ('diubah oleh ' + oleh) : null);
    return 'Sukses diperbarui';
  },

  async deleteTransaksi(id, oleh) {
    const { data: lama } = await sb.from('transaksi').select('*').eq('id', id).maybeSingle();
    if (!lama) return 'Gagal: Data transaksi tidak ditemukan.';

    const kunci = await cekPeriodeTerkunci(lama.tgl);
    if (kunci) return pesanPeriodeTerkunci(kunci);

    const { error } = await sb.from('transaksi').delete().eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('transaksi', id, 'delete', lama, null, oleh ? ('dihapus oleh ' + oleh) : null);
    return 'Sukses dihapus';
  },

  // ---- Dokumen SK BSU (Supabase Storage) ----
  async uploadDokumenSkBsu({ id_unit, file }) {
    if (!file || typeof file.arrayBuffer !== 'function') {
      return { ok: false, error: 'Pilih file PDF terlebih dahulu.' };
    }
    const namaAsli = String(file.name || 'dokumen-sk.pdf');
    const ekstensiPdf = /\.pdf$/i.test(namaAsli);
    const mimePdf = !file.type || file.type === 'application/pdf';
    if (!ekstensiPdf || !mimePdf) {
      return { ok: false, error: 'Dokumen SK harus berformat PDF.' };
    }
    if (Number(file.size || 0) > MAKS_DOKUMEN_BSU_BYTES) {
      return { ok: false, error: 'Ukuran PDF maksimal 10 MB.' };
    }

    const namaSimpan = `${Date.now()}_${namaFileAman(namaAsli)}`;
    const path = `${idPathAman(id_unit)}/${namaSimpan}`;
    const { error } = await sb.storage.from(DOKUMEN_BSU_BUCKET).upload(path, file, {
      cacheControl: '3600',
      contentType: 'application/pdf',
      upsert: false
    });
    if (error) return { ok: false, error: 'Gagal mengunggah PDF SK: ' + error.message };

    const { data } = sb.storage.from(DOKUMEN_BSU_BUCKET).getPublicUrl(path);
    return { ok: true, path, nama: namaAsli, url: data?.publicUrl || '' };
  },

  getDokumenSkBsuUrl(path) {
    if (!path) return '';
    if (/^https?:\/\//i.test(String(path))) return String(path);
    const { data } = sb.storage.from(DOKUMEN_BSU_BUCKET).getPublicUrl(String(path));
    return data?.publicUrl || '';
  },

  async hapusDokumenSkBsu(path) {
    if (!path || /^https?:\/\//i.test(String(path))) return { ok: true };
    const { error } = await sb.storage.from(DOKUMEN_BSU_BUCKET).remove([String(path)]);
    return error ? { ok: false, error: error.message } : { ok: true };
  },

  async downloadDokumenSkBsu(path, namaFile) {
    const url = this.getDokumenSkBsuUrl(path);
    if (!url) return { ok: false, error: 'Dokumen SK belum tersedia.' };
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = namaFileAman(namaFile || 'SK-Bank-Sampah-Unit.pdf');
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      return { ok: true };
    } catch (e) {
      // Fallback apabila CORS/proxy browser mencegah fetch; tetap buka URL publik.
      window.open(url, '_blank', 'noopener');
      return { ok: false, error: 'Unduhan langsung dibuka di tab baru: ' + (e?.message || e) };
    }
  },

  // ---- BSU (unit) ----
  async tambahUnit(form) {
    const id = form.id || ('BSU-' + genId());
    const row = { ...form, id };
    const { error } = await sb.from('bsu').insert(row);
    if (error) return 'Gagal: ' + error.message;
    const { password, ...rowTanpaPassword } = row;
    logAudit('bsu', row.id, 'insert', null, rowTanpaPassword);
    return 'Sukses mendaftarkan BSU';
  },
  async updateUnit(form) {
    const { id, ...rest } = form;
    const { data: lama } = await sb.from('bsu').select('*').eq('id', id).maybeSingle();
    const { error } = await sb.from('bsu').update(rest).eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    if (lama?.sk_pdf_path && rest.sk_pdf_path && lama.sk_pdf_path !== rest.sk_pdf_path) {
      this.hapusDokumenSkBsu(lama.sk_pdf_path).catch(() => {});
    }
    const stripPass = (o) => { if (!o) return o; const { password, ...r } = o; return r; };
    logAudit('bsu', id, 'update', stripPass(lama), stripPass({ ...lama, ...rest }));
    return 'Sukses diperbarui';
  },
  async deleteUnit(id) {
    const { data: lama } = await sb.from('bsu').select('*').eq('id', id).maybeSingle();
    const { error } = await sb.from('bsu').delete().eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    if (lama?.sk_pdf_path) this.hapusDokumenSkBsu(lama.sk_pdf_path).catch(() => {});
    const stripPass = (o) => { if (!o) return o; const { password, ...r } = o; return r; };
    logAudit('bsu', id, 'delete', stripPass(lama), null);
    return 'Sukses dihapus';
  },

  // ---- Kategori ----
  async tambahKategori(form) {
    const { data, error } = await sb.from('kategori').insert({
      jenis_material: form.jenis_material, nama_kategori: form.nama_kategori, harga: form.harga
    }).select().maybeSingle();
    if (error) return 'Gagal: ' + error.message;
    logAudit('kategori', data ? data.id : form.nama_kategori, 'insert', null, data || form);
    return 'Sukses tersimpan';
  },
  async updateKategori(form) {
    const { data: lama } = await sb.from('kategori').select('*').eq('id', form.id).maybeSingle();
    const dataBaru = { jenis_material: form.jenis_material, nama_kategori: form.nama_kategori, harga: form.harga };
    const { error } = await sb.from('kategori').update(dataBaru).eq('id', form.id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('kategori', form.id, 'update', lama, { ...lama, ...dataBaru });
    return 'Sukses diperbarui';
  },
  async deleteKategori(id) {
    const { data: lama } = await sb.from('kategori').select('*').eq('id', id).maybeSingle();
    const { error } = await sb.from('kategori').delete().eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('kategori', id, 'delete', lama || null, null);
    return 'Sukses dihapus';
  },

  // ================== DATA UNTUK UNIT.HTML ==================
  async getBundleBSU(idUnit) {
    const [nasRes, trxRes, keluarRes, katRes, unitRes, opnameRes, kasRes, rekRes, auditRes] = await Promise.all([
      sb.from('nasabah').select('*').eq('id_unit', idUnit),
      sb.from('transaksi').select('*').eq('id_unit', idUnit).eq('level', 'nasabah_ke_unit'),
      sb.from('transaksi').select('*').eq('id_unit', idUnit).eq('level', 'unit_ke_induk'),
      sb.from('kategori').select('*').order('id'),
      sb.from('bsu').select('*').eq('id', idUnit),
      sb.from('stock_opname').select('*').eq('id_unit', idUnit),
      sb.from('kas_mutasi').select('*').eq('id_unit', idUnit),
      sb.from('rekonsiliasi_kas').select('*').eq('id_unit', idUnit),
      sb.from('audit_log').select('*').order('waktu', { ascending: false }).limit(500)
    ]);
    const audit = (auditRes.data || []).filter(a => {
      const teks = JSON.stringify([a.record_id, a.data_lama, a.data_baru, a.keterangan]);
      return teks.includes(String(idUnit));
    });
    return {
      nasabah: nasRes.data || [], transaksi: trxRes.data || [], transaksiKeluar: keluarRes.data || [],
      kategori: katRes.data || [], unit: unitRes.data || [], stockOpname: opnameRes.data || [],
      kasMutasi: kasRes.data || [], rekonsiliasi: rekRes.data || [], audit
    };
  },

  async tambahNasabah(form) {
    const idFix = form.id || genId('NSB');
    const row = { id: idFix, id_unit: form.id_unit, nama: form.nama, hp: form.hp,
      alamat: form.alamat || null, rt: form.rt || null, rw: form.rw || null,
      jenis_nasabah: form.jenis_nasabah || 'Rumah Tangga', status: form.status || 'aktif',
      izin_whatsapp: form.izin_whatsapp !== false, tanggal_gabung: form.tanggal_gabung || new Date().toISOString().slice(0,10) };
    const { error } = await sb.from('nasabah').insert(row);
    if (error) return 'Gagal: ' + error.message;
    logAudit('nasabah', idFix, 'insert', null, row);
    return 'Sukses';
  },
  async editNasabah(form) {
    const id = String(form?.id || '').trim();
    if (!id) return 'Gagal: ID nasabah kosong.';
    const { data: lama, error: errBaca } = await sb.from('nasabah').select('*').eq('id', id).maybeSingle();
    if (errBaca) return 'Gagal: ' + errBaca.message;
    if (!lama) return 'Gagal: Data nasabah tidak ditemukan.';

    const statusFix = String(form.status || lama.status || 'aktif').toLowerCase() === 'nonaktif' ? 'nonaktif' : 'aktif';
    const dataBaru = {
      nama: String(form.nama ?? lama.nama ?? '').trim(),
      hp: String(form.hp ?? lama.hp ?? '').trim(),
      alamat: form.alamat !== undefined ? (form.alamat || null) : (lama.alamat || null),
      rt: form.rt !== undefined ? (form.rt || null) : (lama.rt || null),
      rw: form.rw !== undefined ? (form.rw || null) : (lama.rw || null),
      jenis_nasabah: form.jenis_nasabah || lama.jenis_nasabah || 'Rumah Tangga',
      status: statusFix,
      izin_whatsapp: form.izin_whatsapp !== undefined ? Boolean(form.izin_whatsapp) : (lama.izin_whatsapp !== false)
    };
    if (!dataBaru.nama || !dataBaru.hp) return 'Gagal: Nama dan nomor WhatsApp wajib diisi.';

    const { error } = await sb.from('nasabah').update(dataBaru).eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('nasabah', id, 'update', lama, { ...lama, ...dataBaru }, 'Perubahan data/status nasabah melalui menu edit BSU');
    return 'Sukses diperbarui';
  },

  async deleteNasabah(id) {
    const { data: lama, error: errBaca } = await sb.from('nasabah').select('*').eq('id', id).maybeSingle();
    if (errBaca) return 'Gagal: ' + errBaca.message;
    if (!lama) return 'Gagal: Data nasabah tidak ditemukan.';
    if (String(lama.status || 'aktif').toLowerCase() !== 'nonaktif') {
      return 'Gagal: Nasabah masih berstatus AKTIF. Ubah menjadi NONAKTIF melalui tombol Edit terlebih dahulu.';
    }

    const [{ count: countId, error: errId }, { count: countLegacy, error: errLegacy }] = await Promise.all([
      sb.from('transaksi').select('id', { count: 'exact', head: true }).eq('id_unit', lama.id_unit).eq('id_nasabah', id),
      sb.from('transaksi').select('id', { count: 'exact', head: true }).eq('id_unit', lama.id_unit).is('id_nasabah', null).eq('nama', lama.nama)
    ]);
    if (errId || errLegacy) return 'Gagal memeriksa riwayat transaksi: ' + (errId?.message || errLegacy?.message || 'kesalahan database');
    if (Number(countId || 0) + Number(countLegacy || 0) > 0) {
      return 'Gagal: Nasabah memiliki riwayat transaksi. Gunakan otorisasi Penghapusan Total Super Admin.';
    }

    const { error } = await sb.from('nasabah').delete().eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('nasabah', id, 'delete', lama || null, null, 'Penghapusan permanen nasabah nonaktif tanpa riwayat transaksi');
    return 'Sukses dihapus';
  },

  // Penghapusan TOTAL nasabah yang sudah mempunyai transaksi hanya dilakukan
  // melalui Edge Function. Kredensial Super Admin diverifikasi di server.
  // Master nasabah, transaksi, mutasi kas terkait, arsip lama, dan audit rinci
  // dihapus atomik oleh RPC service_role.
  async deleteNasabahSuperAdmin(form) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/delete-nasabah-superadmin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
          'apikey': SUPABASE_ANON_KEY
        },
        body: JSON.stringify(form || {})
      });
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        data = { ok: false, error: 'Respons server tidak valid.' };
      }
      if (!res.ok || data?.ok !== true) {
        return { ok: false, error: data?.error || ('HTTP ' + res.status) };
      }
      return data;
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  },

  // Mengubah ID (primary key) nasabah lama -> format baru (3 huruf desa + 5
  // angka). Dipakai fitur migrasi satu-kali di unit.html untuk menyeragamkan
  // ID nasabah yang didaftarkan sebelum fitur ID otomatis dibuat. Aman karena
  // tidak ada tabel lain yang mereferensikan nasabah.id lewat foreign key
  // (transaksi dikaitkan lewat kecocokan nama, bukan id).
  async updateIdNasabah(idLama, idBaru) {
    const { data: lama } = await sb.from('nasabah').select('*').eq('id', idLama).maybeSingle();
    if (!lama) return 'Gagal: Data nasabah tidak ditemukan.';
    const { error } = await sb.from('nasabah').update({ id: idBaru }).eq('id', idLama);
    if (error) return 'Gagal: ' + error.message;
    logAudit('nasabah', idBaru, 'update', lama, { ...lama, id: idBaru }, 'Migrasi format ID dari ' + idLama + ' ke ' + idBaru);
    return 'Sukses';
  },

  async tambahTransaksiUnit(form) {
    const kunci = await cekPeriodeTerkunci(form.tgl);
    if (kunci) return pesanPeriodeTerkunci(kunci);
    const idFix = form.id != null ? String(form.id) : genId('TRX');
    const row = { id: idFix, id_unit: form.id_unit, level: 'nasabah_ke_unit', id_nasabah: form.id_nasabah || null,
      nama: form.nama, tgl: form.tgl, jenis: form.jenis, berat: form.berat, harga_satuan: form.harga_satuan || (form.berat ? form.total/form.berat : 0),
      total: form.total, kelompok_id: form.kelompok_id || null, status: form.status || 'aktif', metode: form.metode || null,
      no_dokumen: form.no_dokumen || null, catatan: form.catatan || null, created_by: form.oleh || getPetugasSesi() };
    const { error } = await sb.from('transaksi').insert(row);
    if (error) return 'Gagal: ' + error.message;
    logAudit('transaksi', idFix, 'insert', null, row, 'Unit ' + form.id_unit + ' — dicatat oleh ' + row.created_by);
    return 'Sukses';
  },

  // Satu INSERT berisi seluruh item setoran: atomik pada satu statement database.
  async tambahSetoranBatchUnit({ id_unit, id_nasabah, nama, tgl, items, kelompok_id, oleh }) {
    const kunci = await cekPeriodeTerkunci(tgl);
    if (kunci) return pesanPeriodeTerkunci(kunci);
    if (!Array.isArray(items) || !items.length) return 'Gagal: Item setoran kosong.';
    const rows = items.map(item => ({
      id: genId('TRX'), id_unit, level: 'nasabah_ke_unit', id_nasabah, nama, tgl,
      jenis: item.jenis, berat: Number(item.berat) || 0,
      harga_satuan: Number(item.harga_satuan ?? item.harga ?? ((Number(item.berat)||0) ? Number(item.total)/(Number(item.berat)||1) : 0)) || 0,
      total: Number(item.total) || 0, kelompok_id: kelompok_id || null, status: 'aktif', created_by: oleh || getPetugasSesi()
    }));
    const { error } = await sb.from('transaksi').insert(rows);
    if (error) return 'Gagal: ' + error.message;
    rows.forEach(row => logAudit('transaksi', row.id, 'insert', null, row, 'Setoran batch unit ' + id_unit + ' oleh ' + row.created_by));
    return 'Sukses: ' + rows.length + ' item tersimpan';
  },

  async tambahPengirimanBSI(form) {
    const kunci = await cekPeriodeTerkunci(form.tgl);
    if (kunci) return pesanPeriodeTerkunci(kunci);
    const id = genId('TRX');
    const row = { id, id_unit: form.id_unit, level: 'unit_ke_induk', nama: form.nama, tgl: form.tgl,
      jenis: form.jenis, berat: Number(form.berat)||0, harga_satuan: Number(form.harga_satuan)||0,
      total: Number(form.total)||0, no_dokumen: form.no_dokumen||null, status_pembayaran: form.status_pembayaran||'belum_dibayar',
      metode: form.metode||null, biaya_angkut: Number(form.biaya_angkut)||0, catatan: form.catatan||null,
      status: 'aktif', created_by: form.oleh||getPetugasSesi() };
    const { error } = await sb.from('transaksi').insert(row);
    if (error) return 'Gagal: ' + error.message;
    logAudit('transaksi', id, 'insert', null, row, 'Pengiriman BSU ke BSI oleh ' + row.created_by);
    if (row.status_pembayaran === 'lunas' && row.total > 0) {
      await this.tambahKasMutasi({ id_unit: form.id_unit, tanggal: form.tgl, arah: 'masuk', kategori: 'Pembayaran BSI', nominal: row.total,
        metode: row.metode, no_bukti: row.no_dokumen, keterangan: 'Pembayaran pengiriman ' + row.jenis, referensi_id: id, oleh: row.created_by });
    }
    return 'Sukses tersimpan';
  },

  async tambahStockOpname(form) {
    const kunci = await cekPeriodeTerkunci(form.tanggal);
    if (kunci) return pesanPeriodeTerkunci(kunci);
    const id = genId('SOP');
    const row = { id, id_unit: form.id_unit, tanggal: form.tanggal, material: form.material,
      stok_sistem: Number(form.stok_sistem)||0, stok_fisik: Number(form.stok_fisik)||0,
      selisih: Number(form.selisih)||0, alasan: form.alasan||null, diperiksa_oleh: form.diperiksa_oleh||getPetugasSesi(), status:'aktif' };
    const { error } = await sb.from('stock_opname').insert(row);
    if (error) return 'Gagal: ' + error.message;
    logAudit('stock_opname', id, 'insert', null, row, 'Stock opname unit ' + form.id_unit);
    return 'Sukses tersimpan';
  },

  async tambahKasMutasi(form) {
    const kunci = await cekPeriodeTerkunci(form.tanggal);
    if (kunci) return pesanPeriodeTerkunci(kunci);
    const id = genId('KAS');
    const row = { id, id_unit: form.id_unit, tanggal: form.tanggal, arah: form.arah, kategori: form.kategori,
      nominal: Number(form.nominal)||0, metode: form.metode||null, no_bukti: form.no_bukti||null,
      keterangan: form.keterangan||null, referensi_id: form.referensi_id||null, oleh: form.oleh||getPetugasSesi(), status:'aktif' };
    const { error } = await sb.from('kas_mutasi').insert(row);
    if (error) return 'Gagal: ' + error.message;
    logAudit('kas_mutasi', id, 'insert', null, row, 'Mutasi kas unit ' + form.id_unit);
    return 'Sukses tersimpan';
  },

  async getSaldoKasUnit(idUnit) {
    const { data, error } = await sb.from('kas_mutasi').select('arah,nominal,status').eq('id_unit', idUnit);
    if (error) return 0;
    return (data||[]).filter(r => (r.status||'aktif') !== 'dibatalkan').reduce((a,r)=>a+(r.arah==='keluar'?-Number(r.nominal||0):Number(r.nominal||0)),0);
  },

  async tambahPenarikanNasabahUnit(form) {
    const kunci = await cekPeriodeTerkunci(form.tgl);
    if (kunci) return pesanPeriodeTerkunci(kunci);
    const saldoKas = await this.getSaldoKasUnit(form.id_unit);
    if (Number(form.nominal) > saldoKas) return 'Gagal: Saldo kas unit tidak mencukupi.';
    const trxId = genId('TRX');
    const trx = { id: trxId, id_unit: form.id_unit, level:'nasabah_ke_unit', id_nasabah:form.id_nasabah,
      nama:form.nama, tgl:form.tgl, jenis:'Penarikan Tunai', berat:0, harga_satuan:0, total:-Math.abs(Number(form.nominal)||0),
      metode:form.metode||'Tunai', no_dokumen:form.no_bukti||null, status:'aktif', created_by:form.oleh||getPetugasSesi() };
    const { error: trxErr } = await sb.from('transaksi').insert(trx);
    if (trxErr) return 'Gagal: ' + trxErr.message;
    const kasRes = await this.tambahKasMutasi({ id_unit:form.id_unit,tanggal:form.tgl,arah:'keluar',kategori:'Pembayaran Nasabah',nominal:Math.abs(Number(form.nominal)||0),metode:form.metode,no_bukti:form.no_bukti,keterangan:'Penarikan saldo '+form.nama,referensi_id:trxId,oleh:trx.created_by });
    if (!String(kasRes).includes('Sukses')) {
      await sb.from('transaksi').delete().eq('id',trxId);
      return kasRes;
    }
    logAudit('transaksi', trxId, 'insert', null, trx, 'Penarikan saldo nasabah oleh '+trx.created_by);
    return 'Sukses tersimpan';
  },

  async tambahRekonsiliasiUnit(form) {
    const id = genId('REK');
    const row = { id, id_unit:form.id_unit, tanggal:form.tanggal, sumber:form.sumber||'Kas/Bank BSU',
      saldo_sistem:Number(form.saldo_sistem)||0, saldo_fisik:Number(form.saldo_fisik)||0,
      keterangan:form.keterangan||null, diperiksa_oleh:form.diperiksa_oleh||getPetugasSesi() };
    const { error } = await sb.from('rekonsiliasi_kas').insert(row);
    if (error) return 'Gagal: '+error.message;
    logAudit('rekonsiliasi_kas',id,'insert',null,row,'Rekonsiliasi unit '+form.id_unit);
    return 'Sukses tersimpan';
  },

  async batalkanTransaksiUnit({ id, alasan, oleh }) {
    const { data: lama } = await sb.from('transaksi').select('*').eq('id', id).maybeSingle();
    if (!lama) return 'Gagal: Transaksi tidak ditemukan.';
    const kunci = await cekPeriodeTerkunci(lama.tgl); if (kunci) return pesanPeriodeTerkunci(kunci);
    const dataBaru = { status:'dibatalkan', alasan_koreksi:alasan, dibatalkan_oleh:oleh||getPetugasSesi(), dibatalkan_pada:new Date().toISOString() };
    const { error } = await sb.from('transaksi').update(dataBaru).eq('id', id);
    if (error) return 'Gagal: '+error.message;
    if (lama.jenis === 'Penarikan Tunai') {
      await sb.from('kas_mutasi').update({status:'dibatalkan'}).eq('referensi_id',id);
    }
    logAudit('transaksi',id,'update',lama,{...lama,...dataBaru},'Pembatalan: '+alasan+' — oleh '+dataBaru.dibatalkan_oleh);
    return 'Sukses: transaksi dibatalkan tanpa menghapus jejak.';
  },

  async getAuditLogUnit(idUnit) {
    const { data, error } = await sb.from('audit_log').select('*').order('waktu',{ascending:false}).limit(1000);
    if (error) return [];
    return (data||[]).filter(a=>JSON.stringify([a.record_id,a.data_lama,a.data_baru,a.keterangan]).includes(String(idUnit)));
  },

  // ================== INVENTARIS & OPERASIONAL ==================
  async getInventarisBundle() {
    const [{ data: alat }, { data: biaya }, { data: pemeliharaan }] = await Promise.all([
      sb.from('alat').select('*').order('id'),
      sb.from('biaya_operasional').select('*'),
      sb.from('pemeliharaan_investasi').select('*')
    ]);
    return { alat: alat || [], biaya: biaya || [], pemeliharaan: pemeliharaan || [] };
  },

  async tambahAlat(form) {
    const { data, error } = await sb.from('alat').insert(form).select().maybeSingle();
    if (error) return 'Gagal: ' + error.message;
    logAudit('alat', data ? data.id : (form.kode || form.nama), 'insert', null, data || form);
    return 'Sukses tersimpan';
  },
  async deleteAlat(id) {
    const { data: lama } = await sb.from('alat').select('*').eq('id', id).maybeSingle();
    const { error } = await sb.from('alat').delete().eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('alat', id, 'delete', lama || null, null);
    return 'Sukses dihapus';
  },

  async tambahBiayaOperasional(form) {
    const id = 'BOP-' + genId();
    const row = { id, ...form };
    const { error } = await sb.from('biaya_operasional').insert(row);
    if (error) return 'Gagal: ' + error.message;
    logAudit('biaya_operasional', id, 'insert', null, row);
    return 'Sukses tersimpan';
  },
  async deleteBiayaOperasional(id) {
    const { data: lama } = await sb.from('biaya_operasional').select('*').eq('id', id).maybeSingle();
    const { error } = await sb.from('biaya_operasional').delete().eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('biaya_operasional', id, 'delete', lama || null, null);
    return 'Sukses dihapus';
  },

  async tambahPemeliharaan(form) {
    const id = 'PML-' + genId();
    const row = { id, ...form };
    const { error } = await sb.from('pemeliharaan_investasi').insert(row);
    if (error) return 'Gagal: ' + error.message;
    logAudit('pemeliharaan_investasi', id, 'insert', null, row);
    return 'Sukses tersimpan';
  },
  async deletePemeliharaan(id) {
    const { data: lama } = await sb.from('pemeliharaan_investasi').select('*').eq('id', id).maybeSingle();
    const { error } = await sb.from('pemeliharaan_investasi').delete().eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('pemeliharaan_investasi', id, 'delete', lama || null, null);
    return 'Sukses dihapus';
  },

  // ================== PENJUALAN KE OFF-TAKER ==================
  // Sebelumnya data ini tersimpan di localStorage browser (tidak tersinkron antar
  // perangkat & rawan hilang). Sekarang sepenuhnya memakai tabel `penjualan` di
  // Supabase, mengikuti pola CRUD + cek periode terkunci + audit log yang sama
  // seperti modul transaksi lainnya.
  async getPenjualanBundle() {
    const { data, error } = await sb.from('penjualan').select('*').order('tanggal', { ascending: false });
    if (error) return [];
    return data || [];
  },
  async tambahPenjualan(form) {
    const kunci = await cekPeriodeTerkunci(form.tanggal);
    if (kunci) return pesanPeriodeTerkunci(kunci);

    const id = form.id || genId('PJL');
    const row = { id, tanggal: form.tanggal, pembeli: form.pembeli, material: form.material, berat: form.berat, harga: form.harga, total: form.total };
    const { error } = await sb.from('penjualan').insert(row);
    if (error) return 'Gagal: ' + error.message;
    logAudit('penjualan', id, 'insert', null, row);
    return 'Sukses tersimpan';
  },
  async updatePenjualan(form) {
    const { id, ...rest } = form;
    const { data: lama } = await sb.from('penjualan').select('*').eq('id', id).maybeSingle();
    if (!lama) return 'Gagal: Data penjualan tidak ditemukan.';

    const kunciLama = await cekPeriodeTerkunci(lama.tanggal);
    if (kunciLama) return pesanPeriodeTerkunci(kunciLama);
    const kunciBaru = await cekPeriodeTerkunci(rest.tanggal);
    if (kunciBaru) return pesanPeriodeTerkunci(kunciBaru);

    const { error } = await sb.from('penjualan').update(rest).eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('penjualan', id, 'update', lama, { ...lama, ...rest });
    return 'Sukses diperbarui';
  },
  async deletePenjualan(id) {
    const { data: lama } = await sb.from('penjualan').select('*').eq('id', id).maybeSingle();
    if (!lama) return 'Gagal: Data penjualan tidak ditemukan.';

    const kunci = await cekPeriodeTerkunci(lama.tanggal);
    if (kunci) return pesanPeriodeTerkunci(kunci);

    const { error } = await sb.from('penjualan').delete().eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('penjualan', id, 'delete', lama, null);
    return 'Sukses dihapus';
  },
  // Migrasi satu-kali: memindahkan seluruh riwayat penjualan yang masih tersimpan
  // di localStorage (dari versi aplikasi sebelumnya) ke tabel `penjualan` Supabase.
  // Sengaja MELEWATI pengecekan periode-terkunci (data historis lama boleh saja
  // berasal dari bulan yang sekarang sudah tutup buku), dan memakai upsert supaya
  // aman dijalankan berulang kali (id yang sama tidak akan terduplikasi).
  async importPenjualanBatch(rows) {
    if (!rows || !rows.length) return { ok: true, jumlah: 0 };
    const cleaned = rows.map(r => ({
      id: r.id ? String(r.id) : genId('PJL'),
      tanggal: r.tanggal, pembeli: r.pembeli || null, material: r.material || null,
      berat: parseFloat(r.berat) || 0, harga: parseFloat(r.harga) || 0, total: parseFloat(r.total) || 0
    }));
    const { error } = await sb.from('penjualan').upsert(cleaned, { onConflict: 'id' });
    if (error) return { ok: false, error: error.message };
    logAudit('penjualan', 'MIGRASI-' + cleaned.length + '-BARIS', 'insert', null, { jumlah: cleaned.length }, 'Migrasi batch dari localStorage perangkat ke Supabase oleh ' + getPetugasSesi());
    return { ok: true, jumlah: cleaned.length };
  },

  // ================== TUTUP BUKU / KONTROL PERIODE ==================
  async getPeriodeList() {
    const { data, error } = await sb.from('periode_tutup_buku').select('*').order('tahun', { ascending: false }).order('bulan', { ascending: false });
    if (error) return [];
    return data || [];
  },
  async getStatusPeriode(tahun, bulan) {
    const { data } = await sb.from('periode_tutup_buku').select('*').eq('tahun', tahun).eq('bulan', bulan).maybeSingle();
    return data || { tahun, bulan, status: 'terbuka' };
  },
  async tutupBuku({ tahun, bulan, oleh, catatan }) {
    const { data: existing } = await sb.from('periode_tutup_buku').select('*').eq('tahun', tahun).eq('bulan', bulan).maybeSingle();
    const dataBaru = { tahun, bulan, status: 'tertutup', ditutup_oleh: oleh || getPetugasSesi(), ditutup_pada: new Date().toISOString(), catatan: catatan || null };
    let error;
    if (existing) {
      ({ error } = await sb.from('periode_tutup_buku').update(dataBaru).eq('id', existing.id));
    } else {
      ({ error } = await sb.from('periode_tutup_buku').insert(dataBaru));
    }
    if (error) return 'Gagal: ' + error.message;
    logAudit('periode_tutup_buku', tahun + '-' + String(bulan).padStart(2, '0'), existing ? 'update' : 'insert', existing || null, dataBaru, 'Tutup buku oleh ' + dataBaru.ditutup_oleh);
    return 'Sukses: Periode ' + String(bulan).padStart(2, '0') + '/' + tahun + ' telah DITUTUP.';
  },
  async bukaKembaliBuku({ tahun, bulan, oleh, catatan }) {
    const { data: existing } = await sb.from('periode_tutup_buku').select('*').eq('tahun', tahun).eq('bulan', bulan).maybeSingle();
    if (!existing || existing.status !== 'tertutup') return 'Gagal: Periode ini memang belum tertutup.';
    const dataBaru = { status: 'terbuka', dibuka_oleh: oleh || getPetugasSesi(), dibuka_pada: new Date().toISOString(), catatan: catatan || existing.catatan };
    const { error } = await sb.from('periode_tutup_buku').update(dataBaru).eq('id', existing.id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('periode_tutup_buku', tahun + '-' + String(bulan).padStart(2, '0'), 'update', existing, { ...existing, ...dataBaru }, 'Buka kembali oleh ' + dataBaru.dibuka_oleh);
    return 'Sukses: Periode ' + String(bulan).padStart(2, '0') + '/' + tahun + ' dibuka kembali. Segera tutup lagi setelah selesai koreksi.';
  },

  // ================== AUDIT LOG (VIEWER) ==================
  async getAuditLog({ tabel, mulai, akhir, limit } = {}) {
    let q = sb.from('audit_log').select('*').order('waktu', { ascending: false }).limit(limit || 300);
    if (tabel) q = q.eq('tabel', tabel);
    if (mulai) q = q.gte('waktu', mulai);
    if (akhir) q = q.lte('waktu', akhir);
    const { data, error } = await q;
    if (error) return [];
    return data || [];
  },

  // ================== NERACA (POS MANUAL) ==================
  async getNeracaPosList() {
    const { data, error } = await sb.from('neraca_pos').select('*').order('kategori').order('nama_pos');
    if (error) return [];
    return data || [];
  },
  async tambahPosNeraca(form) {
    const id = 'NRC-' + genId();
    const row = { id, ...form };
    const { error } = await sb.from('neraca_pos').insert(row);
    if (error) return 'Gagal: ' + error.message;
    logAudit('neraca_pos', id, 'insert', null, row);
    return 'Sukses tersimpan';
  },
  async updatePosNeraca(form) {
    const { id, ...rest } = form;
    const { data: lama } = await sb.from('neraca_pos').select('*').eq('id', id).maybeSingle();
    const { error } = await sb.from('neraca_pos').update(rest).eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('neraca_pos', id, 'update', lama, { ...lama, ...rest });
    return 'Sukses diperbarui';
  },
  async deletePosNeraca(id) {
    const { data: lama } = await sb.from('neraca_pos').select('*').eq('id', id).maybeSingle();
    const { error } = await sb.from('neraca_pos').delete().eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('neraca_pos', id, 'delete', lama || null, null);
    return 'Sukses dihapus';
  },

  // ================== REKONSILIASI KAS / BANK ==================
  async getRekonsiliasiList() {
    const { data, error } = await sb.from('rekonsiliasi_kas').select('*').order('tanggal', { ascending: false });
    if (error) return [];
    return data || [];
  },
  async tambahRekonsiliasi(form) {
    const id = 'REK-' + genId();
    const row = {
      id, tanggal: form.tanggal, sumber: form.sumber || 'Kas Tunai',
      saldo_sistem: form.saldo_sistem || 0, saldo_fisik: form.saldo_fisik || 0,
      keterangan: form.keterangan || null, diperiksa_oleh: form.diperiksa_oleh || getPetugasSesi()
    };
    const { error } = await sb.from('rekonsiliasi_kas').insert(row);
    if (error) return 'Gagal: ' + error.message;
    logAudit('rekonsiliasi_kas', id, 'insert', null, row);
    return 'Sukses tersimpan';
  },
  async deleteRekonsiliasi(id) {
    const { data: lama } = await sb.from('rekonsiliasi_kas').select('*').eq('id', id).maybeSingle();
    const { error } = await sb.from('rekonsiliasi_kas').delete().eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('rekonsiliasi_kas', id, 'delete', lama || null, null);
    return 'Sukses dihapus';
  },

  // ================== BACKUP DATA LENGKAP ==================
  // Mengekspor seluruh tabel Supabase sebagai satu objek JSON, untuk
  // diunduh sebagai file cadangan (dilakukan di sisi client, lihat
  // fungsi unduhBackupLengkap() di induk.html). Kolom password pada
  // tabel admin & bsu SENGAJA disamarkan supaya file backup aman untuk
  // disimpan/dibagikan tanpa membocorkan kredensial login.
  async exportFullBackup() {
    const [
      { data: admin }, { data: bsu }, { data: nasabah }, { data: kategori },
      { data: transaksi }, { data: penjualan }, { data: bantuan_hibah }, { data: pembinaan_bsu },
      { data: kejadian_darurat }, { data: alat }, { data: biaya_operasional },
      { data: pemeliharaan_investasi }, { data: periode_tutup_buku },
      { data: neraca_pos }, { data: rekonsiliasi_kas }, { data: stock_opname },
      { data: kas_mutasi }, { data: audit_log }
    ] = await Promise.all([
      sb.from('admin').select('id, username'),
      sb.from('bsu').select('*'),
      sb.from('nasabah').select('*'),
      sb.from('kategori').select('*'),
      sb.from('transaksi').select('*'),
      sb.from('penjualan').select('*'),
      sb.from('bantuan_hibah').select('*'),
      sb.from('pembinaan_bsu').select('*'),
      sb.from('kejadian_darurat').select('*'),
      sb.from('alat').select('*'),
      sb.from('biaya_operasional').select('*'),
      sb.from('pemeliharaan_investasi').select('*'),
      sb.from('periode_tutup_buku').select('*'),
      sb.from('neraca_pos').select('*'),
      sb.from('rekonsiliasi_kas').select('*'),
      sb.from('stock_opname').select('*'),
      sb.from('kas_mutasi').select('*'),
      sb.from('audit_log').select('*').order('waktu', { ascending: false }).limit(5000)
    ]);
    const stripPassBsu = (bsu || []).map(({ password, ...r }) => r);
    return {
      meta: { diekspor_pada: new Date().toISOString(), sumber: 'Sistem Bank Sampah Induk & Unit (Supabase)', catatan: 'Kolom password pada admin & bsu disamarkan demi keamanan.' },
      admin: admin || [], bsu: stripPassBsu, nasabah: nasabah || [], kategori: kategori || [],
      transaksi: transaksi || [], penjualan: penjualan || [], bantuan_hibah: bantuan_hibah || [], pembinaan_bsu: pembinaan_bsu || [],
      kejadian_darurat: kejadian_darurat || [], alat: alat || [], biaya_operasional: biaya_operasional || [],
      pemeliharaan_investasi: pemeliharaan_investasi || [], periode_tutup_buku: periode_tutup_buku || [],
      neraca_pos: neraca_pos || [], rekonsiliasi_kas: rekonsiliasi_kas || [],
      stock_opname: stock_opname || [], kas_mutasi: kas_mutasi || [], audit_log: audit_log || []
    };
  },

  // ================== RESTORE (MODE GABUNG/TIMPA — DISARANKAN) ==================
  // Upsert per baris berdasarkan id: menimpa baris yang ID-nya sama, mengembalikan
  // baris yang sebelumnya terhapus. TIDAK PERNAH menghapus data yang sudah ada di
  // server tapi tidak ada di file backup. Tabel `admin` dan `audit_log` sengaja
  // dilewati (lihat penjelasan di util RESTORE di atas file ini).
  async restoreMerge(data) {
    const laporan = {};
    laporan.bsu = await restoreBsuAman(data.bsu);
    for (const tabel of TABEL_RESTORE_SEDERHANA) {
      laporan[tabel] = await upsertTabelSederhana(tabel, data[tabel]);
    }
    laporan.periode_tutup_buku = await restorePeriodeTutupBuku(data.periode_tutup_buku);
    try { await sb.rpc('fix_kategori_sequence'); } catch (e) { console.warn('Gagal menyesuaikan sequence kategori:', e); }
    logAudit('SYSTEM', 'RESTORE-GABUNG-' + Date.now(), 'update', null, { ringkasan: laporan }, 'Restore (gabung/timpa) dari file backup oleh ' + getPetugasSesi());
    return laporan;
  },

  // ================== RESTORE (MODE GANTI TOTAL — BERISIKO TINGGI) ==================
  // Menghapus SEMUA baris di setiap tabel relevan (urutan memperhatikan foreign
  // key), lalu insert ulang persis isi backup. Dipakai untuk skenario pemulihan
  // bencana total. UI pemanggil WAJIB sudah meminta konfirmasi eksplisit sebelum
  // memanggil fungsi ini -- fungsi ini sendiri tidak meminta konfirmasi apa pun.
  async restoreFullReplace(data) {
    const laporan = {};

    // 1) Hapus semua data lama (anak dulu, induk/bsu paling akhir)
    for (const tabel of URUTAN_HAPUS_TOTAL) {
      const hasil = await hapusSemuaBaris(tabel);
      if (!hasil.ok) { laporan[tabel] = hasil; return laporan; } // hentikan lebih awal kalau hapus gagal, supaya tidak insert ke kondisi tak terduga
    }

    // 2) Insert ulang persis isi backup (induk dulu: bsu butuh password sementara
    //    karena tabel baru saja dikosongkan total -> SEMUA baris bsu dianggap baru)
    laporan.bsu = await restoreBsuAman(data.bsu);
    for (const tabel of URUTAN_INSERT_TOTAL) {
      if (tabel === 'bsu') continue; // sudah ditangani di atas
      laporan[tabel] = await insertTabelSederhana(tabel, data[tabel]);
    }
    laporan.periode_tutup_buku = await restorePeriodeTutupBuku(data.periode_tutup_buku);

    // Perbaiki counter auto-increment tabel kategori (lihat catatan di fix_kategori_sequence
    // pada schema_upgrade.sql) supaya penambahan kategori baru setelah ini tidak berisiko
    // bentrok id dengan data yang baru saja di-restore.
    try { await sb.rpc('fix_kategori_sequence'); } catch (e) { console.warn('Gagal menyesuaikan sequence kategori (fungsi fix_kategori_sequence mungkin belum dibuat, jalankan schema_upgrade.sql terbaru):', e); }

    logAudit('SYSTEM', 'RESTORE-TOTAL-' + Date.now(), 'delete', null, { ringkasan: laporan }, 'RESTORE TOTAL (hapus semua & ganti dari backup) oleh ' + getPetugasSesi());
    return laporan;
  },

  // ================== CEK SALDO MANDIRI (HALAMAN PUBLIK cek-saldo.html) ==================
  // Dipakai oleh nasabah lewat scan QR, TANPA login. Sengaja hanya mengembalikan
  // field yang aman ditampilkan ke publik (bukan seluruh baris tabel bsu/nasabah).

  // Daftar nama unit saja (untuk dropdown pilih unit di halaman cek saldo, kalau
  // nasabah membuka halamannya langsung tanpa scan QR / parameter URL kosong).
  async getDaftarUnitPublik() {
    const { data, error } = await sb.from('bsu').select('id, nama').order('nama');
    if (error) return [];
    return data || [];
  },

  // Info dasar unit (nama & lokasi saja) untuk ditampilkan di halaman cek saldo.
  async getInfoUnitPublik(idUnit) {
    const { data, error } = await sb.from('bsu').select('id, nama, desa, kecamatan').eq('id', idUnit).maybeSingle();
    if (error || !data) return null;
    return data;
  },

  // Nama nasabah saja (untuk layar konfirmasi "Halo, [nama], ini Anda?" pada QR
  // pribadi) -- TIDAK mengembalikan HP atau saldo, supaya id_nasabah yang mungkin
  // difoto/disebar dari QR tidak otomatis membocorkan data finansialnya.
  async getInfoNasabahRingkas(idUnit, idNasabah) {
    const { data, error } = await sb.from('nasabah').select('id, nama').eq('id_unit', idUnit).eq('id', idNasabah).maybeSingle();
    if (error || !data) return null;
    return data;
  },

  // Pengecekan saldo sesungguhnya -- WAJIB nomor HP cocok persis dengan yang
  // terdaftar (baik mode QR Unit maupun QR pribadi per nasabah). idNasabah bersifat
  // opsional: kalau diisi (mode QR pribadi), pencarian dipersempit ke nasabah itu
  // saja; kalau kosong (mode QR Unit), semua nasabah di unit tsb dengan HP yang
  // cocok akan dikembalikan (biasanya 1, tapi bisa lebih dari 1 kalau ada anggota
  // keluarga terdaftar dengan HP yang sama).
  async cekSaldoNasabahPublik({ idUnit, nomorHp, idNasabah }) {
    if (!idUnit || !nomorHp) return { ok: false, error: 'Data tidak lengkap.' };
    const hpBersih = String(nomorHp).trim();
    if (!hpBersih) return { ok: false, error: 'Nomor HP wajib diisi.' };

    let q = sb.from('nasabah').select('*').eq('id_unit', idUnit).eq('hp', hpBersih);
    if (idNasabah) q = q.eq('id', idNasabah);
    const { data: nasabahList, error } = await q;
    if (error) return { ok: false, error: error.message };
    if (!nasabahList || !nasabahList.length) {
      return { ok: false, error: 'Nomor HP tidak cocok dengan data yang terdaftar. Pastikan nomor HP sesuai yang didaftarkan di Bank Sampah Unit (hubungi petugas kalau nomor HP Anda berubah).' };
    }

    const unitInfo = await this.getInfoUnitPublik(idUnit);

    // Catatan: transaksi dikaitkan ke nasabah lewat kecocokan NAMA (bukan id nasabah),
    // konsisten dengan cara kerja unit.html yang sudah ada. Kalau ada 2 nasabah dengan
    // nama PERSIS SAMA di satu unit, riwayat keduanya akan tergabung -- ini keterbatasan
    // data model lama, bukan sesuatu yang baru dari fitur ini.
    const hasil = [];
    for (const n of nasabahList) {
      let { data: trx } = await sb.from('transaksi').select('id, id_nasabah, tgl, jenis, berat, harga_satuan, total, status, created_at')
        .eq('id_unit', idUnit).eq('level', 'nasabah_ke_unit').eq('id_nasabah', n.id)
        .order('created_at', { ascending: false });
      // Fallback hanya untuk transaksi lama yang belum memiliki id_nasabah.
      if (!trx || !trx.length) {
        const lama = await sb.from('transaksi').select('id, id_nasabah, tgl, jenis, berat, harga_satuan, total, status, created_at')
          .eq('id_unit', idUnit).eq('level', 'nasabah_ke_unit').eq('nama', n.nama)
          .order('created_at', { ascending: false });
        trx = lama.data || [];
      }
      const rows = (trx || []).filter(t => (t.status || 'aktif') !== 'dibatalkan');
      const saldo = rows.reduce((a, t) => a + (parseFloat(t.total) || 0), 0);
      const totalBeratSetor = rows.filter(t => (parseFloat(t.total) || 0) >= 0).reduce((a, t) => a + (parseFloat(t.berat) || 0), 0);
      hasil.push({ nasabah: { id: n.id, nama: n.nama }, saldo, totalBeratSetor, riwayat: rows });
    }
    return { ok: true, unit: unitInfo, data: hasil };
  }
};
