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

## Rule Entry (v2.0 — Basket Hedging + Reverse Martingale)

Entry ABRS sekarang mengikuti rules **Basket Hedging + Reverse Martingale**: entry pertama market, lalu basket dibangun lewat pending order yang saling berselang-seling (alternating BUY_STOP / SELL_STOP) dengan lot progresif.

1. **Entry pertama**: begitu cycle dimulai, sistem langsung buka posisi Level 1 dengan lot **Initial Lot** (default 0.01) — arahnya (BUY/SELL) mengikuti trend jangka pendek (SMA cepat vs SMA lambat dari candle terbaru). Opsional: filter TQI (`tqiTrendFilter`) bisa mewajibkan TQI ≥ threshold (default 70) sebelum cycle boleh mulai.
2. **Pending order lawan arah**: segera setelah entry pertama, sistem memasang **satu** pending order di sisi berlawanan, pada jarak tetap **Distance** (default 300 point × Point Size) dari harga entry, dengan lot Level berikutnya dari **Tabel Lot progresif**: 0.10, 0.30, 0.60, 1.20, 2.40, 4.80, 9.60, 19.20, 38.40, 76.80 (×3 dari Level 1→2, lalu ×2 tiap level berikutnya). Contoh: BUY 0.10 → pasang SELL_STOP 0.30. Sebaliknya: SELL 0.10 → pasang BUY_STOP 0.30. **Perhatian**: dengan Initial Lot 0.10, lot di Level 10 mencapai 76.80 — pastikan ukuran ini sesuai kapasitas modal/akun sebelum dipakai live, karena strategi ini pada dasarnya tidak membatasi rugi sendiri (lihat poin 6).
3. **Siklus alternating**: setiap kali pending order tersentuh, posisi baru terbuka, pending lama dihapus, dan pending baru lawan arah dipasang di level berikutnya (BUY → SELL → BUY → SELL → ...) hingga salah satu sisi mencapai batas maksimum. EA hanya pernah punya **1 pending order aktif** setiap saat.
4. **Batas posisi**: Max BUY (default 10), Max SELL (default 10), Max Total (20). Begitu satu sisi mencapai batasnya, EA berhenti memasang pending baru di sisi itu dan hanya mengelola basket yang ada. Level di atas 10 (bisa terjadi karena Max BUY+SELL sampai 20) memakai lot Level 10 (7.68) karena Tabel Lot hanya mendefinisikan 10 level.
5. **Close All**: begitu total floating profit basket (BUY+SELL) mencapai target — default **1% Equity** (bisa diubah di Pengaturan → "Target Profit Basket (% Equity)"), seluruh posisi ditutup sekaligus, pending order dihapus, dan basket reset ke Level 1.
6. **Jaring pengaman (opsional, di luar dokumen rules asli)**: Stop Loss bertingkat & EMERGENCY (Global Risk) tetap tersedia untuk membatasi kerugian jika harga terus melawan basket tanpa reversal — bisa dinonaktifkan di Pengaturan ("Aktifkan Jaring Pengaman") jika ingin murni mengikuti dokumen rules tanpa batas rugi $ tambahan. **Catatan penting**: strategi basket hedging + reverse martingale ini pada dasarnya tidak punya batas rugi bawaan — risiko ekor (tail risk) tetap ada saat market trending kuat searah tanpa reversal, dan tidak ada kombinasi parameter yang menghilangkannya sepenuhnya.

Initial Lot, Distance, Point Size, Max BUY/SELL, dan Target Profit (% Equity) semuanya bisa disesuaikan di modal Pengaturan (`initialLot`, `distancePoints`, `pointSize`, `maxBuy`, `maxSell`, `basketTargetPct` di `abrs-engine.js` / `app.js`). Point Size perlu disesuaikan per instrumen (perkiraan: XAU/USD ≈ 0.01, BTC/USD ≈ 1, US30/USD ≈ 1, EUR/USD atau GBP/USD ≈ 0.0001).

## Perubahan di Versi Ini — v2.0 (Basket Hedging + Reverse Martingale)

