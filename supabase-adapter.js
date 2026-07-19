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

  // ---- BSU (unit) ----
  async tambahUnit(form) {
    const id = 'BSU-' + genId();
    const row = { id, ...form };
    const { error } = await sb.from('bsu').insert(row);
    if (error) return 'Gagal: ' + error.message;
    const { password, ...rowTanpaPassword } = row;
    logAudit('bsu', id, 'insert', null, rowTanpaPassword);
    return 'Sukses mendaftarkan BSU';
  },
  async updateUnit(form) {
    const { id, ...rest } = form;
    const { data: lama } = await sb.from('bsu').select('*').eq('id', id).maybeSingle();
    const { error } = await sb.from('bsu').update(rest).eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    const stripPass = (o) => { if (!o) return o; const { password, ...r } = o; return r; };
    logAudit('bsu', id, 'update', stripPass(lama), stripPass({ ...lama, ...rest }));
    return 'Sukses diperbarui';
  },
  async deleteUnit(id) {
    const { data: lama } = await sb.from('bsu').select('*').eq('id', id).maybeSingle();
    const { error } = await sb.from('bsu').delete().eq('id', id);
    if (error) return 'Gagal: ' + error.message;
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
    const [{ data: nasabahList }, { data: transaksi }, { data: transaksiKeluar }, { data: kategori }, { data: unitRow }] = await Promise.all([
      sb.from('nasabah').select('*').eq('id_unit', idUnit),
      sb.from('transaksi').select('*').eq('id_unit', idUnit).eq('level', 'nasabah_ke_unit'),
      sb.from('transaksi').select('*').eq('id_unit', idUnit).eq('level', 'unit_ke_induk'),
      sb.from('kategori').select('*'),
      sb.from('bsu').select('*').eq('id', idUnit)
    ]);
    return { nasabah: nasabahList || [], transaksi: transaksi || [], transaksiKeluar: transaksiKeluar || [], kategori: kategori || [], unit: unitRow || [] };
  },

  async tambahNasabah({ id, id_unit, nama, hp }) {
    const idFix = id || genId('NSB');
    const row = { id: idFix, id_unit, nama, hp };
    const { error } = await sb.from('nasabah').insert(row);
    if (error) return 'Gagal: ' + error.message;
    logAudit('nasabah', idFix, 'insert', null, row);
    return 'Sukses';
  },
  async editNasabah({ id, nama, hp }) {
    const { data: lama } = await sb.from('nasabah').select('*').eq('id', id).maybeSingle();
    const { error } = await sb.from('nasabah').update({ nama, hp }).eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('nasabah', id, 'update', lama, { ...lama, nama, hp });
    return 'Sukses diperbarui';
  },
  async deleteNasabah(id) {
    const { data: lama } = await sb.from('nasabah').select('*').eq('id', id).maybeSingle();
    const { error } = await sb.from('nasabah').delete().eq('id', id);
    if (error) return 'Gagal: ' + error.message;
    logAudit('nasabah', id, 'delete', lama || null, null);
    return 'Sukses dihapus';
  },

  async tambahTransaksiUnit({ id, id_unit, tgl, nama, jenis, berat, total, kelompok_id, oleh }) {
    const kunci = await cekPeriodeTerkunci(tgl);
    if (kunci) return pesanPeriodeTerkunci(kunci);

    const idFix = id != null ? String(id) : genId('TRX');
    const row = { id: idFix, id_unit, level: 'nasabah_ke_unit', nama, tgl, jenis, berat, total, kelompok_id: kelompok_id || null };
    const { error } = await sb.from('transaksi').insert(row);
    if (error) return 'Gagal: ' + error.message;
    logAudit('transaksi', idFix, 'insert', null, row, oleh ? ('dicatat oleh ' + oleh) : null);
    return 'Sukses';
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
      { data: neraca_pos }, { data: rekonsiliasi_kas }, { data: audit_log }
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
      sb.from('audit_log').select('*').order('waktu', { ascending: false }).limit(5000)
    ]);
    const stripPassBsu = (bsu || []).map(({ password, ...r }) => r);
    return {
      meta: { diekspor_pada: new Date().toISOString(), sumber: 'Sistem Bank Sampah Induk & Unit (Supabase)', catatan: 'Kolom password pada admin & bsu disamarkan demi keamanan.' },
      admin: admin || [], bsu: stripPassBsu, nasabah: nasabah || [], kategori: kategori || [],
      transaksi: transaksi || [], penjualan: penjualan || [], bantuan_hibah: bantuan_hibah || [], pembinaan_bsu: pembinaan_bsu || [],
      kejadian_darurat: kejadian_darurat || [], alat: alat || [], biaya_operasional: biaya_operasional || [],
      pemeliharaan_investasi: pemeliharaan_investasi || [], periode_tutup_buku: periode_tutup_buku || [],
      neraca_pos: neraca_pos || [], rekonsiliasi_kas: rekonsiliasi_kas || [], audit_log: audit_log || []
    };
  }
};
