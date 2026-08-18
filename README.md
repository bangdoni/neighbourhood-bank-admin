# Neighbourhood Bank — Bot Admin Telegram

Sistem kas/arisan komunitas sederhana: mencatat iuran bulanan warga, menampilkan saldo, laporan, pengingat, dan pengaturan rekening pembayaran (QR code / payment gateway).

Bot admin diakses melalui **Telegram**. Backend berupa **Cloudflare Worker** dengan basis data **Cloudflare D1 (SQLite)** dan penyimpanan gambar QR di **Cloudflare R2**.

```
Telegram (User Bot & Admin Bot)
        │ webhook
        ▼
  Cloudflare Worker (worker.js)
        │
   ┌────┴─────┐
   ▼          ▼
 Cloudflare D1  Cloudflare R2
 (data)        (gambar QR)
```

---

## Daftar Isi

- [Prasyarat](#prasyarat)
- [Instalasi](#instalasi)
- [Konfigurasi Environment](#konfigurasi-environment)
- [Menghubungkan Webhook Telegram](#menghubungkan-webhook-telegram)
- [Peran & Izin](#peran--izin)
- [Perintah Telegram](#perintah-telegram)
- [Penggunaan Bot](#penggunaan-bot)
- [Penjelasan Fungsi](#penjelasan-fungsi)
- [Struktur Basis Data](#struktur-basis-data)
- [Pekerjaan Terjadwal (Cron)](#pekerjaan-terjadwal-cron)
- [Backup](#backup)
- [Pengujian](#pengujian)

---

## Prasyarat

- Akun [Cloudflare](https://dash.cloudflare.com) (paket gratis cukup)
- [Node.js](https://nodejs.org) 18+ dan npm
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- Bot Telegram dibuat via [@BotFather](https://t.me/BotFather) (dapatkan `BOT_TOKEN`)

---

## Instalasi

### 1. Ambil kode proyek

```bash
git clone <url-repo-anda>
cd neighbourhood-bank-admin
npm install
```

### 2. Login Cloudflare

```bash
wrangler login
```

### 3. Buat basis data D1

```bash
wrangler d1 create neighbourhood-bank
```

Salin `database_id` dari output ke `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "neighbourhood-bank"
database_id = "<database_id-anda>"
```

### 4. Buat bucket R2

```bash
wrangler r2 bucket create neighbourhood-bank-bucket
```

Tambahkan ke `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "QR_BUCKET"
bucket_name = "neighbourhood-bank-bucket"
```

### 5. Terapkan skema basis data

```bash
wrangler d1 execute neighbourhood-bank --file=schema.sql
```

Skema membuat tabel `config`, `admins`, `users`, `transactions`, `audit`, `bot_state`, `processed_updates`, `notifications`, `counters`, lalu menanam data awal:

- Admin pertama: `ADM-0001` dengan `telegram_id` `198058921` (peran `SUPER_ADMIN`) — **ubah ke ID Telegram Anda** jika berbeda
- Konfigurasi default (iuran bulanan Rp 50.000, zona waktu `Asia/Jakarta`, dll.)
- Penghitung ID (`counters`) sehingga ID pertama yang dibuat adalah `NB-0001`, `TX-000001`, dst.

### 6. Atur secret

```bash
wrangler secret put BOT_TOKEN        # token dari BotFather
wrangler secret put WEBHOOK_SECRET   # string rahasia untuk memvalidasi webhook
```

### 7. Deploy

```bash
wrangler deploy
```

### 8. Uji

```bash
curl https://neighbourhood-bank-admin.<subdomain-anda>.workers.dev
```

Harus membalas: `Neighbourhood Bank Admin Bot OK`.

---

## Konfigurasi Environment

Variabel di `wrangler.toml` `[vars]`:

| Variabel | Contoh | Keterangan |
|---|---|---|
| `TIMEZONE` | `Asia/Jakarta` | Zona waktu laporan & pekerjaan terjadwal |
| `QR_PUBLIC_URL` | `https://neighbourhood-bank-admin.romdhani.workers.dev/qr` | URL publik untuk menampilkan gambar QR |

Secret (diatur via `wrangler secret put`):

| Variabel | Keterangan |
|---|---|
| `BOT_TOKEN` | Token bot Telegram dari BotFather |
| `WEBHOOK_SECRET` | Rahasia validasi webhook Telegram |

Binding (dari `wrangler.toml`): `DB` (D1), `QR_BUCKET` (R2).

---

## Menghubungkan Webhook Telegram

Setelah deploy, arahkan webhook bot ke Worker:

```bash
curl -F "url=https://neighbourhood-bank-admin.<subdomain-anda>.workers.dev" \
     -F "secret_token=<WEBHOOK_SECRET>" \
     https://api.telegram.org/bot<BOT_TOKEN>/setWebhook
```

Verifikasi:

```bash
curl https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
```

Setiap update Telegram dicek terhadap tabel `processed_updates` agar webhook yang terkirim ganda tidak diproses dua kali.

---

## Peran & Izin

| Peran | Kemampuan |
|---|---|
| `SUPER_ADMIN` | Semua akses, termasuk kelola admin & pengaturan |
| `TREASURER` | Operasional keuangan: anggota, pembayaran, saldo, belum bayar, laporan, notifikasi, store, audit (tidak bisa kelola admin/ubah pengaturan) |
| `ADMIN` | Hanya baca: anggota, pembayaran, saldo, belum bayar, laporan, store, audit |

Akses ke bot ditentukan oleh **ID Telegram numerik** yang tersimpan di tabel `admins`, bukan username.

---

## Perintah Telegram

| Perintah | Fungsi |
|---|---|
| `/start`, `/menu`, `/help` | Tampilkan menu utama |
| `/users` | Daftar anggota |
| `/user NB-0001` | Detail anggota |
| `/addmember` | Tambah anggota baru |
| `/editmember NB-0001` | Edit anggota |
| `/disablemember NB-0001` | Nonaktifkan anggota |
| `/balances` | Ringkasan saldo komunitas |
| `/balance NB-0001` | Saldo anggota |
| `/payment` / `/pay` | Catat pembayaran |
| `/payments` | Daftar transaksi |
| `/unpaid` | Anggota yang belum membayar periode berjalan |
| `/reports` / `/report` | Menu laporan |
| `/store` | Rekening pembayaran & QR |
| `/notifications` | Kirim pengingat / ringkasan harian |
| `/settings` | Pengaturan sistem |
| `/audit` | Log audit |
| `/admins` | Kelola admin |

---

## Penggunaan Bot

Buka chat dengan bot di Telegram, kirim `/start`. Menu utama (menyesuaikan izin peran):

```
👥 Anggota   💰 Saldo
💳 Pembayaran ❌ Belum Bayar
📊 Laporan   🏦 Rekening (store)
🔔 Notifikasi ⚙️ Pengaturan
📝 Log Audit 👑 Admin
```

### Alur utama

**Tambah anggota** — `/addmember` → ikuti langkah: nama → telepon → ID Telegram → iuran bulanan → konfirmasi → dibuat (ID otomatis `NB-XXXX`).

**Catat pembayaran** — `/payment` → pilih anggota → periode → jumlah → metode (`QRIS`, `BANK_TRANSFER`, `CASH`, `OTHER`) → konfirmasi. Sebelum konfirmasi ledger tidak diubah. Pembayaran ganda dicegah lewat `reference` unik.

**Koreksi pembayaran** — dari detail transaksi: `↩️ Balikkan` (membuat transaksi `REVERSAL`, aslinya tetap tersimpan) atau `✏️ Koreksi Jumlah` (reversal + entri baru). Transaksi tidak pernah dihapus.

**Pengingat belum bayar** — menu Belum Bayar → `📢 Ingatkan Semua` (konfirmasi dulu) atau pilih anggota satu per satu. Pengingat massal per periode/anggota hanya terkirim sekali (tabel `notifications`).

**Ganti QR code** — `/store` → `🔄 Ganti QR` → kirim gambar → konfirmasi. Gambar diunggah ke R2 sebagai `payment-qrcode.png`, ditampilkan publik di `/qr`.

**Laporan** — `/reports`: bulanan, tahunan, ringkasan kontribusi, kurang bayar, saldo anggota, dan ekspor XLS (format SpreadsheetML, bisa dibuka di Excel).

**Tombol `⬅️ Kembali`** tersedia di setiap layar untuk kembali ke menu sebelumnya.

---

## Penjelasan Fungsi

Semua logika ada di `worker.js`. Modul per fungsi:

### Adapter basis data (D1 SQLite / PostgreSQL)

| Fungsi | Keterangan |
|---|---|
| `initEnv(env)` | Menginisialisasi environment; membaca `DB_TYPE` (`sqlite` atau `postgres`) |
| `dbAll(sql, ...params)` | Eksekusi query dan kembalikan semua baris |
| `dbOne(sql, ...params)` | Kembalikan satu baris pertama atau `null` |
| `dbRun(sql, ...params)` | Eksekusi query tanpa perlu hasil (INSERT/UPDATE/DELETE) |
| `dbInsert(table, row)` | Insert baris, kembalikan baris yang dibuat |
| `dbUpdate(table, pkCol, pkVal, fields)` | Update baris berdasarkan primary key |
| `dbUpsertIgnore(table, row, conflictCols)` | Insert, abaikan jika duplikat (dipakai untuk dedup update) |
| `dbUpsert(table, row, conflictCols)` | Insert, perbarui jika konflik (dipakai `bot_state`, `config`) |

### Utilitas

| Fungsi | Keterangan |
|---|---|
| `toInt(v)` | Konversi aman ke bilangan bulat (non-angka → 0) |
| `isPosInt(v)` | Validasi bilangan bulat positif |
| `isValidPeriod(p)` | Validasi format periode `YYYY-MM` |
| `isValidMemberId(id)` | Validasi format ID anggota `NB-0001` |
| `isValidTelegramId(v)` | Validasi ID Telegram numerik |
| `isValidPhone(v)` | Validasi nomor HP Indonesia (`08xxxxxxxxx`) |
| `uniqueId(prefix)` | Buat ID unik acak (untuk `request_id`/referensi) |
| `pageSlice(arr, page, size)` | Ambil satu halaman data (pagination) |
| `formatIDR(n)` | Format rupiah: `50000` → `Rp 50.000` |
| `periodLabel(p)` | `2026-08` → `Agustus 2026` |
| `prevPeriod(p)` | Periode sebelumnya |
| `currentPeriod()` | Periode berjalan berdasarkan zona waktu |
| `fmtDate(d, pat)` | Format tanggal lokal |
| `nowIso()` | Timestamp ISO sekarang |

### Konfigurasi & ID

| Fungsi | Keterangan |
|---|---|
| `loadConfig()` | Muat semua `config` dari D1, gabung dengan default |
| `cfg(key)` / `getConfig(key)` | Baca satu nilai konfigurasi |
| `setConfig(key, value, by)` | Tulis nilai konfigurasi (upsert) |
| `nextId(name, prefix, padLen)` | Buat ID berurutan atomik (`NB-0001`, `TX-000001`, `AUD-000123`, `ADM-0002`) lewat tabel `counters` |

### Kunci (mutex)

| Fungsi | Keterangan |
|---|---|
| `withLock(fn)` | Mutex dalam satu isolate; semua mutasi finansial dijalankan lewat ini untuk mencegah operasi tumpang-tindih |

### Autentikasi & izin

| Fungsi | Keterangan |
|---|---|
| `authenticateAdmin(telegramId)` | Cari admin aktif berdasarkan ID Telegram |
| `hasPermission(admin, perm)` | Cek izin sesuai peran (`SUPER_ADMIN` = semua) |

### Audit

| Fungsi | Keterangan |
|---|---|
| `writeAuditLog(admin, action, targetType, targetId, details, status)` | Catat setiap operasi administratif/finansial ke tabel `audit` |

### Admin

| Fungsi | Keterangan |
|---|---|
| `listAdmins()` | Semua admin |
| `getAdmin(id)` / `getAdminByTg(tid)` / `getAdminByPhone(phone)` | Cari admin |
| `activeAdmins()` | Admin berstatus aktif |
| `createAdmin(admin, data)` | Buat admin baru + audit |
| `disableAdmin(admin, id)` | Nonaktifkan admin + audit |

### Anggota

| Fungsi | Keterangan |
|---|---|
| `getMember(id)` | Detail anggota |
| `listMembers()` | Semua anggota (urut nama) |
| `activeMembers()` / `inactiveMembers()` | Anggota aktif / nonaktif |
| `searchMembers(q)` | Cari berdasarkan nama, ID, atau username Telegram |
| `memberFee(m)` | Iuran anggota (iuran pribadi, fallback ke `monthly_fee` global) |
| `createMember(admin, data)` | Buat anggota + audit |
| `updateMember(admin, id, fields)` | Update anggota + audit |
| `disableMember(admin, id)` | Nonaktifkan anggota + audit |

### Transaksi & saldo

| Fungsi | Keterangan |
|---|---|
| `sumTx(userId, period?)` | Total jumlah transaksi (per periode jika diisi) |
| `getBalance(userId)` | Saldo anggota = jumlah semua transaksi |
| `allTx()` / `allTransactions()` | Semua transaksi (untuk ringkasan / daftar) |
| `getTx(id)` | Detail transaksi |
| `memberTx(userId)` | Riwayat transaksi satu anggota |
| `hasReference(ref)` | Cek apakah referensi sudah dipakai (anti duplikat) |
| `createTransaction(o)` | Buat transaksi di dalam lock; tolak jika `reference` duplikat |
| `createTransactionInner(o)` | Implementasi inti pembuatan transaksi (hitung `balance_after`) |
| `reverseTransaction(admin, txId, reason)` | Buat transaksi `REVERSAL` untuk membalikkan transaksi (tidak menghapus aslinya) |
| `recordPayment(admin, o)` | Catat pembayaran: validasi anggota aktif, jumlah, periode, metode, lalu tulis transaksi + audit (di dalam lock) |
| `correctPayment(admin, txId, newAmount)` | Koreksi pembayaran: reversal transaksi lama + entri kontribusi baru |

### Saldo / belum bayar / laporan

| Fungsi | Keterangan |
|---|---|
| `balancesOverview()` | Ringkasan dana komunitas: total, anggota bersaldo, saldo nol |
| `unpaidMembers(period)` | Anggota yang belum melunasi iuran periode tertentu |
| `unpaidSummary(period)` | Ekspektasi, terkumpul, kurang, lunas/belum per periode |
| `monthlyReport(period)` | Laporan bulanan lengkap (+ dana saat ini) |
| `yearlyReport(year)` | Laporan per bulan sepanjang tahun + total |
| `memberBalanceSummary()` | Saldo semua anggota aktif, urut terbesar |

### Store / QR / payment gateway

| Fungsi | Keterangan |
|---|---|
| `getStoreConfig()` | Baca konfigurasi rekening + gateway |
| `updateStoreField(admin, field, value)` | Update satu field store + audit |
| `setQrCode(admin, url)` | Simpan URL QR baru + audit |
| `uploadQr(buf)` | Upload gambar ke R2 (`payment-qrcode.png`), kembalikan URL publik |
| `serveQr(request)` | Layani `GET /qr` dengan `Cache-Control: public, max-age=3600` |
| `pgCreatePayment(c, orderId, amount)` | Buat pembayaran QRIS via payment gateway |
| `handlePaymentWebhook(request, env)` | Terima webhook dari gateway (path `/webhook/pg/`), tandai transaksi sukses/gagal |

### Notifikasi

| Fungsi | Keterangan |
|---|---|
| `notifyMember(m, text)` | Kirim pesan ke satu anggota |
| `notifyAdmins(text)` | Kirim pesan ke semua admin aktif |
| `reminderText(m, period, fee)` | Teks pengingat iuran |
| `remindUnpaid(period, memberIds?)` | Kirim pengingat massal; cegah duplikat lewat tabel `notifications` |
| `dailySummary()` | Kirim ringkasan harian (pembayaran, terkumpul, anggota baru, belum bayar, dana) ke admin |

### Telegram

| Fungsi | Keterangan |
|---|---|
| `tg(method, payload)` | Panggilan API Telegram |
| `sendTelegramMessage(chatId, text, buttons?)` | Kirim pesan teks (+ inline keyboard) |
| `sendTelegramPhoto(chatId, url, caption, buttons?)` | Kirim foto (mis. QR) |
| `sendTelegramDocument(chatId, filename, content, mime)` | Kirim dokumen (laporan XLS) |
| `answerCallback(cbId, text, alert)` | Balas callback query |
| `buildXls(sheetName, rows)` | Bangun file XLS (SpreadsheetML) tanpa pustaka eksternal |
| `mainMenuKeyboard(admin)` | Keyboard menu utama sesuai izin peran |
| `sendMainMenu(chatId, admin)` | Kirim menu utama |

### State percakapan (alur multi-langkah)

| Fungsi | Keterangan |
|---|---|
| `stateGet(chatId)` | Baca state alur percakapan (disimpan di D1) |
| `stateSet(chatId, o)` | Simpan state |
| `stateClear(chatId)` | Hapus state |
| `pushBackTarget(chatId, target)` | Simpan target untuk tombol `⬅️ Kembali` |
| `popBackTarget(chatId)` | Ambil target kembali terakhir |

### Router

| Fungsi | Keterangan |
|---|---|
| `handleUpdate(update)` | Titik masuk setiap update Telegram (message / callback) |
| `handleMessage(msg)` | Proses pesan: autentikasi → cek state → perintah |
| `handleCommand(chatId, admin, text)` | Dispatch perintah `/...` |
| `handleCallback(cb)` | Dispatch callback tombol; validasi sesi & izin |
| `handleStateInput(chatId, admin, st, msg)` | Proses input teks pada alur multi-langkah (tambah/edit anggota, pembayaran, store, settings, admin) |

### Tampilan (views)

| Fungsi | Keterangan |
|---|---|
| `searchResults(...)` | Hasil pencarian anggota |
| `membersList(chatId, admin, page, filter)` | Daftar anggota (pagination + filter aktif/nonaktif) |
| `memberDetail(chatId, admin, id)` | Detail anggota + aksi sesuai izin |
| `memberHistory(chatId, admin, id, page)` | Riwayat transaksi anggota |
| `startAddMember` / `addMemberStep` / `askTg` / `askFee` / `reviewNewMember` / `confirmCreateMember` | Alur tambah anggota |
| `editMemberMenu` / `editFieldAsk` / `editMemberStep` | Alur edit anggota |
| `disableConfirm` / `doDisable` | Konfirmasi & eksekusi nonaktifkan anggota |
| `balancesView` / `memberBalanceView` | Tampilan saldo |
| `startPaymentPick` / `startPayment` / `payPeriod` / `showAmountOptions` / `payAmount` / `payMethodSelect` / `payMethod` / `reviewPayment` / `confirmPayment` / `payStep` | Alur pencatatan pembayaran |
| `paymentsList` / `paymentDetail` | Daftar & detail transaksi |
| `reverseConfirm` / `doReverse` / `startCorrection` / `doCorrection` | Alur pembalikan & koreksi |
| `unpaidView` / `unpaidList` / `remindConfirm` / `doRemindAll` / `remindOneConfirm` / `doRemindOne` | Alur belum bayar & pengingat |
| `reportsMenu` / `periodPicker` / `yearPicker` / `monthlyReportView` / `yearlyReportView` / `outstandingReportView` / `memberBalanceReportView` / `exportReportXls` | Laporan & ekspor XLS |
| `storeView` / `storePgMenu` / `storePgTest` / `setStoreMode` / `viewQr` / `startQrChange` / `handleStoreQrPhoto` / `doQrChange` / `storeEditMenu` / `storeFieldAsk` / `storeFieldStep` | Manajemen store, QR, gateway |
| `settingsView` / `settingAsk` / `settingsStep` / `notifSettingsView` / `toggleNotif` / `notificationsView` | Pengaturan & notifikasi |
| `auditLog(chatId, admin, page)` | Log audit (pagination) |
| `adminsList` / `startAddAdmin` / `adminStep` / `adminRole` / `confirmCreateAdmin` / `adminDisableConfirm` / `doDisableAdmin` | Manajemen admin |

### Pekerjaan terjadwal & entry point

| Fungsi | Keterangan |
|---|---|
| `monthlyReminderJob()` | Cron jam 08:00 (zona lokal): kirim pengingat ke yang belum bayar |
| `dailySummaryJob()` | Cron jam 20:00: kirim ringkasan harian ke admin |
| `isValidHook(request)` | Validasi webhook via header `x-telegram-bot-api-secret-token` atau query `?hook=` |
| `fetch(request, env)` | Entry point HTTP: `GET /qr` (gambar QR), `/webhook/pg/` (webhook gateway), `POST /` (webhook Telegram, dedup via `processed_updates`) |
| `scheduled(event, env, ctx)` | Entry point cron |

---

## Struktur Basis Data

| Tabel | Isi |
|---|---|
| `config` | Konfigurasi sistem (iuran, zona waktu, bank, QR, notifikasi, gateway) |
| `admins` | Akun administrator (peran, status) |
| `users` | Anggota komunitas |
| `transactions` | Ledger transaksi (kontribusi, reversal, dst.) — sumber kebenaran saldo |
| `audit` | Jejak audit setiap operasi |
| `bot_state` | State alur percakapan Telegram |
| `processed_updates` | Dedup update webhook |
| `notifications` | Riwayat pengingat (anti duplikat) |
| `counters` | Penghitung ID atomik |

Catatan:

- Saldo anggota dihitung dari `transactions`, bukan kolom tersendiri — tidak ada ledger per anggota.
- Transaksi tidak pernah dihapus; koreksi memakai `REVERSAL`.
- `transactions.reference` punya unique index parsial sebagai pengaman anti-duplikat.
- Skema PostgreSQL tersedia di `schema-postgres.sql` untuk mode `DB_TYPE=postgres` (Hyperdrive).

---

## Pekerjaan Terjadwal (Cron)

Daftarkan cron di panel Cloudflare Worker (Triggers → Cron Triggers):

| Waktu (Asia/Jakarta) | Pekerjaan |
|---|---|
| 08:00 | Pengingat iuran bulanan (`monthlyReminderJob`) |
| 20:00 | Ringkasan harian admin (`dailySummaryJob`) |

Keduanya hanya berjalan jika diaktifkan di pengaturan (`monthly_reminder_enabled`, `admin_daily_summary_enabled`).

---

## Backup

Basis data utama adalah D1; lakukan ekspor berkala:

```bash
wrangler d1 export neighbourhood-bank --output backup/$(date +%F).sql
```

Simpan file backup di tempat terpisah (R2/drive). Cadangkan juga objek `payment-qrcode.png` dari R2.

---

## Pengujian

Self-check logika murni:

```bash
node test_selfcheck.js
```

Poin pengujian penting (per AGENTS.md): autentikasi (admin sah / tidak dikenal / dinonaktifkan), izin per peran, CRUD anggota (termasuk duplikat ID Telegram), pencatatan & duplikasi pembayaran, koreksi, QR, pengingat, dan laporan (bulan kosong / penuh / sebagian).