- **Logic entry diganti total**: dari hedge tunggal (1x lot tetap) di v1.3, menjadi basket ladder alternating BUY_STOP/SELL_STOP dengan Tabel Lot progresif (0.10 → 76.80 di 10 level, Initial Lot 0.10), sesuai dokumen rules "Basket Hedging + Reverse Martingale V2.0". Lihat bagian **Rule Entry (v2.0)** di atas untuk detail.
- **Target profit** kini berbasis **% Equity** (default 1%), bukan nilai $ tetap seperti sebelumnya (opsi override $ tetap masih tersedia via `basketTargetUsd` di kode jika dibutuhkan).
- **Batas posisi eksplisit**: Max BUY, Max SELL (masing-masing default 10, bisa diatur 1-10) dan Max Total (20) — begitu tercapai, EA berhenti memasang pending baru di sisi tsb.
- **Jaring pengaman (Stop Loss bertingkat & EMERGENCY)** kini bisa dimatikan lewat toggle "Aktifkan Jaring Pengaman" di Pengaturan, untuk yang ingin murni mengikuti dokumen rules tanpa proteksi $ tambahan. Default tetap aktif karena strategi ini pada dasarnya tidak membatasi rugi sendiri.
- **Filter TQI opsional** (`tqiTrendFilter`, nonaktif secara default) tersedia untuk hanya memulai cycle saat TQI ≥ threshold, sesuai saran di dokumen rules untuk meningkatkan peluang basket mencapai target.

## Perubahan di Versi Sebelumnya — v1.3 (Evaluasi & Perbaikan)

- **Grafik harga + marker Entry** (`priceChart` canvas di `app.js`/`index.html`): candle, garis Resistance/Support, level Pending Order, dan segitiga Entry (hijau=BUY, merah=SELL, outline abu=LOCKED) — murni canvas 2D, tanpa library luar.
- **Stop Loss bertingkat** (`basketStopLossPct` di `abrs-engine.js`): sebelumnya cycle yang kalah hanya bisa berakhir `EMERGENCY` (rugi penuh 100% Global Risk Budget) — status `LOSS` disebut di komentar & di semua kode UI/statistik tapi TIDAK PERNAH benar-benar terjadi. Sekarang cycle bisa ditutup `LOSS` lebih awal (default di 60% Global Risk Budget) sebelum menyentuh EMERGENCY, membatasi kerugian per cycle.
- **Default risiko diturunkan**: `globalRiskPct` 0.5 → 0.15, `lotMax` 0.50 → 0.20, `recoveryBudgetSplit` 0.4 → 0.35. Default lama (boleh floating rugi 50% modal) terlalu agresif untuk sistem yang menargetkan profit konsisten. Tetap bisa diubah manual di Pengaturan.
- **API key Twelve Data tidak lagi hardcode** di `DEFAULT_SETTINGS.apiKey` — sebelumnya key pribadi tertanam di source, isu privasi/keamanan. Sekarang kosong, wajib diisi manual di modal Pengaturan.

## Menjalankan Tanpa Aplikasi Dibuka (Headless Runner)

Aplikasi browser ini **murni client-side** — begitu tab/browser ditutup, seluruh JavaScript-nya berhenti total. Ini batasan sandboxing browser, bukan sesuatu yang bisa diperbaiki lewat kode apa pun di dalam `app.js`/`index.html`.

Untuk sistem yang tetap trading walau aplikasi tidak dibuka, `headless-runner.js` menjalankan `ABRSEngine` + price feed yang sama sebagai **proses Node.js terpisah**, independen dari browser:

```bash
node headless-runner.js
```

- Saat pertama dijalankan, file `headless-config.json` dibuat otomatis (mode demo, tanpa API key). Edit isinya (symbol, API key Twelve Data, parameter risk/lot, dst) lalu jalankan ulang untuk mode live.
- Supaya tetap berjalan setelah terminal ditutup / komputer restart, pakai process manager, mis. `pm2 start headless-runner.js --name abrs`, atau daftarkan sebagai systemd service / scheduled task. **Catatan**: proses ini sendiri tetap butuh komputer/server yang menyala — tidak ada cara membuat kode berjalan tanpa ada proses apa pun yang mengeksekusinya.
- Riwayat cycle & event otomatis tersimpan ke `headless-store.json` di folder yang sama.
- Buka `index.html` kapan saja, di modal Pengaturan bagian **"Headless Runner"**, pilih file `headless-store.json` tersebut lalu klik **Import** — riwayat trading yang terjadi selagi aplikasi tidak dibuka akan digabung ke dashboard (tanpa duplikat, dicek lewat `cycleId`).

## Bug yang Diperbaiki (Evaluasi Kode)

