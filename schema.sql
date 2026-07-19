-- =====================================================================
-- MIGRASI TAMBAHAN — Kontrol Periode, Audit Trail, Neraca, Rekonsiliasi
-- Jalankan file ini SETELAH schema.sql (skema awal) sudah ada di project
-- Supabase Anda. Aman dijalankan berkali-kali (idempotent).
-- Cara pakai: Supabase Dashboard -> SQL Editor -> paste semua isi file
-- ini -> klik RUN.
-- =====================================================================

-- 7. TUTUP BUKU / KONTROL PERIODE
-- Satu baris per (tahun, bulan). Jika status = 'tertutup', semua transaksi
-- (di tabel `transaksi`) dengan tanggal jatuh pada bulan tsb TIDAK BOLEH
-- ditambah/diubah/dihapus lagi lewat aplikasi (dicek di supabase-adapter.js).
create table if not exists periode_tutup_buku (
  id bigserial primary key,
  tahun int not null,
  bulan int not null check (bulan between 1 and 12),
  status text not null default 'terbuka' check (status in ('terbuka','tertutup')),
  ditutup_oleh text,
  ditutup_pada timestamptz,
  dibuka_oleh text,
  dibuka_pada timestamptz,
  catatan text,
  created_at timestamptz default now(),
  unique (tahun, bulan)
);

-- 8. AUDIT TRAIL / LOG AKTIVITAS
-- Mencatat setiap insert/update/delete pada data transaksional penting.
-- Sengaja dibuat APPEND-ONLY (lihat kebijakan RLS di bawah): tidak ada
-- policy update/delete untuk tabel ini, sehingga jejak audit tidak bisa
-- diubah/dihapus lewat aplikasi maupun langsung lewat anon key.
create table if not exists audit_log (
  id bigserial primary key,
  waktu timestamptz not null default now(),
  tabel text not null,
  record_id text not null,
  aksi text not null check (aksi in ('insert','update','delete')),
  oleh text,
  data_lama jsonb,
  data_baru jsonb,
  keterangan text
);
create index if not exists idx_audit_tabel on audit_log(tabel);
create index if not exists idx_audit_waktu on audit_log(waktu desc);
create index if not exists idx_audit_record on audit_log(record_id);

-- 9. POS NERACA MANUAL
-- Untuk item aset/kewajiban/modal yang tidak bisa dihitung otomatis dari
-- data transaksi yang sudah ada (misal: modal awal pendirian, aset tanah/
-- bangunan, utang bank, dsb). Pos yang bisa dihitung otomatis (kas & setara
-- kas, tabungan BSU yang belum ditarik, akumulasi investasi alat) TIDAK
-- perlu dimasukkan manual di sini — sudah otomatis ditampilkan di Neraca.
create table if not exists neraca_pos (
  id text primary key,
  kategori text not null check (kategori in ('aset_lancar','aset_tetap','kewajiban','modal')),
  nama_pos text not null,
  nilai numeric not null default 0,
  tanggal text,
  keterangan text,
  created_at timestamptz default now()
);

-- 10. REKONSILIASI KAS / BANK
-- Mencocokkan saldo menurut sistem (hasil hitung otomatis dari catatan
-- transaksi) dengan saldo fisik riil (hitung tunai / mutasi rekening koran)
-- pada tanggal tertentu.
create table if not exists rekonsiliasi_kas (
  id text primary key,
  tanggal text not null,
  sumber text not null default 'Kas Tunai',
  saldo_sistem numeric not null default 0,
  saldo_fisik numeric not null default 0,
  selisih numeric generated always as (saldo_fisik - saldo_sistem) stored,
  keterangan text,
  diperiksa_oleh text,
  created_at timestamptz default now()
);
create index if not exists idx_rekon_tanggal on rekonsiliasi_kas(tanggal);

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table periode_tutup_buku enable row level security;
alter table audit_log enable row level security;
alter table neraca_pos enable row level security;
alter table rekonsiliasi_kas enable row level security;

-- periode_tutup_buku & neraca_pos & rekonsiliasi_kas: perlu CRUD penuh dari
-- aplikasi (setara dengan tabel-tabel lain di schema.sql yang sudah ada).
drop policy if exists "allow all periode_tutup_buku" on periode_tutup_buku;
create policy "allow all periode_tutup_buku" on periode_tutup_buku for all using (true) with check (true);

drop policy if exists "allow all neraca_pos" on neraca_pos;
create policy "allow all neraca_pos" on neraca_pos for all using (true) with check (true);

drop policy if exists "allow all rekonsiliasi_kas" on rekonsiliasi_kas;
create policy "allow all rekonsiliasi_kas" on rekonsiliasi_kas for all using (true) with check (true);

-- audit_log: SENGAJA hanya dibuka untuk INSERT dan SELECT saja.
-- Tidak ada policy UPDATE/DELETE -> ditolak otomatis oleh RLS, sehingga
-- riwayat audit tidak bisa dirusak/dihapus oleh siapa pun lewat anon key.
drop policy if exists "audit_log insert" on audit_log;
create policy "audit_log insert" on audit_log for insert with check (true);
drop policy if exists "audit_log select" on audit_log;
create policy "audit_log select" on audit_log for select using (true);

-- =====================================================================
-- CATATAN KEAMANAN (tidak wajib dijalankan, sekadar pengingat):
-- Kebijakan "allow all" di atas mengikuti gaya permisif yang sama dengan
-- schema.sql aslinya (RLS terbuka lewat anon key). Ini SETARA dengan level
-- keamanan yang sudah ada sebelumnya di aplikasi, bukan pengurangan.
-- Untuk pengerasan keamanan menyeluruh (memisahkan akses admin pusat vs
-- BSU, menyembunyikan kolom password, dsb) diperlukan migrasi terpisah ke
-- Supabase Auth + Edge Function, di luar cakupan perubahan pencatatan ini.
-- =====================================================================
