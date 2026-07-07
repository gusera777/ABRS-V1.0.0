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

## Rule Entry (v1.3 — diperbaiki)

Entry ABRS sekarang bekerja langsung (market), tanpa menunggu breakout range:

1. **Entry pertama**: begitu cycle dimulai, sistem langsung buka posisi dengan lot **0.01** — arahnya (BUY/SELL) mengikuti trend jangka pendek (SMA cepat vs SMA lambat dari candle terbaru).
2. **Hedge lawan arah**: jika harga kemudian bergerak melawan posisi pertama (turun untuk BUY, naik untuk SELL), sistem langsung membuka posisi lawan arah dengan lot tetap **0.03** (satu kali per cycle). Contoh: BUY 0.01 lalu harga turun → open SELL 0.03. Sebaliknya: SELL 0.01 lalu harga naik → open BUY 0.03.
3. **Close All**: begitu total floating profit basket (BUY+SELL) mencapai target profit tetap (**default $10**, bisa diubah di Pengaturan → "Target Profit Basket"), seluruh posisi ditutup sekaligus.
4. **Jaring pengaman**: Stop Loss bertingkat & EMERGENCY (Global Risk) tetap berjalan seperti sebelumnya, untuk membatasi kerugian jika harga terus bergerak melawan basket setelah hedge terpasang.

Lot hedge (0.03) dan target profit ($10) bisa disesuaikan di modal Pengaturan (`hedgeLotSize`, `basketTargetUsd` di `abrs-engine.js` / `app.js`).

## Perubahan di Versi Ini (Evaluasi & Perbaikan)

- **Grafik harga + marker Entry** (`priceChart` canvas di `app.js`/`index.html`): candle, garis Resistance/Support, level Pending Order, dan segitiga Entry (hijau=BUY, merah=SELL, outline abu=LOCKED) — murni canvas 2D, tanpa library luar.
- **Stop Loss bertingkat** (`basketStopLossPct` di `abrs-engine.js`): sebelumnya cycle yang kalah hanya bisa berakhir `EMERGENCY` (rugi penuh 100% Global Risk Budget) — status `LOSS` disebut di komentar & di semua kode UI/statistik tapi TIDAK PERNAH benar-benar terjadi. Sekarang cycle bisa ditutup `LOSS` lebih awal (default di 60% Global Risk Budget) sebelum menyentuh EMERGENCY, membatasi kerugian per cycle.
- **Default risiko diturunkan**: `globalRiskPct` 0.5 → 0.15, `lotMax` 0.50 → 0.20, `recoveryBudgetSplit` 0.4 → 0.35. Default lama (boleh floating rugi 50% modal) terlalu agresif untuk sistem yang menargetkan profit konsisten. Tetap bisa diubah manual di Pengaturan.
- **API key Twelve Data tidak lagi hardcode** di `DEFAULT_SETTINGS.apiKey` — sebelumnya key pribadi tertanam di source, isu privasi/keamanan. Sekarang kosong, wajib diisi manual di modal Pengaturan.

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
