# GUSERA SATS — ABRS Console

Dashboard UI untuk `ABRSEngine` (Adaptive Breakout Recovery System). Murni client-side — buka `index.html` langsung di browser, tanpa backend/server.

## Menjalankan

Cukup buka `index.html` di browser (double-click, atau `open index.html` / drag ke tab browser). Untuk beberapa browser yang membatasi `fetch()` dari file lokal, jalankan server statis sederhana:

```bash
cd gusera-sats-abrs
python3 -m http.server 8080
# lalu buka http://localhost:8080
```

## Mode Demo vs Live

- **Mode Demo** (toggle di topbar): memakai data simulasi random-walk (`SyntheticFeed` di `price-feed.js`), tanpa perlu API key atau koneksi internet ke Twelve Data. Cocok untuk mencoba UI, melihat basket terbentuk, recovery, TQI berubah, dsb. Polling dipercepat (tiap 1.5 detik) supaya enak didemokan.
- **Mode Live**: memakai `TwelveDataFeed`, butuh API key Twelve Data (isi di ⚙ Pengaturan). Polling harga tiap 10 detik, candle/ATR/TQI di-refresh tiap 60 detik — disesuaikan agar hemat kuota API gratis Twelve Data (±8 request/menit). Jika butuh update lebih cepat, sesuaikan `QUOTE_POLL_MS` / `CANDLE_POLL_MS` di `app.js`, sesuai batas plan API kamu.

## Struktur File

| File | Fungsi |
|---|---|
| `abrs-engine.js` | Core logic ABRS (tidak diubah dari file asli) — basket, recovery ladder, TQI, global risk. |
| `price-feed.js` | `TwelveDataFeed` (candle & quote real) + `SyntheticFeed` (data simulasi) + `MarketAnalytics` (ATR, penurunan 7 komponen TQI dari OHLC). |
| `app.js` | Menjembatani engine + feed ke UI: siklus tick, biaya spread/komisi, render semua kartu/tabel, Pengaturan, AI Self-Learning. |
| `style.css` | Desain "ledger/block" — tiap trading cycle divisualisasikan seperti blok dengan hash-id & rantai riwayat. |
| `index.html` | Struktur halaman. |

## Catatan Penting

- **Biaya transaksi**: spread & komisi diterapkan sebagai deduksi nyata ke `basketProfit` tiap posisi baru dibuka (lihat `applyEntryCosts` di `app.js`) — bukan sekadar tampilan.
- **Penyimpanan**: Settingan, riwayat cycle (`trading_cycle`), dan log (`trade_event`) disimpan di `localStorage` browser. Tidak dikirim ke server manapun.
- **Keamanan API key**: karena ini murni client-side, API key tersimpan di `localStorage` dan bisa dilihat lewat DevTools siapa pun yang mengakses browser tersebut. Untuk deployment publik, sebaiknya proxy request Twelve Data lewat backend kecil agar key tidak terekspos di frontend.
- **AI Self-Learning**: bukan model machine learning — ini heuristik adaptif yang membaca pola dari riwayat cycle tersimpan (efektivitas recovery, band TQI paling profitable, frekuensi emergency-close, rasio drawdown/target) dan menyarankan penyesuaian parameter. Butuh minimal 5 cycle selesai untuk mulai muncul.
- **Reset**: tombol "Reset Riwayat" di modal Pengaturan menghapus seluruh riwayat cycle & event (permanen, tidak bisa dibatalkan).

## Mengganti Sumber Data / Model TQI

Fungsi `MarketAnalytics.deriveTQIComponents()` di `price-feed.js` adalah heuristik sederhana (SMA slope, RSI, ATR relatif, dsb.) untuk menurunkan 7 komponen TQI dari candle. Bisa diganti dengan model lain selama tetap mengembalikan objek dengan 7 key skala 0–100: `trendStrength, marketStructure, volatility, breakoutQuality, volume, spread, momentum`.
