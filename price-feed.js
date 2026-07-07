/**
 * ============================================================
 *  PRICE FEED + MARKET ANALYTICS
 *  Mengambil candle dari Twelve Data API dan menurunkan:
 *   - ATR (Average True Range)
 *   - Komponen TQI (trendStrength, marketStructure, volatility,
 *     breakoutQuality, volume, spread, momentum) dari data OHLC
 *  Semua kalkulasi murni client-side, tidak ada dependensi lain.
 * ============================================================
 */

const TwelveDataFeed = {
  BASE_URL: 'https://api.twelvedata.com',

  async fetchCandles(symbol, interval, apiKey, outputsize = 60) {
    const url = `${this.BASE_URL}/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === 'error' || !data.values) {
      throw new Error(data.message || 'Gagal mengambil data candle dari Twelve Data');
    }
    // Twelve Data mengembalikan data terbaru -> terlama; balik urutannya
    const candles = data.values
      .map(v => ({
        time: v.datetime,
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
        volume: v.volume != null ? parseFloat(v.volume) : null
      }))
      .reverse();
    return candles;
  },

  async fetchQuote(symbol, apiKey) {
    const url = `${this.BASE_URL}/price?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === 'error' || data.price == null) {
      throw new Error(data.message || 'Gagal mengambil harga terkini dari Twelve Data');
    }
    return parseFloat(data.price);
  }
};

const MarketAnalytics = {
  /** Average True Range sederhana atas N candle terakhir */
  computeATR(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const cur = candles[i];
      const prev = candles[i - 1];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close)
      );
      trs.push(tr);
    }
    const lastN = trs.slice(-period);
    return lastN.reduce((a, b) => a + b, 0) / lastN.length;
  },

  sma(values, period) {
    if (values.length < period) return null;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  },

  /** RSI sederhana untuk proxy momentum (0-100) */
  computeRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff; else losses -= diff;
    }
    if (losses === 0) return 100;
    const rs = (gains / period) / (losses / period);
    return 100 - (100 / (1 + rs));
  },

  /**
   * Menurunkan 7 komponen TQI (0-100) dari data candle + spread saat ini.
   * Ini adalah heuristik sederhana, dapat diganti dengan model lain
   * selama tetap mengembalikan skala 0-100 per komponen.
   */
  deriveTQIComponents(candles, spreadPips, pipValue = 1) {
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);

    const smaFast = this.sma(closes, 10);
    const smaSlow = this.sma(closes, 30) ?? this.sma(closes, closes.length);
    const lastClose = closes[closes.length - 1];
    const firstInWindow = closes[Math.max(0, closes.length - 30)];

    // Trend strength: seberapa jauh & konsisten harga bergerak searah
    const netMove = Math.abs(lastClose - firstInWindow);
    const path = closes.slice(-30).reduce((sum, c, i, arr) => i === 0 ? 0 : sum + Math.abs(c - arr[i - 1]), 0) || 1;
    const trendStrength = Math.min(100, (netMove / path) * 220);

    // Market structure: rangkaian higher-high/higher-low atau sebaliknya
    let hh = 0, hl = 0, lh = 0, ll = 0;
    for (let i = 2; i < highs.length; i++) {
      if (highs[i] > highs[i - 1]) hh++; else lh++;
      if (lows[i] > lows[i - 1]) hl++; else ll++;
    }
    const structureBias = Math.abs((hh + hl) - (lh + ll)) / (hh + hl + lh + ll || 1);
    const marketStructure = Math.min(100, structureBias * 150);

    // Volatility: ATR relatif terhadap harga, dinormalisasi
    const atr = this.computeATR(candles) ?? 0;
    const volPct = lastClose ? (atr / lastClose) * 100 : 0;
    const volatility = Math.min(100, volPct * 800);

    // Breakout quality: posisi close terakhir relatif terhadap range 20 candle
    const lookback = candles.slice(-20);
    const rangeHigh = Math.max(...lookback.map(c => c.high));
    const rangeLow = Math.min(...lookback.map(c => c.low));
    const rangeSize = (rangeHigh - rangeLow) || 1;
    const posInRange = (lastClose - rangeLow) / rangeSize;
    const breakoutQuality = Math.min(100, Math.abs(posInRange - 0.5) * 200);

    // Volume: rata-rata volume terbaru vs rata-rata historis (jika tersedia)
    let volume = 50;
    const volumes = candles.map(c => c.volume).filter(v => v != null);
    if (volumes.length >= 10) {
      const recentAvg = this.sma(volumes, 5);
      const baseAvg = this.sma(volumes, volumes.length) || recentAvg;
      volume = Math.min(100, (recentAvg / (baseAvg || 1)) * 50);
    }

    // Spread score: makin kecil spread (relatif ke ATR), makin tinggi skor
    const spreadCost = spreadPips * pipValue;
    const spreadRatio = atr > 0 ? spreadCost / atr : 0.5;
    const spread = Math.max(0, 100 - spreadRatio * 200);

    // Momentum via RSI, dipetakan agar 50=netral -> 0, ekstrem -> 100
    const rsi = this.computeRSI(closes);
    const momentum = Math.min(100, Math.abs(rsi - 50) * 2);

    return {
      trendStrength: round1(trendStrength),
      marketStructure: round1(marketStructure),
      volatility: round1(volatility),
      breakoutQuality: round1(breakoutQuality),
      volume: round1(volume),
      spread: round1(spread),
      momentum: round1(momentum),
      atr
    };
  }
};

