# Remotion Telegram Render Bot

Telegram bot Node.js + Telegraf untuk render ZIP project Remotion menjadi MP4.

## 1. Setup Telegram
1. Buat bot melalui `@BotFather`.
2. Copy token bot.
3. Dapatkan Telegram numeric user ID melalui bot ID checker tepercaya.
4. Masukkan ID kamu ke `ALLOWED_USER_IDS`.

## 2. Deploy Railway
1. Upload folder project ini ke GitHub repository.
2. Railway → New Project → Deploy from GitHub Repo.
3. Railway akan build menggunakan Dockerfile.
4. Tambahkan Variables:
   - `BOT_TOKEN` = token dari BotFather
   - `ALLOWED_USER_IDS` = Telegram user ID yang diizinkan
   - `MAX_ZIP_MB` = 100 (opsional)
   - `RENDER_TIMEOUT_MIN` = 30 (opsional)
5. Deploy dan cek logs. Harus terlihat `Remotion Telegram bot started.`

## 3. Cara menggunakan
- Kirim ZIP project Remotion ke bot.
- Reply pesan ZIP itu dengan `/remotion`.
- Bot mengirim MP4 setelah render selesai.
- `/cancel` menerima permintaan pembatalan; versi sederhana ini membatalkan pada checkpoint, bukan langsung membunuh child process.

## 4. Struktur ZIP Remotion
ZIP harus berisi:
- `package.json`
- entry file Remotion (contoh `src/index.ts`)
- composition yang terdaftar di entry
- asset video/audio/font yang dibutuhkan

Tambahkan konfigurasi di package.json:

```json
{
  "remotionBot": {
    "entry": "src/index.ts",
    "composition": "MyVideo",
    "output": "video.mp4"
  }
}
```

`composition` harus sama persis dengan ID dari `<Composition id="MyVideo" ... />`.

Project harus menyertakan `remotion` di dependencies atau devDependencies. Bot menjalankan `npm install`/`npm ci` dari ZIP, sehingga gunakan hanya project tepercaya.

## Security / resource notes
- ZIP project dapat berisi kode JavaScript dan lifecycle scripts yang berjalan saat install/render. **Jangan menerima ZIP dari orang asing.**
- Allowlist Telegram ID wajib diisi.
- Untuk production publik, jalankan setiap render di container/worker terisolasi, bukan di proses bot yang sama.
- Render video dapat menghabiskan RAM/CPU dan waktu. Gunakan Railway service dengan resource cukup.
- Telegram memiliki batas ukuran upload/download/send video yang dapat berubah; jika MP4 terlalu besar, kirim sebagai document atau gunakan object storage.
- `npm install` bisa memakan waktu lama. Render timeout dapat diatur melalui Railway variable.

By xDonzCode