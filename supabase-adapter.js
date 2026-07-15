/**
 * ADAPTER SUPABASE
 * File ini menggantikan peran Google Apps Script (scriptURL / API_URL).
 * Diisi terlebih dahulu SUPABASE_URL & SUPABASE_ANON_KEY di bawah,
 * ambil dari Supabase Dashboard -> Project Settings -> API.
 */
const SUPABASE_URL = "https://biidkqkrfpdnqawdgxzs.supabase.co";       // contoh: https://xxxxxxxx.supabase.co
const SUPABASE_ANON_KEY = "sb_publishable_7GGbKw6wLd2nwdvV7XcesA_oU7hm2HD";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
    const { error } = await sb.from('bantuan_hibah').insert({ id: 'HBH-' + Date.now(), ...form });
    return error ? 'Gagal: ' + error.message : 'Sukses tersimpan';
  },
  async deleteBantuanHibah(id) {
    const { error } = await sb.from('bantuan_hibah').delete().eq('id', id);
    return error ? 'Gagal: ' + error.message : 'Sukses dihapus';
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
    const { error } = await sb.from('pembinaan_bsu').insert({ id: 'PBN-' + Date.now(), ...form });
    return error ? 'Gagal: ' + error.message : 'Sukses tersimpan';
  },
  async deletePembinaan(id) {
    const { error } = await sb.from('pembinaan_bsu').delete().eq('id', id);
    return error ? 'Gagal: ' + error.message : 'Sukses dihapus';
  },
  async tambahKejadianDarurat(form) {
    const { error } = await sb.from('kejadian_darurat').insert({ id: 'DRT-' + Date.now(), ...form });
    return error ? 'Gagal: ' + error.message : 'Sukses tersimpan';
  },
  async deleteKejadianDarurat(id) {
    const { error } = await sb.from('kejadian_darurat').delete().eq('id', id);
    return error ? 'Gagal: ' + error.message : 'Sukses dihapus';
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
  async tambahTransaksiInduk({ tgl, nama, id_unit, jenis, berat, total }) {
    const { error } = await sb.from('transaksi').insert({
      id: 'TRX-' + Date.now(), id_unit, level: 'unit_ke_induk', nama, tgl, jenis, berat, total
    });
    return error ? 'Gagal: ' + error.message : 'Sukses tersimpan';
  },

  // Tarik Tabungan BSU (BSI membayar tunai/transfer ke BSU, mengurangi saldo BSU di BSI)
  async tambahPenarikanBSU({ nomorTransaksi, tgl, nama, id_unit, jumlah, metode, status, disetujuiOleh }) {
    const { error } = await sb.from('transaksi').insert({
      id: nomorTransaksi, id_unit, level: 'unit_ke_induk', nama, tgl,
      jenis: 'Penarikan Tabungan', berat: 0, total: -Math.abs(jumlah),
      metode, status, disetujui_oleh: disetujuiOleh
    });
    return error ? 'Gagal: ' + error.message : 'Sukses tersimpan';
  },
  async updateTransaksi({ id, tgl, jenis, berat, total }) {
    const { error } = await sb.from('transaksi').update({ tgl, jenis, berat, total }).eq('id', id);
    return error ? 'Gagal: ' + error.message : 'Sukses diperbarui';
  },
  async deleteTransaksi(id) {
    const { error } = await sb.from('transaksi').delete().eq('id', id);
    return error ? 'Gagal: ' + error.message : 'Sukses dihapus';
  },

  // ---- BSU (unit) ----
  async tambahUnit(form) {
    const id = 'BSU-' + String(Date.now()).slice(-5);
    const { error } = await sb.from('bsu').insert({ id, ...form });
    return error ? 'Gagal: ' + error.message : 'Sukses mendaftarkan BSU';
  },
  async updateUnit(form) {
    const { id, ...rest } = form;
    const { error } = await sb.from('bsu').update(rest).eq('id', id);
    return error ? 'Gagal: ' + error.message : 'Sukses diperbarui';
  },
  async deleteUnit(id) {
    const { error } = await sb.from('bsu').delete().eq('id', id);
    return error ? 'Gagal: ' + error.message : 'Sukses dihapus';
  },

  // ---- Kategori ----
  async tambahKategori(form) {
    const { error } = await sb.from('kategori').insert({
      jenis_material: form.jenis_material, nama_kategori: form.nama_kategori, harga: form.harga
    });
    return error ? 'Gagal: ' + error.message : 'Sukses tersimpan';
  },
  async updateKategori(form) {
    const { error } = await sb.from('kategori').update({
      jenis_material: form.jenis_material, nama_kategori: form.nama_kategori, harga: form.harga
    }).eq('id', form.id);
    return error ? 'Gagal: ' + error.message : 'Sukses diperbarui';
  },
  async deleteKategori(id) {
    const { error } = await sb.from('kategori').delete().eq('id', id);
    return error ? 'Gagal: ' + error.message : 'Sukses dihapus';
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
    const { error } = await sb.from('nasabah').insert({ id, id_unit, nama, hp });
    return error ? 'Gagal: ' + error.message : 'Sukses';
  },
  async editNasabah({ id, nama, hp }) {
    const { error } = await sb.from('nasabah').update({ nama, hp }).eq('id', id);
    return error ? 'Gagal: ' + error.message : 'Sukses diperbarui';
  },
  async deleteNasabah(id) {
    const { error } = await sb.from('nasabah').delete().eq('id', id);
    return error ? 'Gagal: ' + error.message : 'Sukses dihapus';
  },

  async tambahTransaksiUnit({ id, id_unit, tgl, nama, jenis, berat, total, kelompok_id }) {
    const { error } = await sb.from('transaksi').insert({
      id: String(id), id_unit, level: 'nasabah_ke_unit', nama, tgl, jenis, berat, total, kelompok_id: kelompok_id || null
    });
    return error ? 'Gagal: ' + error.message : 'Sukses';
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
    const { error } = await sb.from('alat').insert(form);
    return error ? 'Gagal: ' + error.message : 'Sukses tersimpan';
  },
  async deleteAlat(id) {
    const { error } = await sb.from('alat').delete().eq('id', id);
    return error ? 'Gagal: ' + error.message : 'Sukses dihapus';
  },

  async tambahBiayaOperasional(form) {
    const { error } = await sb.from('biaya_operasional').insert({ id: 'BOP-' + Date.now(), ...form });
    return error ? 'Gagal: ' + error.message : 'Sukses tersimpan';
  },
  async deleteBiayaOperasional(id) {
    const { error } = await sb.from('biaya_operasional').delete().eq('id', id);
    return error ? 'Gagal: ' + error.message : 'Sukses dihapus';
  },

  async tambahPemeliharaan(form) {
    const { error } = await sb.from('pemeliharaan_investasi').insert({ id: 'PML-' + Date.now(), ...form });
    return error ? 'Gagal: ' + error.message : 'Sukses tersimpan';
  },
  async deletePemeliharaan(id) {
    const { error } = await sb.from('pemeliharaan_investasi').delete().eq('id', id);
    return error ? 'Gagal: ' + error.message : 'Sukses dihapus';
  }
};
