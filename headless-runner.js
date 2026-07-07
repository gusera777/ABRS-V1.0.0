#!/usr/bin/env node
/**
 * ============================================================
 *  ABRS HEADLESS RUNNER — jalan independen dari browser
 * ============================================================
 *
 *  KENAPA INI ADA:
 *  JavaScript di dalam tab browser (app.js + index.html) TIDAK BISA
 *  terus berjalan begitu tab/browser-nya ditutup — itu batasan
 *  sandboxing browser sendiri, bukan sesuatu yang bisa "diperbaiki"
 *  lewat kode apa pun. Supaya sistem betul-betul tetap trading walau
 *  aplikasi/browser Anda tertutup, logic yang sama (ABRSEngine +
 *  price feed) dijalankan di sini sebagai proses Node.js terpisah,
 *  di komputer/server yang Anda biarkan tetap menyala.
 *
 *  CARA PAKAI:
 *    1. Install Node.js 18+ (butuh global fetch bawaan Node).
 *    2. Salin headless-config.example.json -> headless-config.json,
 *       isi apiKey Twelve Data & parameter lain (atau biarkan default
 *       demo:true untuk coba pakai data simulasi dulu).
 *    3. Jalankan:  node headless-runner.js
 *       Supaya tetap jalan setelah terminal ditutup / reboot, pakai
 *       process manager, misalnya:
 *         pm2 start headless-runner.js --name abrs
 *       atau di Linux dengan nohup:
 *         nohup node headless-runner.js > abrs.log 2>&1 &
 *       atau daftarkan sebagai systemd service / scheduled task.
 *    4. Riwayat cycle & event otomatis tersimpan ke headless-store.json
 *       di folder yang sama. Buka index.html di browser kapan saja,
 *       lalu di modal Pengaturan klik "Import dari Headless Runner"
 *       dan pilih file headless-store.json ini untuk melihat riwayat
 *       trading yang terjadi selagi aplikasi tidak dibuka.
 *
 *  CATATAN: proses Node ini sendiri tetap harus "menyala" di suatu
 *  tempat (komputer Anda tidak boleh mati total, atau pakai
 *  VPS/server kecil) — tidak ada cara membuat kode berjalan tanpa
 *  ada proses apa pun yang mengeksekusinya.
 * ============================================================
 */

const fs = require('fs');
const path = require('path');
const ABRSEngine = require('./abrs-engine.js');
const { TwelveDataFeed, MarketAnalytics, SyntheticFeed } = require('./price-feed.js');

const CONFIG_PATH = path.join(__dirname, 'headless-config.json');
const STORE_PATH = path.join(__dirname, 'headless-store.json');

const DEFAULT_CONFIG = {
  demo: true,                // true = SyntheticFeed (tanpa API key/internet), false = TwelveDataFeed
  apiKey: '',
  symbol: 'XAU/USD',
  interval: '5min',
  capital: 10000,
  globalRiskPct: 0.15,
  basketStopLossPct: 0.6,
  enableSafetyNet: true,
  lotStart: 0.10,
  distancePoints: 300,
  pointSize: 0.01,
  maxBuy: 10,
  maxSell: 10,
  basketTargetPct: 0.01,
  enableProfitLock: true,
  profitLockActivateUsd: 50,
  profitLockValueUsd: 30,
  spreadPips: 2,
  commissionPerLot: 3.5,
  swapPerTick: 0,
  pipValue: 1,
  tqiWeights: {
    trendStrength: 0.25, marketStructure: 0.20, volatility: 0.15,
    breakoutQuality: 0.15, volume: 0.10, spread: 0.05, momentum: 0.10
  },
  quotePollMs: 10000,
  candlePollMs: 60000,
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.log(`[init] ${CONFIG_PATH} belum ada — dibuat dengan nilai default (mode demo). Edit file ini lalu jalankan ulang untuk mode live.`);
    return { ...DEFAULT_CONFIG };
  }
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (e) {
    console.error(`[init] Gagal parse ${CONFIG_PATH}, pakai default. Error: ${e.message}`);
    return { ...DEFAULT_CONFIG };
  }
}

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) return { history: [], events: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return { history: raw.history || [], events: raw.events || [] };
  } catch (e) {
    console.error(`[store] Gagal baca ${STORE_PATH}, mulai dari kosong. Error: ${e.message}`);
    return { history: [], events: [] };
  }
}

let saveTimer = null;
function saveStoreDebounced() {
  // Debounce supaya tidak menulis file di setiap tick harga — cukup beberapa detik setelah perubahan terakhir.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const capped = {
      history: store.history.slice(-200),
      events: store.events.slice(-1000),
      savedAt: Date.now(),
    };
    fs.writeFileSync(STORE_PATH, JSON.stringify(capped, null, 2));
  }, 2000);
}
function saveStoreNow() {
  clearTimeout(saveTimer);
  fs.writeFileSync(STORE_PATH, JSON.stringify({
    history: store.history.slice(-200), events: store.events.slice(-1000), savedAt: Date.now(),
  }, null, 2));
}

// ---------------------------------------------------------------
const config = loadConfig();
const store = loadStore();
const feed = config.demo ? SyntheticFeed : TwelveDataFeed;

if (!config.demo && !config.apiKey) {
  console.error(`[fatal] Mode live butuh apiKey Twelve Data. Isi "apiKey" di ${CONFIG_PATH}, atau set "demo": true untuk coba dulu tanpa API key.`);
  process.exit(1);
}

