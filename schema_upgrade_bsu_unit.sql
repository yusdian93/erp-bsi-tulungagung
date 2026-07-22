-- =============================================================
-- UPGRADE MODUL BANK SAMPAH UNIT 2026
-- Jalankan sekali melalui Supabase SQL Editor sebelum memakai unit.html revisi.
-- Bersifat additive: tidak menghapus data lama.
-- =============================================================

BEGIN;

ALTER TABLE IF EXISTS public.nasabah
  ADD COLUMN IF NOT EXISTS alamat text,
  ADD COLUMN IF NOT EXISTS rt text,
  ADD COLUMN IF NOT EXISTS rw text,
  ADD COLUMN IF NOT EXISTS jenis_nasabah text DEFAULT 'Rumah Tangga',
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'aktif',
  ADD COLUMN IF NOT EXISTS izin_whatsapp boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS tanggal_gabung date DEFAULT CURRENT_DATE;

ALTER TABLE IF EXISTS public.transaksi
  ADD COLUMN IF NOT EXISTS id_nasabah text,
  ADD COLUMN IF NOT EXISTS harga_satuan numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS no_dokumen text,
  ADD COLUMN IF NOT EXISTS metode text,
  ADD COLUMN IF NOT EXISTS status_pembayaran text,
  ADD COLUMN IF NOT EXISTS biaya_angkut numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS catatan text,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'aktif',
  ADD COLUMN IF NOT EXISTS alasan_koreksi text,
  ADD COLUMN IF NOT EXISTS dibatalkan_oleh text,
  ADD COLUMN IF NOT EXISTS dibatalkan_pada timestamptz,
  ADD COLUMN IF NOT EXISTS created_by text;

-- Isi id_nasabah transaksi lama apabila nama dalam satu unit cocok tepat satu nasabah.
UPDATE public.transaksi t
SET id_nasabah = n.id
FROM public.nasabah n
WHERE t.id_nasabah IS NULL
  AND t.level = 'nasabah_ke_unit'
  AND t.id_unit = n.id_unit
  AND lower(trim(t.nama)) = lower(trim(n.nama))
  AND NOT EXISTS (
    SELECT 1 FROM public.nasabah n2
    WHERE n2.id_unit=n.id_unit AND lower(trim(n2.nama))=lower(trim(n.nama)) AND n2.id<>n.id
  );

UPDATE public.transaksi
SET harga_satuan = CASE WHEN COALESCE(berat,0) <> 0 THEN COALESCE(total,0)/berat ELSE 0 END
WHERE COALESCE(harga_satuan,0)=0;
UPDATE public.transaksi SET status='aktif' WHERE status IS NULL;

CREATE TABLE IF NOT EXISTS public.stock_opname (
  id text PRIMARY KEY,
  id_unit text NOT NULL,
  tanggal date NOT NULL,
  material text NOT NULL,
  stok_sistem numeric NOT NULL DEFAULT 0,
  stok_fisik numeric NOT NULL DEFAULT 0,
  selisih numeric NOT NULL DEFAULT 0,
  alasan text,
  diperiksa_oleh text,
  status text NOT NULL DEFAULT 'aktif',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.kas_mutasi (
  id text PRIMARY KEY,
  id_unit text NOT NULL,
  tanggal timestamptz NOT NULL DEFAULT now(),
  arah text NOT NULL CHECK (arah IN ('masuk','keluar')),
  kategori text NOT NULL,
  nominal numeric NOT NULL CHECK (nominal >= 0),
  metode text,
  no_bukti text,
  keterangan text,
  referensi_id text,
  oleh text,
  status text NOT NULL DEFAULT 'aktif',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS public.rekonsiliasi_kas ADD COLUMN IF NOT EXISTS id_unit text;

CREATE INDEX IF NOT EXISTS idx_transaksi_unit_nasabah ON public.transaksi(id_unit,id_nasabah);
CREATE INDEX IF NOT EXISTS idx_transaksi_unit_level_status ON public.transaksi(id_unit,level,status);
CREATE INDEX IF NOT EXISTS idx_stock_opname_unit_material ON public.stock_opname(id_unit,material,tanggal);
CREATE INDEX IF NOT EXISTS idx_kas_mutasi_unit_tanggal ON public.kas_mutasi(id_unit,tanggal);

-- Tabel baru mengikuti pola akses aplikasi lama. Apabila proyek telah memakai
-- Supabase Auth/RLS berbasis JWT, ganti kebijakan ini dengan policy per pengguna/unit.
ALTER TABLE public.stock_opname ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kas_mutasi ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "app_stock_opname_all" ON public.stock_opname;
CREATE POLICY "app_stock_opname_all" ON public.stock_opname FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "app_kas_mutasi_all" ON public.kas_mutasi;
CREATE POLICY "app_kas_mutasi_all" ON public.kas_mutasi FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

COMMIT;

-- PENTING:
-- Policy anon di atas dibuat kompatibel dengan arsitektur login kustom aplikasi saat ini.
-- Untuk produksi, keamanan terbaik adalah Supabase Auth + JWT id_unit + RLS per unit.