function round1(n) { return Math.round(n * 10) / 10; }

/**
 * ============================================================
 *  SYNTHETIC FEED — Mode Demo (tanpa API key, tanpa internet)
 *  Interface identik dengan TwelveDataFeed (fetchCandles /
 *  fetchQuote) supaya bisa saling dipertukarkan di app.js.
 *  Menghasilkan random-walk dengan regime trend/range bergantian
 *  agar TQI & ABRSEngine punya variasi kondisi untuk didemokan.
 * ============================================================
 */
const SyntheticFeed = {
  _state: null,

  _ensureState(symbol) {
    if (this._state && this._state.symbol === symbol) return this._state;
    const basePrice = symbol.includes('BTC') ? 65000 : symbol.includes('XAU') ? 2350 : symbol.includes('US30') ? 39000 : 1.085;
    const volUnit = basePrice * 0.0009;
    const candles = [];
    let price = basePrice;
    let regimeTicksLeft = 0;
    let regimeDrift = 0;
    const now = Date.now();
    for (let i = 200; i > 0; i--) {
      if (regimeTicksLeft <= 0) {
        regimeTicksLeft = 15 + Math.floor(Math.random() * 25);
        // 55% peluang regime RANGE (drift kecil), 45% TREND (drift lebih kuat searah)
        regimeDrift = Math.random() < 0.55 ? (Math.random() - 0.5) * volUnit * 0.15 : (Math.random() < 0.5 ? 1 : -1) * volUnit * 0.55;
      }
      regimeTicksLeft--;
      const open = price;
      const noise = (Math.random() - 0.5) * volUnit * 2;
      const close = open + regimeDrift + noise;
      const high = Math.max(open, close) + Math.random() * volUnit * 0.8;
      const low = Math.min(open, close) - Math.random() * volUnit * 0.8;
      const volume = 800 + Math.random() * 1200;
      candles.push({ time: new Date(now - i * 60000).toISOString(), open, high, low, close, volume });
      price = close;
    }
    this._state = { symbol, price, candles, regimeTicksLeft, regimeDrift, volUnit };
    return this._state;
  },

  async fetchCandles(symbol, interval, _apiKey, outputsize = 60) {
    const st = this._ensureState(symbol);
    await sleep(120); // simulasi latensi jaringan
    return st.candles.slice(-outputsize);
  },

  async fetchQuote(symbol, _apiKey) {
    const st = this._ensureState(symbol);
    await sleep(80);
    if (st.regimeTicksLeft <= 0) {
      st.regimeTicksLeft = 15 + Math.floor(Math.random() * 25);
      st.regimeDrift = Math.random() < 0.55
        ? (Math.random() - 0.5) * st.volUnit * 0.15
        : (Math.random() < 0.5 ? 1 : -1) * st.volUnit * 0.55;
    }
    st.regimeTicksLeft--;
    const noise = (Math.random() - 0.5) * st.volUnit * 2.2;
    st.price = st.price + st.regimeDrift + noise;

    // Geser jendela candle: tambah candle baru tiap beberapa quote agar ATR/TQI tetap relevan
    const lastCandle = st.candles.at(-1);
    lastCandle.close = st.price;
    lastCandle.high = Math.max(lastCandle.high, st.price);
    lastCandle.low = Math.min(lastCandle.low, st.price);
    if (Math.random() < 0.2) {
      st.candles.push({
        time: new Date().toISOString(),
        open: st.price, high: st.price, low: st.price, close: st.price,
        volume: 800 + Math.random() * 1200
      });
      if (st.candles.length > 250) st.candles.shift();
    }
    return st.price;
  },

  reset() { this._state = null; }
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TwelveDataFeed, MarketAnalytics, SyntheticFeed };
}
if (typeof window !== 'undefined') {
  window.TwelveDataFeed = TwelveDataFeed;
  window.MarketAnalytics = MarketAnalytics;
  window.SyntheticFeed = SyntheticFeed;
}
