# Panduan Instalasi & Ringkasan Perubahan
Sistem Bank Sampah Induk & Unit — Update Pencatatan Keuangan

## Urutan instalasi (WAJIB berurutan)

1. **Jalankan `schema_upgrade.sql`** di Supabase Dashboard → SQL Editor → Run.
   Aman dijalankan berkali-kali. Menambah 4 tabel baru: `periode_tutup_buku`,
   `audit_log`, `neraca_pos`, `rekonsiliasi_kas`. Tabel `penjualan` TIDAK perlu
   dibuat di sini karena sudah ada sejak `schema.sql` awal.

2. **Ganti 3 file di hosting Anda** dengan versi baru (URL & anon key Supabase
   tetap sama, tidak perlu diubah):
   - `supabase-adapter.js`
   - `induk.html`
   - `unit.html`

   File `index.html` dan `schema.sql` (yang asli, bukan `schema_upgrade.sql`)
   **tidak perlu diganti**.

3. **Login sebagai Admin Pusat** → sistem akan meminta nama petugas sekali
   (untuk audit trail) → buka menu **Penjualan ke Off-taker**. Kalau ada data
   penjualan lama tersimpan di browser tsb, akan muncul panel kuning "Migrasi
   Data Penjualan Lama ke Server" — klik **Migrasikan Sekarang**. Lakukan ini
   di SETIAP komputer/browser yang pernah dipakai mencatat penjualan.

4. Setelah migrasi selesai, sebaiknya langsung coba **Backup Data** sekali
   untuk memastikan semuanya utuh, lalu simpan file JSON-nya di tempat aman.

## Ringkasan fitur baru

| Fitur | Lokasi menu | Inti perubahan |
|---|---|---|
| Tutup Buku Periode | Akuntansi & Kontrol → Tutup Buku Periode | Transaksi di bulan yang ditutup diblokir di level server (adapter.js), berlaku juga untuk Portal Unit. Bisa dibuka kembali dengan alasan (tercatat di audit). |
| Neraca | Akuntansi & Kontrol → Neraca | Kas & tabungan BSU dihitung otomatis; pos lain (modal, aset tanah, dll) input manual. Selalu balance lewat baris penyeimbang otomatis. |
| Audit Trail | Akuntansi & Kontrol → Audit Trail | Semua insert/update/delete pada transaksi, BSU, kategori, nasabah, penjualan, dll tercatat: siapa, kapan, nilai lama vs baru. Tabel `audit_log` append-only lewat RLS (tak bisa diubah/dihapus lewat aplikasi). |
| ID Anti-Tabrakan | (otomatis, semua form) | Semua `Date.now()` diganti `genId()` (UUID) di ketiga file. |
| Backup Data | Akuntansi & Kontrol → Backup & Restore Data | Unduh JSON seluruh tabel Supabase (password disamarkan). |
| Restore Data | Akuntansi & Kontrol → Backup & Restore Data | Unggah file backup JSON untuk memulihkan data. Dua mode: **Gabung/Timpa** (aman, tidak menghapus apa pun) dan **Ganti Total** (hapus semua lalu ganti persis dari backup — berisiko tinggi, perlu ketik konfirmasi). |
| Rekonsiliasi Kas/Bank | Akuntansi & Kontrol → Rekonsiliasi Kas/Bank | Bandingkan saldo sistem (otomatis) vs saldo fisik; selisih ditandai. |
| Migrasi Penjualan | Penjualan ke Off-taker (panel otomatis) | Data penjualan pindah dari localStorage ke tabel `penjualan` Supabase — kini tersinkron di semua perangkat, ikut tercakup di Neraca/Backup/Audit/Tutup Buku. |

## Identitas petugas (untuk audit trail)

- **Admin Pusat**: diminta sekali per sesi tab browser (muncul saat halaman
  dimuat). Terlihat & bisa diganti lewat tombol "👤 Petugas: ..." di pojok
  kanan atas.
- **Petugas BSU**: otomatis terisi `"BSU " + nama unit` tanpa perlu diminta,
  supaya tidak mengganggu alur kerja di lapangan.

## Batasan yang perlu diketahui

- Sistem ini mencatat transaksi **berbasis kas**, bukan akuntansi berpasangan
  (double-entry) penuh. Baris "Laba Ditahan/Selisih Penyeimbang" di Neraca
  dihitung otomatis supaya selalu balance — untuk pelaporan resmi/audit
  eksternal, tetap disarankan diverifikasi akuntan.
- Aset tetap di Neraca dihitung dari akumulasi biaya investasi alat (nilai
  buku kotor), **tanpa penyusutan**.
