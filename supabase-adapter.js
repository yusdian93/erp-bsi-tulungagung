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
  async getDataLogin() {
    const [{ data: admin }, { data: bsuList }] = await Promise.all([
      sb.from('admin').select('*').eq('id', 1).single(),
      sb.from('bsu').select('*')
    ]);
    return {
      admin_user: admin ? admin.username : 'admin',
      admin_pass: admin ? admin.password : 'admin123',
      nasabah: (bsuList || []) // dipakai index.html sebagai daftar BSU untuk cek login
    };
  },

  // ================== DATA UNTUK INDUK.HTML ==================
  async getBundleBSI() {
    const [{ data: kategori }, { data: bsuList }, { data: transaksi }] = await Promise.all([
      sb.from('kategori').select('*').order('id'),
      sb.from('bsu').select('*'),
      sb.from('transaksi').select('*').eq('level', 'unit_ke_induk').order('tgl', { ascending: false })
    ]);
    return { kategori: kategori || [], nasabah: bsuList || [], transaksi: transaksi || [] };
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

  // ---- Transaksi (level BSI: BSU -> BSI) ----
  async tambahTransaksiInduk({ tgl, nama, id_unit, jenis, berat, total }) {
    const { error } = await sb.from('transaksi').insert({
      id: 'TRX-' + Date.now(), id_unit, level: 'unit_ke_induk', nama, tgl, jenis, berat, total
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
    const [{ data: nasabahList }, { data: transaksi }, { data: kategori }, { data: unitRow }] = await Promise.all([
      sb.from('nasabah').select('*').eq('id_unit', idUnit),
      sb.from('transaksi').select('*').eq('id_unit', idUnit).eq('level', 'nasabah_ke_unit'),
      sb.from('kategori').select('*'),
      sb.from('bsu').select('*').eq('id', idUnit)
    ]);
    return { nasabah: nasabahList || [], transaksi: transaksi || [], kategori: kategori || [], unit: unitRow || [] };
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

  async tambahTransaksiUnit({ id, id_unit, tgl, nama, jenis, berat, total }) {
    const { error } = await sb.from('transaksi').insert({
      id: String(id), id_unit, level: 'nasabah_ke_unit', nama, tgl, jenis, berat, total
    });
    return error ? 'Gagal: ' + error.message : 'Sukses';
  }
};
