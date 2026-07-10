-- =====================================================================
-- SKEMA DATABASE — Sistem Bank Sampah Induk & Unit
-- Pengganti Google Sheets, dijalankan di Supabase (PostgreSQL)
-- Cara pakai: buka Supabase Dashboard -> SQL Editor -> paste semua isi
-- file ini -> klik RUN.
-- =====================================================================

-- 1. AKUN ADMIN PUSAT (BSI)
-- Baris tunggal (id selalu 1) yang menyimpan kredensial login Admin Pusat.
create table if not exists admin (
  id smallint primary key default 1 check (id = 1),
  username text not null default 'admin',
  password text not null default 'admin123'
);
insert into admin (id, username, password)
  values (1, 'admin', 'admin123')
  on conflict (id) do nothing;

-- 2. BANK SAMPAH UNIT (BSU)
-- Dulu tersebar sebagai baris di sheet "Nasabah" (level BSI).
create table if not exists bsu (
  id text primary key,
  password text not null,
  nama text not null,
  ketua text,
  hp text,
  jumlah_pengurus int default 0,
  kecamatan text,
  desa text,
  alamat text,
  koordinat text,
  created_at timestamptz default now()
);

-- 3. NASABAH (warga yang menyetor ke satu BSU tertentu)
create table if not exists nasabah (
  id text primary key,
  id_unit text not null references bsu(id) on delete cascade,
  nama text not null,
  hp text,
  created_at timestamptz default now()
);

-- 4. KATEGORI / HARGA MATERIAL
create table if not exists kategori (
  id bigserial primary key,
  jenis_material text not null,
  nama_kategori text not null,
  harga numeric not null default 0
);

-- 5. TRANSAKSI (setoran & penarikan saldo)
-- Satu tabel dipakai untuk 2 level, dibedakan kolom "level":
--   'unit_ke_induk'   -> BSU menyetor ke BSI (nama = nama BSU)
--   'nasabah_ke_unit' -> Nasabah menyetor ke BSU (nama = nama nasabah)
create table if not exists transaksi (
  id text primary key,
  id_unit text references bsu(id) on delete cascade,
  level text not null check (level in ('unit_ke_induk','nasabah_ke_unit')),
  nama text not null,
  tgl text not null,
  jenis text,
  berat numeric default 0,
  total numeric default 0,
  created_at timestamptz default now()
);
create index if not exists idx_transaksi_unit on transaksi(id_unit);
create index if not exists idx_transaksi_level on transaksi(level);

-- 6. PENJUALAN KE OFF-TAKER (dulu hanya di localStorage — sekarang di server)
create table if not exists penjualan (
  id text primary key,
  tanggal text not null,
  pembeli text,
  material text,
  berat numeric default 0,
  harga numeric default 0,
  total numeric default 0,
  created_at timestamptz default now()
);

-- =====================================================================
-- ROW LEVEL SECURITY
-- Catatan keamanan: aplikasi ini murni frontend statis (tanpa server
-- sendiri), sama seperti kondisi sekarang dengan Google Apps Script yang
-- juga "exec" publik. Supaya app tetap bisa membaca/menulis lewat
-- anon key, RLS dibuka permisif. ini SETARA dengan level keamanan
-- Apps Script sebelumnya, TAPI idealnya ke depan login memakai
-- Supabase Auth + Edge Function agar password tidak lewat REST biasa.
-- =====================================================================
alter table admin enable row level security;
alter table bsu enable row level security;
alter table nasabah enable row level security;
alter table kategori enable row level security;
alter table transaksi enable row level security;
alter table penjualan enable row level security;

create policy "allow all admin" on admin for all using (true) with check (true);
create policy "allow all bsu" on bsu for all using (true) with check (true);
create policy "allow all nasabah" on nasabah for all using (true) with check (true);
create policy "allow all kategori" on kategori for all using (true) with check (true);
create policy "allow all transaksi" on transaksi for all using (true) with check (true);
create policy "allow all penjualan" on penjualan for all using (true) with check (true);