- Kebijakan RLS Supabase masih permisif ("allow all" lewat anon key),
  konsisten dengan `schema.sql` aslinya — ini bukan pengurangan keamanan,
  tapi juga belum pengerasan penuh. `audit_log` sengaja dibuat lebih ketat
  (insert+select saja) sebagai langkah pertama.
- Rekonsiliasi Kas/Bank saat ini mencakup satu akun kas gabungan (hasil
  hitung otomatis dari seluruh transaksi); belum memisahkan per rekening
  bank jika BSI punya lebih dari satu rekening/e-wallet secara terpisah di
  sistem (kolom "Sumber" saat ini bersifat catatan bebas, bukan akun
  terpisah dengan saldo masing-masing).

## Cara kerja Restore Data

Di menu **Akuntansi & Kontrol → Backup & Restore Data**, unggah file JSON hasil
backup, lalu pilih salah satu mode:

- **Mode Gabung/Timpa (disarankan)** — setiap baris di file backup menimpa
  baris dengan ID yang sama di server (kalau ada), atau dikembalikan kalau
  sebelumnya terhapus. **Tidak pernah menghapus** data yang sekarang ada di
  server tapi tidak ada di file backup. Ini mode yang tepat untuk kasus
  "ada data yang tidak sengaja terhapus, tolong kembalikan".

- **Mode Ganti Total (berisiko tinggi)** — menghapus SEMUA data saat ini lalu
  menggantinya persis dari file backup. Transaksi/data yang dibuat SETELAH
  tanggal backup akan hilang permanen. Perlu mengetik `HAPUS SEMUA DATA` untuk
  mengaktifkan tombolnya, plus dua kali konfirmasi. Hanya untuk skenario
  darurat (data server rusak/kacau total).

**Soal password BSU saat restore:** karena file backup tidak pernah menyimpan
password (demi keamanan), BSU yang di-restore sebagai data yang benar-benar
baru (sebelumnya terhapus total dari server, atau pada mode Ganti Total)
otomatis diberi password sementara acak. Setelah restore, sistem menampilkan
daftar BSU mana saja yang perlu di-reset passwordnya lewat menu **Data BSU →
Edit**, sebelum BSU tsb diberi tahu untuk login lagi. BSU yang datanya memang
masih ada di server (hanya ditimpa/disegarkan isinya) TIDAK kehilangan
passwordnya.

## Migrasi ke Project Supabase Baru (Pindah Server)

Dipakai kalau suatu saat mau ganti ke project Supabase baru (upgrade paket,
ganti akun institusi, dsb), tanpa input ulang data manual.

### A. Siapkan project baru
1. Buat project Supabase baru di [supabase.com](https://supabase.com/dashboard).
2. Di **SQL Editor** project baru: jalankan `schema.sql` (skema awal) dulu,
   baru `schema_upgrade.sql` (tambahan tutup buku/audit/neraca/rekonsiliasi).
3. **Deploy ulang 2 Edge Function**: `login` dan `update-admin`. Kode dua
   fungsi ini **tidak termasuk** dalam file-file yang pernah saya buatkan
   (Edge Function ditulis & dideploy terpisah lewat Supabase CLI/dashboard,
   di luar `schema.sql`/`supabase-adapter.js`). Anda perlu kode aslinya dari
   setup pertama dulu. Kalau sudah tidak ada salinannya, beri tahu saya —
   saya bisa bantu tuliskan ulang berdasarkan cara kerja yang sudah ada
   (cek username/password ke tabel `admin`/`bsu`, kembalikan role & id_unit).
4. Catat **Project URL** dan **anon key** baru dari *Project Settings → API*.

### B. Ambil backup dari project lama
5. Login ke aplikasi (masih tersambung ke project **lama**) → **Backup &
   Restore Data → Unduh Backup Lengkap (JSON)**. Simpan filenya.

### C. Arahkan aplikasi ke project baru
6. Buka `supabase-adapter.js`, ganti baris `SUPABASE_URL` dan
   `SUPABASE_ANON_KEY` dengan nilai dari project baru (langkah A.4).
7. Upload `supabase-adapter.js` versi baru ini ke hosting (`induk.html` dan
   `unit.html` tidak perlu diubah, keduanya tidak menyimpan URL/key).

### D. Restore data ke project baru
8. Login sebagai admin — karena project baru masih kosong/fresh, dipakai
   akun default dari `schema.sql`: username `admin`, password `admin123`.
9. **Backup & Restore Data → unggah file dari langkah B → pilih mode "Gabung/
   Timpa per Data"** (cukup mode ini saja; karena project baru kosong, hasil
   Gabung dan Ganti Total sama persis, tapi Gabung tidak perlu ketik
   konfirmasi "HAPUS SEMUA DATA" — lebih simpel untuk kasus ini).