function buildEngineConfig(c) {
  return {
    capital: c.capital, globalRiskPct: c.globalRiskPct, basketStopLossPct: c.basketStopLossPct,
    enableSafetyNet: c.enableSafetyNet, initialLot: c.lotStart, distancePoints: c.distancePoints,
    pointSize: c.pointSize, maxBuy: c.maxBuy, maxSell: c.maxSell, basketTargetPct: c.basketTargetPct,
    enableProfitLock: c.enableProfitLock, profitLockActivateUsd: c.profitLockActivateUsd,
    profitLockValueUsd: c.profitLockValueUsd,
    tqiWeights: c.tqiWeights,
  };
}

let engine = new ABRSEngine(buildEngineConfig(config));
let lastFlushedCycleId = null; // sama seperti fix di app.js — jangan pakai cycleId aktif sebagai nilai awal
let lastCandles = [];
let lastAtr = null;
let lastTqiComponents = null;
let costsAccum = 0;

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function applyEntryCosts(positionsBefore) {
  const beforeIds = new Set(positionsBefore.map(p => p.id));
  const newPositions = engine.positions.filter(p => !beforeIds.has(p.id));
  for (const p of newPositions) {
    const cost = (config.commissionPerLot * p.lot) + (config.spreadPips * config.pipValue * p.lot);
    costsAccum += cost;
  }
}

function pullEventsToLog() {
  const evts = engine.exportEvents();
  const seen = new Set(store.events.map(e => e.cycleId + '|' + e.timestamp + '|' + e.event + '|' + (e.orderId || '')));
  let added = 0;
  for (const e of evts) {
    const key = e.cycleId + '|' + e.timestamp + '|' + e.event + '|' + (e.orderId || '');
    if (!seen.has(key)) { store.events.push(e); seen.add(key); added++; }
  }
  if (added) saveStoreDebounced();
}

function flushClosedCycle() {
  const rec = engine.exportCycleRecord();
  store.history.push(rec);
  lastFlushedCycleId = engine.cycle.cycleId;
  saveStoreNow(); // langsung tulis (bukan debounce) supaya cycle yang baru closed pasti tersimpan
  log(`CYCLE CLOSED — result=${rec.result} basketProfit=${rec.basketProfit?.toFixed(2)} recoveryCount=${rec.recoveryCount} cycleId=${rec.cycleId.slice(-8)}`);
}

async function refreshCandlesAndMaybeStartCycle() {
  try {
    const candles = await feed.fetchCandles(config.symbol, config.interval, config.apiKey, 60);
    lastCandles = candles;
    lastAtr = MarketAnalytics.computeATR(candles) ?? (candles.at(-1).close * 0.001);
    lastTqiComponents = MarketAnalytics.deriveTQIComponents(candles, config.spreadPips, config.pipValue);

    if (engine.cycle.status === 'IDLE' || engine.cycle.status === 'CLOSED') {
      if (engine.cycle.status === 'CLOSED') {
        if (engine.cycle.cycleId !== lastFlushedCycleId) flushClosedCycle(); // jaring pengaman, sama seperti app.js
        engine.startNewCycleAfterClose();
      }
      costsAccum = 0;
      const entryPrice = candles.at(-1).close;
      const positionsBeforeEntry = [...engine.positions];
      const result = engine.startCycle(lastTqiComponents, lastCandles, lastAtr, entryPrice);
      applyEntryCosts(positionsBeforeEntry);
      pullEventsToLog();
      if (result.started) {
        log(`CYCLE START — direction=${result.direction} tqi=${result.tqi?.toFixed(1)} mode=${result.mode} target=${result.basketTarget?.toFixed(2)}`);
      } else {
        log(`CYCLE NOT STARTED — reason=${result.reason}`);
      }
    }
    return true;
  } catch (err) {
    log(`ERROR refreshCandles: ${err.message}`);
    return false;
  }
}

async function pollQuoteTick() {
  try {
    const price = await feed.fetchQuote(config.symbol, config.apiKey);
    handleTick(price);
  } catch (err) {
    log(`ERROR pollQuote: ${err.message}`);
  }
}

function handleTick(price) {
  if (engine.tradingDisabled) return;

  const positionsBeforePending = [...engine.positions];
  engine.checkPendingOrders(price);
  applyEntryCosts(positionsBeforePending);

  const openCount = engine.positions.filter(p => p.status !== 'CLOSED').length;
  const swapTotal = openCount * config.swapPerTick;

  engine.updateFloating(price, config.pipValue, swapTotal, costsAccum);

  if (config.enableSafetyNet) engine.checkGlobalRisk();
  engine.checkProfitLock();
  engine.checkBasketTarget();

  pullEventsToLog();

  if (engine.cycle.status === 'CLOSED' && engine.cycle.cycleId !== lastFlushedCycleId) {
    flushClosedCycle();
  }
}

// ---------------------------------------------------------------
// SHUTDOWN BERSIH — simpan state terakhir sebelum proses mati
// ---------------------------------------------------------------
function shutdown(signal) {
  log(`Menerima ${signal}, menyimpan state & keluar…`);
  saveStoreNow();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack || err.message}`);
  saveStoreNow();
});

// ---------------------------------------------------------------
// START
// ---------------------------------------------------------------
log(`ABRS Headless Runner start — symbol=${config.symbol} interval=${config.interval} mode=${config.demo ? 'DEMO' : 'LIVE'} initialLot=${config.lotStart}`);
refreshCandlesAndMaybeStartCycle().then(() => {
  setInterval(pollQuoteTick, config.quotePollMs);
  setInterval(refreshCandlesAndMaybeStartCycle, config.candlePollMs);
  log(`Polling aktif — quote tiap ${config.quotePollMs}ms, candle tiap ${config.candlePollMs}ms. Tekan Ctrl+C untuk berhenti.`);
});