- **Cycle closed tidak pernah masuk riwayat (`trading_cycle`)** — bug kritis di `app.js`: variabel penanda "cycle terakhir yang sudah disimpan" (`lastKnownCycleId`) diinisialisasi dengan cycleId cycle yang SEDANG berjalan, dan kondisi flush membandingkan `cycleId !== lastKnownCycleId`. Karena `cycleId` baru berubah saat `resetCycle()` dipanggil (setelah cycle closed), sementara flush dicek SEBELUM reset terjadi, kondisi ini tidak pernah bernilai true dalam alur normal — akibatnya `history` (tabel `trading_cycle`) tidak pernah bertambah, walau cycle sudah closed berkali-kali. Sekarang diganti dengan `lastFlushedCycleId` (mulai dari `null`) yang di-set hanya setelah benar-benar berhasil di-flush, plus flush pengaman tambahan sebelum `startNewCycleAfterClose()` dipanggil.
- **Lot progresif**: default Initial Lot diubah dari 0.01 menjadi 0.10, sehingga Tabel Lot Level 1-10 menjadi 0.10, 0.30, 0.60, 1.20, 2.40, 4.80, 9.60, 19.20, 38.40, 76.80 (mengikuti progresi ×3 lalu ×2 yang sama seperti sebelumnya). **Perhatian**: lot di level tinggi jadi jauh lebih besar (76.80 di Level 10) — sesuaikan dengan kapasitas modal/akun Anda.

## Rekomendasi Lanjutan (belum diimplementasikan, perlu keputusan/waktu lebih)

1. **Backtest engine**: replay `ABRSEngine` yang sama atas data historis OHLC untuk mengukur win rate/profit factor/max drawdown riil sebelum dipakai live — saat ini nol validasi historis.
2. **PnL & pip value per-instrumen**: `pipValue` global di Settings dipakai sama untuk XAU/USD, BTC/USD, EUR/USD, US30/USD — padahal nilai kontrak/pip masing-masing jauh berbeda; sebaiknya per-simbol.
3. **Recovery budget berbasis $ risiko**, bukan proxy jumlah lot (`recoveryBudgetUsed += nextLot`), supaya konsisten dengan `globalRiskBudget`/`floatingBudget` yang berbasis $.
4. **Kedaluwarsa pending order**: level BUY_STOP/SELL_STOP tidak diperbarui walau range bergeser seiring waktu; pertimbangkan re-evaluasi/pembatalan otomatis.
5. **Diversifikasi**: satu instance engine = satu simbol pada satu waktu; risiko terkonsentrasi.

Catatan strategi (penting): ABRS pada intinya adalah pola breakout dua arah + kunci posisi lawan + ladder recovery (mirip martingale terbatas lot). Pola ini bisa terlihat "konsisten profit" pada histori pendek/kondisi normal, tapi punya risiko ekor (tail risk) saat market trending kuat searah tanpa reversal — kerugian besar bisa terjadi sekali waktu meski frekuensinya jarang. Tidak ada kombinasi parameter yang menghilangkan risiko ini sepenuhnya; yang bisa dilakukan adalah membatasinya (stop loss bertingkat, lot max lebih kecil, global risk lebih kecil) dan memvalidasinya lewat backtest sebelum live.

## Catatan Penting

- **Biaya transaksi**: spread & komisi diterapkan sebagai deduksi nyata ke `basketProfit` tiap posisi baru dibuka (lihat `applyEntryCosts` di `app.js`) — bukan sekadar tampilan.
- **Penyimpanan**: Settingan, riwayat cycle (`trading_cycle`), dan log (`trade_event`) disimpan di `localStorage` browser. Tidak dikirim ke server manapun.
- **Keamanan API key**: karena ini murni client-side, API key tersimpan di `localStorage` dan bisa dilihat lewat DevTools siapa pun yang mengakses browser tersebut. Untuk deployment publik, sebaiknya proxy request Twelve Data lewat backend kecil agar key tidak terekspos di frontend.
- **AI Self-Learning**: bukan model machine learning — ini heuristik adaptif yang membaca pola dari riwayat cycle tersimpan (efektivitas recovery, band TQI paling profitable, frekuensi emergency-close, rasio drawdown/target) dan menyarankan penyesuaian parameter. Butuh minimal 5 cycle selesai untuk mulai muncul.
- **Reset**: tombol "Reset Riwayat" di modal Pengaturan menghapus seluruh riwayat cycle & event (permanen, tidak bisa dibatalkan).

## Mengganti Sumber Data / Model TQI

Fungsi `MarketAnalytics.deriveTQIComponents()` di `price-feed.js` adalah heuristik sederhana (SMA slope, RSI, ATR relatif, dsb.) untuk menurunkan 7 komponen TQI dari candle. Bisa diganti dengan model lain selama tetap mengembalikan objek dengan 7 key skala 0–100: `trendStrength, marketStructure, volatility, breakoutQuality, volume, spread, momentum`.