10. **Ganti password Admin Pusat** dari default `admin123` lewat menu
    *Ubah ID & Kata Sandi* — WAJIB, jangan sampai terlewat.

### E. Soal password BSU (bagian yang perlu perhatian khusus)
Karena file backup **sengaja tidak pernah menyimpan password** (demi
keamanan — lihat penjelasan di bagian awal panduan ini), dan project baru
tadinya kosong total, **semua BSU akan dianggap data baru** dan otomatis
diberi password sementara acak saat restore. Setelah restore, sistem
menampilkan daftar BSU yang perlu direset. Dua opsi:

- **Cara mudah (disarankan)**: pakai tombol "💬 WA" di menu Data BSU (kirim
  kredensial baru langsung ke WhatsApp terdaftar tiap BSU) satu per satu,
  atau reset manual passwordnya lewat *Data BSU → Edit* dulu baru kirim WA.
- **Cara mempertahankan password lama** (kalau tidak mau BSU direpotkan
  ganti password): sebelum project lama ditutup, jalankan query berikut di
  **SQL Editor project LAMA** untuk mengekspor id+password:
  ```sql
  select id, password from bsu order by id;
  ```
  Salin hasilnya, lalu di **SQL Editor project BARU** (setelah restore
  selesai) jalankan `update bsu set password = '...' where id = '...';`
  untuk tiap baris (atau minta saya bantu susun jadi satu skrip SQL siap
  pakai kalau Anda kirimkan hasil query di atas).

### F. Verifikasi sebelum benar-benar pindah
11. Cek beberapa angka kunci cocok dengan project lama: jumlah BSU, saldo
    beberapa BSU (menu Saldo/Tabungan BSU), total transaksi bulan berjalan.
12. Baru setelah yakin cocok, beri tahu semua BSU untuk mulai pakai
    aplikasi & (kalau relevan) password baru mereka, dan boleh mulai
    membiarkan project Supabase lama nonaktif/expired.

## Cek Saldo Mandiri via QR (untuk Nasabah)

File baru **`cek-saldo.html`** wajib diupload ke folder yang SAMA dengan
`induk.html`/`unit.html`/`supabase-adapter.js` di hosting Anda (dia
memanggil `supabase-adapter.js` di folder yang sama). Halaman ini publik,
tidak perlu login, dan dibuat khusus untuk dibuka nasabah lewat HP.

**Dua model QR, dua-duanya tersedia:**

1. **QR per Unit** — satu QR dicetak & ditempel di lokasi BSU. Nasabah scan,
   lalu ketik nomor HP terdaftar untuk mencari saldonya sendiri.
   Dicetak dari: *Data BSU* di `induk.html` (tombol 🔲) atau tombol
   "Cetak QR Cek Saldo" di dashboard `unit.html` (BSU bisa cetak sendiri).

2. **QR pribadi per Nasabah** — kartu/stiker per orang, langsung menuju
   saldo nasabah tsb (tetap minta konfirmasi nomor HP dulu, supaya kartu
   yang hilang/difoto orang lain tidak otomatis membocorkan saldo).
   Dicetak dari `unit.html` menu **Nasabah**: tombol QR di tiap baris untuk
   satu orang, atau tombol **"Cetak Semua QR Nasabah (Kartu)"** untuk
   sekaligus semua nasabah (tersusun rapi 2x4 kartu per halaman A4, siap
   dipotong dan dibagikan).

**Cara kerja teknis:** QR dibuat 100% di browser (client-side, pakai
library `qrcode`), tidak dikirim ke server pihak ketiga mana pun. QR
menyimpan tautan ke `cek-saldo.html?unit=...` (dan `&nasabah=...` untuk QR
pribadi) — persis alamat website Anda sendiri, disesuaikan otomatis dari
URL tempat tombol cetak diklik.

**Catatan keterbatasan data:** transaksi nasabah dikaitkan lewat kecocokan
**nama**, bukan ID unik (ini desain lama yang sudah ada sebelum fitur ini
dibuat). Kalau ada 2 nasabah dengan nama PERSIS SAMA di satu unit, riwayat
keduanya bisa tergabung saat ditampilkan. Kalau ini jadi masalah nyata di
lapangan, beri tahu saya — bisa diperbaiki dengan menambah kolom penghubung
yang lebih stabil di database.

## Berkas yang diserahkan

- `schema_upgrade.sql` — migrasi database (jalankan sekali di Supabase)
- `supabase-adapter.js` — pengganti file lama
- `induk.html` — pengganti file lama
- `unit.html` — pengganti file lama
- `cek-saldo.html` — file BARU, upload ke folder yang sama (untuk nasabah, publik tanpa login)
