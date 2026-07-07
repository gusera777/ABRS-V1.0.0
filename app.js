/**
 * ============================================================
 *  GUSERA SATS — ABRS Console — app.js
 *  Menjembatani ABRSEngine (abrs-engine.js) + price feed
 *  Twelve Data (price-feed.js) dengan UI di index.html.
 *
 *  Catatan desain:
 *  - Semua state disimpan di localStorage (settings, riwayat
 *    cycle, log trade_event) karena ini murni client-side.
 *  - Biaya (spread & komisi) diterapkan sebagai deduksi
 *    langsung saat posisi dibuka (simplifikasi), lalu
 *    diteruskan ke ABRSEngine.updateFloating() sebagai
 *    parameter `commission` agregat per cycle.
 * ============================================================
 */

const LS_SETTINGS = 'gusera_sats_settings_v1';
const LS_HISTORY  = 'gusera_sats_history_v1';
const LS_EVENTS   = 'gusera_sats_events_v1';

const DEFAULT_SETTINGS = {
  capital: 10000,
  apiKey: '', // JANGAN hardcode API key pribadi di source — isi lewat modal Pengaturan, tersimpan hanya di localStorage
  globalRiskPct: 0.15,
  basketStopLossPct: 0.6,
  enableSafetyNet: true,
  lotStart: 0.10,            // Lot Level 1 (Initial Lot)
  distancePoints: 300,       // Jarak antar level (point)
  pointSize: 0.01,           // Nilai harga 1 point (sesuaikan per instrumen)
  maxBuy: 10,
  maxSell: 10,
  basketTargetPct: 0.01,     // 1% Equity
  enableProfitLock: true,     // Kunci Profit / BE+
  profitLockActivateUsd: 50,  // ARM begitu profit berjalan capai $ ini
  profitLockValueUsd: 30,     // Level profit yang dikunci (BE+) saat ter-ARM
  spreadPips: 2,
  commissionPerLot: 3.5,
  swapPerTick: 0,
  pipValue: 1,
  tqiWeights: {
    trendStrength: 0.25,
    marketStructure: 0.20,
    volatility: 0.15,
    breakoutQuality: 0.15,
    volume: 0.10,
    spread: 0.05,
    momentum: 0.10
  }
};

const QUOTE_POLL_MS = 10000;   // polling harga tiap 10s (hemat kuota API gratis)
const CANDLE_POLL_MS = 60000;  // refresh candle/ATR/TQI tiap 60s
const DEMO_QUOTE_POLL_MS = 1500;   // mode demo: lebih cepat supaya enak didemokan
const DEMO_CANDLE_POLL_MS = 15000;

let isDemoMode = false;
let activeFeed = TwelveDataFeed;

// ---------------------------------------------------------------
// STATE
// ---------------------------------------------------------------
let settings = loadSettings();
let engine = new ABRSEngine(buildEngineConfig(settings));
let history = loadHistory();
let eventLog = loadEvents();

let feedRunning = false;
let quoteTimer = null;
let candleTimer = null;
let lastCandles = [];
let lastAtr = null;
let lastTqiComponents = null;
let lastRange = null; // { resistance, support, rangeWidth } dari cycle berjalan, untuk digambar di chart
let lastFlushedCycleId = null; // cycleId terakhir yang SUDAH tersimpan ke riwayat (trading_cycle) — null = belum ada
let costsAccum = 0; // total biaya (komisi+spread) yang sudah dipotong pada cycle berjalan

// ---------------------------------------------------------------
// PERSISTENCE HELPERS
// ---------------------------------------------------------------
function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings() { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); }

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(LS_HISTORY) || '[]'); } catch { return []; }
}
function saveHistory() {
  const capped = history.slice(-200);
  localStorage.setItem(LS_HISTORY, JSON.stringify(capped));
}

function loadEvents() {
  try { return JSON.parse(localStorage.getItem(LS_EVENTS) || '[]'); } catch { return []; }
}
function saveEvents() {
  const capped = eventLog.slice(-1000);
  localStorage.setItem(LS_EVENTS, JSON.stringify(capped));
}

function buildEngineConfig(s) {
  return {
    capital: s.capital,
    globalRiskPct: s.globalRiskPct,
    basketStopLossPct: s.basketStopLossPct,
    enableSafetyNet: s.enableSafetyNet,
    initialLot: s.lotStart,
    distancePoints: s.distancePoints,
    pointSize: s.pointSize,
    maxBuy: s.maxBuy,
    maxSell: s.maxSell,
    basketTargetPct: s.basketTargetPct,
    enableProfitLock: s.enableProfitLock,
    profitLockActivateUsd: s.profitLockActivateUsd,
    profitLockValueUsd: s.profitLockValueUsd,
    tqiWeights: s.tqiWeights
  };
}

// ---------------------------------------------------------------
// FORMAT HELPERS
// ---------------------------------------------------------------
const fmtMoney = n => (n < 0 ? '-$' : '$') + Math.abs(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = n => (n ?? 0).toFixed(2) + '%';
const shortId = id => (id || '—').toString().slice(-8);
const fmtTime = ts => new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDate = ts => new Date(ts).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

// Klasifikasi WIN/LOSS untuk statistik & badge. WIN biasa dan LOCKED_PROFIT
// (kunci profit/BE+ tersentuh) selalu dihitung WIN (basketProfit-nya pasti >= 0
// saat ditutup). MANUAL (tombol Close All Manual) diklasifikasikan berdasarkan
// tanda basketProfit saat itu, karena bisa ditutup dalam kondisi profit atau rugi.
function isWinCycle(h) {
  if (h.result === 'WIN' || h.result === 'LOCKED_PROFIT') return true;
  if (h.result === 'MANUAL') return (h.basketProfit || 0) >= 0;
  return false;
}
function isLossCycle(h) {
  if (h.result === 'LOSS' || h.result === 'EMERGENCY') return true;
  if (h.result === 'MANUAL') return (h.basketProfit || 0) < 0;
  return false;
}

// ---------------------------------------------------------------
// DOM REFERENCES
// ---------------------------------------------------------------
const $ = id => document.getElementById(id);

const el = {
  feedDot: $('feedDot'), feedLabel: $('feedLabel'), btnToggleFeed: $('btnToggleFeed'),
  symbolSelect: $('symbolSelect'), intervalSelect: $('intervalSelect'),
  cycleStatusBadge: $('cycleStatusBadge'), cycleIdShort: $('cycleIdShort'),
  basketPnl: $('basketPnl'), basketPnlPct: $('basketPnlPct'), basketMeta: $('basketMeta'),
  basketTargetFill: $('basketTargetFill'), basketTargetLabel: $('basketTargetLabel'),
  riskFill: $('riskFill'), riskLabel: $('riskLabel'),
  recoveryBadge: $('recoveryBadge'), maxLotBadge: $('maxLotBadge'), ddBadge: $('ddBadge'),
  profitLockBadge: $('profitLockBadge'), btnCloseAllManual: $('btnCloseAllManual'),
  chainRow: $('chainRow'),
  tqiArc: $('tqiArc'), tqiValue: $('tqiValue'), tqiClass: $('tqiClass'), tqiModeBadge: $('tqiModeBadge'),
  tqiComponents: $('tqiComponents'),
  statGridTop: $('statGridTop'), statGridBottom: $('statGridBottom'),
  positionsList: $('positionsList'), positionsCountBadge: $('positionsCountBadge'), pendingList: $('pendingList'),
  rsCapital: $('rsCapital'), rsEquity: $('rsEquity'), rsGlobalRisk: $('rsGlobalRisk'),
  rsRecoveryBudget: $('rsRecoveryBudget'), rsFloatingBudget: $('rsFloatingBudget'), rsLot: $('rsLot'),
  rsSpread: $('rsSpread'), rsCommission: $('rsCommission'), rsPipValue: $('rsPipValue'),
  aiInsights: $('aiInsights'), tqiBandStats: $('tqiBandStats'),
  cycleHistBody: $('cycleHistBody'), cycleHistCount: $('cycleHistCount'),
  eventBody: $('eventBody'), eventCount: $('eventCount'),
  settingsModal: $('settingsModal'), settingsForm: $('settingsForm')
};

// ---------------------------------------------------------------
// FEED CONTROL
// ---------------------------------------------------------------
const el_demoToggle = $('demoModeToggle');
el_demoToggle.addEventListener('change', () => {
  isDemoMode = el_demoToggle.checked;
  activeFeed = isDemoMode ? SyntheticFeed : TwelveDataFeed;
  el.symbolSelect.disabled = isDemoMode ? false : false; // simbol tetap bisa dipilih di demo
  if (feedRunning) { stopFeed(); startFeed(); }
});

el.btnToggleFeed.addEventListener('click', () => {
  if (feedRunning) stopFeed(); else startFeed();
});
[el.symbolSelect, el.intervalSelect].forEach(s => s.addEventListener('change', () => {
  if (feedRunning) { stopFeed(); startFeed(); }
}));

async function startFeed() {
  if (!isDemoMode && !settings.apiKey) {
    alert('Masukkan Twelve Data API Key di Pengaturan, atau aktifkan Mode Demo untuk mencoba tanpa API key.');
    openSettings();
    return;
  }
  feedRunning = true;
  setFeedStatus('paused', isDemoMode ? 'MENYIAPKAN DATA SIMULASI…' : 'MENGHUBUNGKAN…');
  el.btnToggleFeed.textContent = 'Hentikan Feed';

  const ok = await refreshCandlesAndMaybeStartCycle();
  if (!ok) { feedRunning = false; el.btnToggleFeed.textContent = 'Mulai Feed'; return; }

  setFeedStatus('live', isDemoMode ? 'DEMO LIVE (DATA SIMULASI)' : 'FEED LIVE');
  const qMs = isDemoMode ? DEMO_QUOTE_POLL_MS : QUOTE_POLL_MS;
  const cMs = isDemoMode ? DEMO_CANDLE_POLL_MS : CANDLE_POLL_MS;
  quoteTimer = setInterval(pollQuoteTick, qMs);
  candleTimer = setInterval(refreshCandlesAndMaybeStartCycle, cMs);
}

function stopFeed() {
  feedRunning = false;
  clearInterval(quoteTimer); clearInterval(candleTimer);
  quoteTimer = null; candleTimer = null;
  setFeedStatus('off', 'FEED OFFLINE');
  el.btnToggleFeed.textContent = 'Mulai Feed';
}

function setFeedStatus(mode, label) {
  el.feedDot.className = 'dot ' + mode;
  el.feedLabel.textContent = label;
}

async function refreshCandlesAndMaybeStartCycle() {
  try {
    const symbol = el.symbolSelect.value;
    const interval = el.intervalSelect.value;
    const candles = await activeFeed.fetchCandles(symbol, interval, settings.apiKey, 60);
    lastCandles = candles;
    lastAtr = MarketAnalytics.computeATR(candles) ?? (candles.at(-1).close * 0.001);
    lastTqiComponents = MarketAnalytics.deriveTQIComponents(candles, settings.spreadPips, settings.pipValue);

    renderTQIOnly();

    if (engine.cycle.status === 'IDLE' || engine.cycle.status === 'CLOSED') {
      if (engine.cycle.status === 'CLOSED') {
        // Jaring pengaman: pastikan cycle yang closed sudah ter-flush ke riwayat
        // SEBELUM di-reset (data cycle lama hilang begitu resetCycle() dipanggil).
        if (engine.cycle.cycleId !== lastFlushedCycleId) flushClosedCycle();
        engine.startNewCycleAfterClose();
      }
      costsAccum = 0;
      lastRange = null;
      const entryPrice = candles.at(-1).close;
      const positionsBeforeEntry = [...engine.positions];
      const result = engine.startCycle(lastTqiComponents, lastCandles, lastAtr, entryPrice);
      applyEntryCosts(positionsBeforeEntry);
      pullEventsToLog();
      if (!result.started) {
        setFeedStatus('paused', `MENUNGGU DATA (${result.reason})`);
      } else {
        setFeedStatus('live', 'FEED LIVE');
      }
    }
    renderAll();
    return true;
  } catch (err) {
    console.error(err);
    setFeedStatus('off', 'ERROR: ' + err.message);
    return false;
  }
}

async function pollQuoteTick() {
  try {
    const symbol = el.symbolSelect.value;
    const price = await activeFeed.fetchQuote(symbol, settings.apiKey);
    handleTick(price);
    renderAll();
  } catch (err) {
    console.error(err);
    setFeedStatus('paused', 'GAGAL AMBIL HARGA — RETRY…');
  }
}

/**
 * Reimplementasi onPriceTick milik ABRSEngine, tapi dengan
 * parameter biaya (pipValue, swap, commission) sesuai Settingan
 * pengguna, bukan default engine (1, 0, 0).
 */
function handleTick(price) {
  if (engine.tradingDisabled) return;

  const positionsBeforePending = [...engine.positions];
  engine.checkPendingOrders(price);
  applyEntryCosts(positionsBeforePending);

  const openCount = engine.positions.filter(p => p.status !== 'CLOSED').length;
  const swapTotal = openCount * settings.swapPerTick;

  engine.updateFloating(price, settings.pipValue, swapTotal, costsAccum);

  if (settings.enableSafetyNet) engine.checkGlobalRisk();
  engine.checkProfitLock();
  engine.checkBasketTarget();

  pullEventsToLog();

  if (engine.cycle.status === 'CLOSED' && engine.cycle.cycleId !== lastFlushedCycleId) {
    flushClosedCycle();
  }
}

/**
 * Tombol "Close All Manual" - user menutup basket kapan saja, terlepas
 * dari basket target / kunci profit. Setelah ditutup: flush ke riwayat,
 * cycle direset (tidak ada posisi), dan jika feed sedang berjalan,
 * langsung coba mulai cycle baru dari Level 1 memakai candle terakhir.
 */
async function handleManualCloseAll() {
  const result = engine.closeBasketManual();
  if (!result.closed) {
    if (result.reason === 'NO_OPEN_POSITIONS') alert('Tidak ada posisi/pending order yang sedang berjalan untuk ditutup.');
    else if (result.reason === 'NO_ACTIVE_CYCLE') alert('Belum ada cycle yang berjalan.');
    return;
  }

  pullEventsToLog();
  if (engine.cycle.cycleId !== lastFlushedCycleId) flushClosedCycle();

  engine.startNewCycleAfterClose();
  costsAccum = 0;
  lastRange = null;

  renderAll();

  if (feedRunning && lastCandles.length) {
    await refreshCandlesAndMaybeStartCycle();
  }
}

function applyEntryCosts(positionsBefore) {
  const beforeIds = new Set(positionsBefore.map(p => p.id));
  const newPositions = engine.positions.filter(p => !beforeIds.has(p.id));
  for (const p of newPositions) {
    const cost = (settings.commissionPerLot * p.lot) + (settings.spreadPips * settings.pipValue * p.lot);
    costsAccum += cost;
  }
}

function pullEventsToLog() {
  const evts = engine.exportEvents();
  // Merge event baru dari engine (per-cycle) ke log persisten, hindari duplikat
  const seen = new Set(eventLog.map(e => e.cycleId + '|' + e.timestamp + '|' + e.event + '|' + (e.orderId || '')));
  for (const e of evts) {
    const key = e.cycleId + '|' + e.timestamp + '|' + e.event + '|' + (e.orderId || '');
    if (!seen.has(key)) { eventLog.push(e); seen.add(key); }
  }
  saveEvents();
}

function flushClosedCycle() {
  history.push(engine.exportCycleRecord());
  saveHistory();
  lastFlushedCycleId = engine.cycle.cycleId;
}

// ---------------------------------------------------------------
// RENDER: TOP-LEVEL DISPATCH
// ---------------------------------------------------------------
function renderAll() {
  renderBasket();
  renderTQIOnly();
  renderPriceChart();
  renderStats();
  renderPositions();
  renderRiskSummary();
  renderChain();
  renderCycleHistoryTable();
  renderEventTable();
  renderAIInsights();
  renderTQIBandStats();
}

function renderBasket() {
  const c = engine.cycle;
  el.cycleStatusBadge.textContent = c.status;
  el.cycleStatusBadge.className = 'badge ' + (c.status === 'CLOSED' ? (isWinCycle(c) ? 'badge-pos' : (c.result === 'EMERGENCY' ? 'badge-gold' : 'badge-neg')) : 'badge-gold');
  el.cycleIdShort.textContent = shortId(c.cycleId);

  const pnl = c.basketProfit || 0;
  el.basketPnl.textContent = fmtMoney(pnl);
  el.basketPnl.className = 'basket-pnl ' + (pnl >= 0 ? 'pos' : 'neg');
  const pnlPct = c.equityStart ? (pnl / c.equityStart) * 100 : 0;
  el.basketPnlPct.textContent = fmtPct(pnlPct) + ' dari equity cycle';

  el.basketMeta.textContent = `Mode pasar: ${c.marketMode ?? '—'} · BUY ${c.buyLevel}/${engine.config.maxBuy} · SELL ${c.sellLevel}/${engine.config.maxSell} · Target: ${c.basketTarget ? fmtMoney(c.basketTarget) : '—'}`;

  const targetPct = c.basketTarget ? Math.max(0, Math.min(100, (pnl / c.basketTarget) * 100)) : 0;
  el.basketTargetFill.style.width = targetPct + '%';
  el.basketTargetLabel.textContent = `${fmtMoney(pnl)} / ${fmtMoney(c.basketTarget || 0)}`;

  const riskUsedPct = engine.globalRiskBudget ? Math.max(0, Math.min(100, (Math.max(0, -pnl) / engine.globalRiskBudget) * 100)) : 0;
  el.riskFill.style.width = riskUsedPct + '%';
  el.riskLabel.textContent = `${fmtMoney(Math.max(0, -pnl))} / ${fmtMoney(engine.globalRiskBudget)}`;

  el.recoveryBadge.textContent = `Level: ${c.recoveryCount + 1}x`;
  el.maxLotBadge.textContent = `Max Lot: ${c.maxLotUsed.toFixed(2)}`;
  el.ddBadge.textContent = `Max DD: ${fmtMoney(c.maxDrawdown)}`;

  if (el.profitLockBadge) {
    if (!settings.enableProfitLock) {
      el.profitLockBadge.textContent = 'Kunci Profit: Nonaktif';
      el.profitLockBadge.className = 'badge';
    } else if (c.profitLockArmed && c.status !== 'CLOSED') {
      el.profitLockBadge.textContent = `Kunci Profit: ARMED @ ${fmtMoney(settings.profitLockValueUsd)}`;
      el.profitLockBadge.className = 'badge badge-pos';
    } else {
      el.profitLockBadge.textContent = `Kunci Profit: menunggu ${fmtMoney(settings.profitLockActivateUsd)}`;
      el.profitLockBadge.className = 'badge badge-info';
    }
  }

  if (el.btnCloseAllManual) {
    const hasSomethingToClose = engine.positions.some(p => p.status !== 'CLOSED') || engine.pendingOrders.length > 0;
    el.btnCloseAllManual.disabled = !hasSomethingToClose;
  }
}

function renderTQIOnly() {
  if (!lastTqiComponents) return;
  const tqi = engine.computeTQI(lastTqiComponents);
  const cls = engine.classifyTQI(tqi);
  const mode = engine.getMarketMode(tqi);

  const circumference = 226;
  const offset = circumference * (1 - tqi / 100);
  el.tqiArc.setAttribute('stroke-dashoffset', offset.toFixed(1));
  el.tqiValue.textContent = Math.round(tqi);
  el.tqiClass.textContent = cls;
  el.tqiModeBadge.textContent = mode;
  el.tqiModeBadge.className = 'badge ' + (mode === 'TREND' ? 'badge-info' : 'badge-gold');

  const labels = {
    trendStrength: 'Trend Strength', marketStructure: 'Market Structure', volatility: 'Volatility',
    breakoutQuality: 'Breakout Qual.', volume: 'Volume', spread: 'Spread', momentum: 'Momentum'
  };
  el.tqiComponents.innerHTML = Object.entries(labels).map(([key, label]) => {
    const v = lastTqiComponents[key] ?? 0;
    return `<div class="tqi-comp-row">
      <span class="tqi-comp-label">${label}</span>
      <div class="tqi-comp-track"><div class="tqi-comp-fill" style="width:${v}%"></div></div>
      <span class="tqi-comp-val">${Math.round(v)}</span>
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------
// PRICE CHART (candlestick ringan, canvas 2D, tanpa library luar)
// Menampilkan: candle harga, garis Resistance/Support (range aktif),
// level Pending Order (BUY_STOP/SELL_STOP), dan marker ENTRY tiap posisi
// (segitiga hijau = BUY, merah = SELL; outline abu-abu = LOCKED).
// ---------------------------------------------------------------
function renderPriceChart() {
  const canvas = $('priceChart');
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  const cssH = canvas.clientHeight || 260;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (!lastCandles.length) {
    ctx.fillStyle = '#565d68';
    ctx.font = '12px monospace';
    ctx.fillText('Menunggu data candle… mulai feed untuk melihat grafik.', 14, cssH / 2);
    return;
  }

  const candles = lastCandles.slice(-90);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  let maxP = Math.max(...highs);
  let minP = Math.min(...lows);

  const activePositions = engine.positions.filter(p => p.status !== 'CLOSED');
  const overlayPrices = [];
  if (lastRange) overlayPrices.push(lastRange.resistance, lastRange.support);
  engine.pendingOrders.forEach(po => overlayPrices.push(po.triggerPrice));
  activePositions.forEach(p => overlayPrices.push(p.entryPrice));
  overlayPrices.forEach(p => { if (p > maxP) maxP = p; if (p < minP) minP = p; });

  const pad = (maxP - minP) * 0.10 || maxP * 0.001 || 1;
  maxP += pad; minP -= pad;

  const padLeft = 58, padRight = 12, padTop = 10, padBottom = 8;
  const w = Math.max(10, cssW - padLeft - padRight);
  const h = Math.max(10, cssH - padTop - padBottom);
  const xAt = i => padLeft + (candles.length > 1 ? (i / (candles.length - 1)) * w : w / 2);
  const yAt = p => padTop + (1 - (p - minP) / ((maxP - minP) || 1)) * h;
  const decimals = maxP >= 100 ? 2 : (maxP >= 1 ? 4 : 5);

  // grid horizontal + label harga
  ctx.font = '10px var(--font-mono, monospace)';
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.fillStyle = '#565d68';
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const p = minP + (maxP - minP) * i / steps;
    const y = yAt(p);
    ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(cssW - padRight, y); ctx.stroke();
    ctx.fillText(p.toFixed(decimals), 2, y + 3);
  }

  // candlesticks
  const cw = Math.max(1.5, (w / candles.length) * 0.55);
  candles.forEach((c, i) => {
    const x = xAt(i);
    const up = c.close >= c.open;
    ctx.strokeStyle = up ? 'var(--positive, #3ecf8e)' : 'var(--negative, #ff5c5c)';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, yAt(c.high)); ctx.lineTo(x, yAt(c.low)); ctx.stroke();
    const yO = yAt(c.open), yC = yAt(c.close);
    ctx.fillRect(x - cw / 2, Math.min(yO, yC), cw, Math.max(1, Math.abs(yC - yO)));
  });

  // garis Resistance / Support dari range aktif
  if (lastRange) {
    drawDashedHLine(ctx, yAt(lastRange.resistance), padLeft, cssW - padRight, '#f2a93b');
    drawDashedHLine(ctx, yAt(lastRange.support), padLeft, cssW - padRight, '#f2a93b');
    ctx.fillStyle = '#f2a93b';
    ctx.fillText('Resistance', cssW - padRight - 62, yAt(lastRange.resistance) - 3);
    ctx.fillText('Support', cssW - padRight - 62, yAt(lastRange.support) + 11);
  }

  // level pending order
  engine.pendingOrders.forEach(po => {
    const y = yAt(po.triggerPrice);
    const color = po.side === 'BUY' ? 'rgba(62,207,142,0.55)' : 'rgba(255,92,92,0.55)';
    drawDashedHLine(ctx, y, padLeft, cssW - padRight, color);
  });

  // marker ENTRY untuk tiap posisi (aktif & terkunci)
  const times = candles.map(c => new Date(c.time).getTime());
  activePositions.forEach(p => {
    let idx = times.length - 1, best = Infinity;
    for (let i = 0; i < times.length; i++) {
      const d = Math.abs(times[i] - p.openTime);
      if (d < best) { best = d; idx = i; }
    }
    const x = xAt(idx);
    const y = yAt(p.entryPrice);
    ctx.fillStyle = p.side === 'BUY' ? 'var(--positive, #3ecf8e)' : 'var(--negative, #ff5c5c)';
    ctx.beginPath();
    if (p.side === 'BUY') { ctx.moveTo(x, y - 8); ctx.lineTo(x - 6, y + 4); ctx.lineTo(x + 6, y + 4); }
    else { ctx.moveTo(x, y + 8); ctx.lineTo(x - 6, y - 4); ctx.lineTo(x + 6, y - 4); }
    ctx.closePath(); ctx.fill();
    if (p.status === 'LOCKED') {
      ctx.strokeStyle = '#909aa8'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.fillStyle = '#e9e7e2';
    ctx.font = '9px var(--font-mono, monospace)';
    ctx.fillText(`${p.lot.toFixed(2)}`, x + 8, y + 3);
  });

  // garis harga saat ini
  const lastClose = candles.at(-1).close;
  const yLast = yAt(lastClose);
  drawDashedHLine(ctx, yLast, padLeft, cssW - padRight, '#e9e7e2');
  ctx.fillStyle = '#e9e7e2';
  ctx.font = '10px var(--font-mono, monospace)';
  ctx.fillText(lastClose.toFixed(decimals), cssW - padRight - 46, yLast - 4);
}

function drawDashedHLine(ctx, y, x1, x2, color) {
  ctx.save();
  ctx.setLineDash([5, 3]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
  ctx.restore();
}

window.addEventListener('resize', () => { if (lastCandles.length) renderPriceChart(); });

function renderStats() {
  const closed = history.filter(h => h.result);
  const wins = closed.filter(isWinCycle);
  const losses = closed.filter(isLossCycle);
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
  const totalPnl = closed.reduce((s, h) => s + (h.basketProfit || 0), 0);
  const grossWin = wins.reduce((s, h) => s + Math.max(0, h.basketProfit || 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, h) => s + Math.min(0, h.basketProfit || 0), 0));
  const profitFactor = grossLoss > 0 ? (grossWin / grossLoss) : (grossWin > 0 ? Infinity : 0);
  const currentEquity = closed.length ? closed.at(-1).equityEnd : settings.capital;
  const growthPct = ((currentEquity - settings.capital) / settings.capital) * 100;
  const avgRecovery = closed.length ? closed.reduce((s, h) => s + h.recoveryCount, 0) / closed.length : 0;
  const bestCycle = closed.length ? Math.max(...closed.map(h => h.basketProfit || 0)) : 0;
  const worstCycle = closed.length ? Math.min(...closed.map(h => h.basketProfit || 0)) : 0;
  const emergencyCount = closed.filter(h => h.result === 'EMERGENCY').length;

  const tiles = [
    ['TOTAL CYCLE', closed.length, ''],
    ['WIN RATE', fmtPct(winRate), winRate >= 50 ? 'pos' : 'neg'],
    ['TOTAL PNL', fmtMoney(totalPnl), totalPnl >= 0 ? 'pos' : 'neg'],
  ];
  const tiles2 = [
    ['EQUITY SAAT INI', fmtMoney(currentEquity), growthPct >= 0 ? 'pos' : 'neg', fmtPct(growthPct) + ' dari modal awal'],
    ['PROFIT FACTOR', profitFactor === Infinity ? '∞' : profitFactor.toFixed(2), ''],
    ['BEST / WORST', `${fmtMoney(bestCycle)} / ${fmtMoney(worstCycle)}`, ''],
  ];

  el.statGridTop.innerHTML = tiles.map(([label, val, cls]) => `
    <div class="stat-tile"><span class="stat-label">${label}</span><span class="stat-value ${cls || ''}">${val}</span></div>
  `).join('');

  el.statGridBottom.innerHTML = tiles2.map(([label, val, cls, delta]) => `
    <div class="stat-tile">
      <span class="stat-label">${label}</span>
      <span class="stat-value ${cls || ''}">${val}</span>
      ${delta ? `<span class="stat-delta">${delta}</span>` : `<span class="stat-delta">Avg recovery: ${avgRecovery.toFixed(1)}x · Emergency: ${emergencyCount}</span>`}
    </div>
  `).join('');
}

function renderPositions() {
  const active = engine.positions.filter(p => p.status !== 'CLOSED');
  el.positionsCountBadge.textContent = `${active.length} posisi`;
  if (!active.length) {
    el.positionsList.innerHTML = `<div class="text-dim" style="text-align:center;padding:28px 0;font-size:12.5px">Belum ada posisi terbuka. Menunggu breakout terpicu.</div>`;
  } else {
    el.positionsList.innerHTML = active.map(p => `
      <div class="position-row">
        <span class="side-tag ${p.side.toLowerCase()}">${p.side} L${p.level ?? '—'}</span>
        <div>
          <div class="pos-meta">Lot ${p.lot.toFixed(2)} @ ${p.entryPrice.toFixed(4)}</div>
          <div class="pos-meta">${fmtTime(p.openTime)}</div>
        </div>
        <span class="badge ${p.status === 'LOCKED' ? 'badge-info' : 'badge-gold'}">${p.status}</span>
        <span class="pos-pnl ${p.floatingPnl >= 0 ? 'pos' : 'neg'}" style="color:${p.floatingPnl >= 0 ? 'var(--positive)' : 'var(--negative)'}">${fmtMoney(p.floatingPnl)}</span>
      </div>
    `).join('');
  }

  if (!engine.pendingOrders.length) {
    el.pendingList.innerHTML = `<div class="text-dim" style="font-size:12px">Belum ada pending order.</div>`;
  } else {
    el.pendingList.innerHTML = engine.pendingOrders.map(po => `
      <div class="flex" style="justify-content:space-between;padding:6px 0;font-family:var(--font-mono);font-size:12px">
        <span class="side-tag ${po.side.toLowerCase()}" style="padding:2px 8px">${po.type} L${po.level ?? '—'}</span>
        <span class="text-dim">Trigger @ ${po.triggerPrice.toFixed(4)} · Lot ${po.lot.toFixed(2)}</span>
      </div>
    `).join('');
  }
}

function renderRiskSummary() {
  el.rsCapital.textContent = fmtMoney(settings.capital);
  el.rsEquity.textContent = fmtMoney(engine.cycle.equityStart);
  el.rsGlobalRisk.textContent = settings.enableSafetyNet
    ? `${fmtMoney(engine.globalRiskBudget)} (${(settings.globalRiskPct * 100).toFixed(0)}%)`
    : 'Nonaktif';
  el.rsRecoveryBudget.textContent = `${settings.distancePoints} point (${(settings.distancePoints * settings.pointSize).toFixed(4)})`;
  el.rsFloatingBudget.textContent = `BUY ${settings.maxBuy} / SELL ${settings.maxSell} / Total ${settings.maxBuy + settings.maxSell}`;
  el.rsLot.textContent = `Level 1: ${settings.lotStart.toFixed(2)} → Level 10: ${engine.lotTable.at(-1).toFixed(2)}`;
  el.rsSpread.textContent = `${settings.spreadPips} pip`;
  el.rsCommission.textContent = fmtMoney(settings.commissionPerLot) + '/lot';
  el.rsPipValue.textContent = fmtMoney(settings.pipValue);
}

function renderChain() {
  const recent = history.slice(-11);
  const blocks = recent.map(h => {
    const cls = isWinCycle(h) ? 'win' : (h.result === 'EMERGENCY' ? 'emergency' : 'loss');
    const label = isWinCycle(h) ? 'W' : (h.result === 'EMERGENCY' ? '!' : 'L');
    return `<div class="chain-block ${cls}" title="${shortId(h.cycleId)} · ${fmtMoney(h.basketProfit)}">${label}</div>`;
  });
  const activeLabel = engine.cycle.status === 'CLOSED' ? '·' : '●';
  blocks.push(`<div class="chain-block active" title="Cycle berjalan">${activeLabel}</div>`);
  el.chainRow.innerHTML = blocks.map((b, i) => i === 0 ? b : `<div class="chain-link"></div>${b}`).join('');
}

function renderCycleHistoryTable() {
  const rows = [...history].reverse().slice(0, 100);
  el.cycleHistCount.textContent = `${history.length} cycle tercatat`;
  if (!rows.length) {
    el.cycleHistBody.innerHTML = `<tr class="empty-row"><td colspan="9">Belum ada cycle yang selesai.</td></tr>`;
    return;
  }
  el.cycleHistBody.innerHTML = rows.map(h => `
    <tr>
      <td>${shortId(h.cycleId)}</td>
      <td class="mono-dim">${fmtDate(h.startTime)}</td>
      <td>${h.marketMode ?? '—'}</td>
      <td>${h.tqiStart != null ? Math.round(h.tqiStart) : '—'}</td>
      <td class="mono-dim">${fmtMoney(h.basketTarget || 0)}</td>
      <td style="color:${(h.basketProfit || 0) >= 0 ? 'var(--positive)' : 'var(--negative)'}">${fmtMoney(h.basketProfit || 0)}</td>
      <td class="mono-dim">${fmtMoney(h.maxDrawdown || 0)}</td>
      <td>${h.recoveryCount}x</td>
      <td><span class="badge ${isWinCycle(h) ? 'badge-pos' : (h.result === 'EMERGENCY' ? 'badge-gold' : 'badge-neg')}">${h.result}</span></td>
    </tr>
  `).join('');
}

function renderEventTable() {
  const rows = [...eventLog].reverse().slice(0, 300);
  el.eventCount.textContent = `${eventLog.length} event`;
  if (!rows.length) {
    el.eventBody.innerHTML = `<tr class="empty-row"><td colspan="8">Belum ada event tercatat.</td></tr>`;
    return;
  }
  el.eventBody.innerHTML = rows.map(e => `
    <tr>
      <td class="mono-dim">${fmtTime(e.timestamp)}</td>
      <td>${shortId(e.cycleId)}</td>
      <td class="mono-dim">${e.orderId ? shortId(e.orderId) : '—'}</td>
      <td>${e.type ?? '—'}</td>
      <td><span class="badge ${badgeForEvent(e.event)}">${e.event}</span></td>
      <td>${e.lot != null ? e.lot.toFixed(2) : '—'}</td>
      <td>${e.price != null ? e.price.toFixed(4) : '—'}</td>
      <td class="mono-dim">${e.reason ?? '—'}</td>
    </tr>
  `).join('');
}

function badgeForEvent(evt) {
  if (['ENTRY', 'RECOVERY', 'DEPLOY'].includes(evt)) return 'badge-info';
  if (['CLOSE', 'CYCLE_CLOSE'].includes(evt)) return 'badge-gold';
  if (['LOCK', 'EMERGENCY_CLOSE'].includes(evt)) return 'badge-neg';
  return '';
}

// ---------------------------------------------------------------
// AI SELF-LEARNING (heuristik adaptif dari riwayat cycle)
// ---------------------------------------------------------------
function renderTQIBandStats() {
  const bands = ['SIDEWAYS', 'WEAK_TREND', 'TRENDING', 'STRONG_TREND'];
  const rows = bands.map(band => {
    const inBand = history.filter(h => h.result && classifyFromStart(h.tqiStart) === band);
    const wins = inBand.filter(isWinCycle).length;
    const rate = inBand.length ? (wins / inBand.length) * 100 : 0;
    return `<div class="learning-band-row">
      <span>${band}</span>
      <div class="learning-band-track"><div class="learning-band-fill" style="width:${rate}%; background:${rate >= 50 ? 'var(--positive)' : 'var(--negative)'}"></div></div>
      <span>${inBand.length ? rate.toFixed(0) + '%' : '—'}</span>
    </div>`;
  });
  el.tqiBandStats.innerHTML = rows.join('');
}

function classifyFromStart(tqi) {
  if (tqi == null) return null;
  if (tqi <= 30) return 'SIDEWAYS';
  if (tqi <= 60) return 'WEAK_TREND';
  if (tqi <= 80) return 'TRENDING';
  return 'STRONG_TREND';
}

function renderAIInsights() {
  const closed = history.filter(h => h.result);
  if (closed.length < 5) {
    el.aiInsights.innerHTML = `<div class="ai-insight">
      <div class="ai-insight-icon">i</div>
      <div class="ai-insight-body">
        <span class="ai-insight-tag">Menunggu data</span>
        <p>Rekomendasi akan muncul setelah minimal 5 cycle selesai. Saat ini: <strong>${closed.length}</strong> cycle.</p>
      </div>
    </div>`;
    return;
  }

  const insights = [];

  // 1. Recovery efficacy
  const withRecovery = closed.filter(h => h.recoveryCount > 0);
  const withoutRecovery = closed.filter(h => h.recoveryCount === 0);
  const wrWith = withRecovery.length ? withRecovery.filter(isWinCycle).length / withRecovery.length * 100 : null;
  const wrWithout = withoutRecovery.length ? withoutRecovery.filter(isWinCycle).length / withoutRecovery.length * 100 : null;
  if (wrWith != null && wrWithout != null) {
    if (wrWith < wrWithout - 15) {
      insights.push({
        tag: 'Ladder Level', icon: '↓',
        text: `Cycle yang sampai ke level lanjutan (Level 2+) menang <strong>${wrWith.toFixed(0)}%</strong>, jauh di bawah cycle yang selesai di Level 1 (<strong>${wrWithout.toFixed(0)}%</strong>). Pertimbangkan memperbesar <strong>Distance</strong> atau menurunkan <strong>Max BUY/SELL</strong>.`
      });
    } else if (wrWith > wrWithout + 15) {
      insights.push({
        tag: 'Ladder Level', icon: '↑',
        text: `Basket yang lanjut ke level berikutnya terbukti efektif — win rate <strong>${wrWith.toFixed(0)}%</strong> vs <strong>${wrWithout.toFixed(0)}%</strong> yang berhenti di Level 1. Pengaturan Distance & tabel lot saat ini cukup baik.`
      });
    }
  }

  // 2. TQI band performance
  const bandPerf = ['SIDEWAYS', 'WEAK_TREND', 'TRENDING', 'STRONG_TREND'].map(band => {
    const inBand = closed.filter(h => classifyFromStart(h.tqiStart) === band);
    const rate = inBand.length ? inBand.filter(isWinCycle).length / inBand.length * 100 : null;
    return { band, rate, n: inBand.length };
  }).filter(b => b.n >= 2);
  if (bandPerf.length) {
    const best = bandPerf.reduce((a, b) => (b.rate > a.rate ? b : a));
    const worst = bandPerf.reduce((a, b) => (b.rate < a.rate ? b : a));
    if (best.band !== worst.band) {
      insights.push({
        tag: 'Kondisi Pasar Optimal', icon: '★',
        text: `Performa terbaik terjadi saat TQI di band <strong>${best.band}</strong> (win rate ${best.rate.toFixed(0)}%), sedangkan band <strong>${worst.band}</strong> paling lemah (${worst.rate.toFixed(0)}%). Pertimbangkan menaikkan bobot komponen TQI yang relevan dengan kondisi ${best.band}.`
      });
    }
  }

  // 3. Emergency frequency
  const emergencies = closed.filter(h => h.result === 'EMERGENCY');
  const emergencyRate = (emergencies.length / closed.length) * 100;
  if (emergencyRate >= 20) {
    insights.push({
      tag: 'Peringatan Risiko', icon: '!',
      text: `<strong>${emergencyRate.toFixed(0)}%</strong> dari cycle berakhir EMERGENCY (menyentuh Global Risk Budget). Global Risk % atau Lot Max saat ini kemungkinan terlalu agresif untuk kondisi pasar ini.`
    });
  }

  // 4. Drawdown vs target ratio
  const avgDD = Math.abs(closed.reduce((s, h) => s + (h.maxDrawdown || 0), 0) / closed.length);
  const avgTarget = closed.reduce((s, h) => s + (h.basketTarget || 0), 0) / closed.length;
  if (avgTarget > 0 && avgDD > avgTarget * 1.5) {
    insights.push({
      tag: 'Rasio Risk/Reward', icon: '⚖',
      text: `Rata-rata max drawdown per cycle (<strong>${fmtMoney(avgDD)}</strong>) jauh lebih besar dari rata-rata target basket (<strong>${fmtMoney(avgTarget)}</strong>). Pertimbangkan target basket yang lebih tinggi di band TQI rendah atau perketat lot ladder.`
    });
  }

  if (!insights.length) {
    insights.push({ tag: 'Status', icon: '✓', text: 'Belum ada pola signifikan yang terdeteksi dari riwayat saat ini — parameter berjalan normal.' });
  }

  el.aiInsights.innerHTML = insights.map(i => `
    <div class="ai-insight">
      <div class="ai-insight-icon">${i.icon}</div>
      <div class="ai-insight-body"><span class="ai-insight-tag">${i.tag}</span><p>${i.text}</p></div>
    </div>
  `).join('');
}

// ---------------------------------------------------------------
// SETTINGS MODAL
// ---------------------------------------------------------------
function openSettings() {
  $('cfgCapital').value = settings.capital;
  $('cfgApiKey').value = settings.apiKey;
  $('cfgEnableSafetyNet').value = settings.enableSafetyNet ? 'true' : 'false';
  $('cfgGlobalRisk').value = settings.globalRiskPct;
  $('cfgStopLoss').value = settings.basketStopLossPct;
  $('cfgLotStart').value = settings.lotStart;
  $('cfgDistancePoints').value = settings.distancePoints;
  $('cfgPointSize').value = settings.pointSize;
  $('cfgMaxBuy').value = settings.maxBuy;
  $('cfgMaxSell').value = settings.maxSell;
  $('cfgTargetProfit').value = settings.basketTargetPct;
  $('cfgEnableProfitLock').value = settings.enableProfitLock ? 'true' : 'false';
  $('cfgProfitLockActivate').value = settings.profitLockActivateUsd;
  $('cfgProfitLockValue').value = settings.profitLockValueUsd;
  $('cfgSpread').value = settings.spreadPips;
  $('cfgCommission').value = settings.commissionPerLot;
  $('cfgSwap').value = settings.swapPerTick;
  $('cfgPipValue').value = settings.pipValue;
  $('cfgWTrend').value = settings.tqiWeights.trendStrength;
  $('cfgWStruct').value = settings.tqiWeights.marketStructure;
  $('cfgWVol').value = settings.tqiWeights.volatility;
  $('cfgWBreakout').value = settings.tqiWeights.breakoutQuality;
  $('cfgWVolume').value = settings.tqiWeights.volume;
  $('cfgWSpread').value = settings.tqiWeights.spread;
  $('cfgWMomentum').value = settings.tqiWeights.momentum;
  el.settingsModal.classList.add('open');
}
function closeSettings() { el.settingsModal.classList.remove('open'); }

if (el.btnCloseAllManual) {
  el.btnCloseAllManual.addEventListener('click', () => {
    const hasSomethingToClose = engine.positions.some(p => p.status !== 'CLOSED') || engine.pendingOrders.length > 0;
    if (!hasSomethingToClose) { alert('Tidak ada posisi/pending order yang sedang berjalan untuk ditutup.'); return; }
    const proceed = confirm(`Tutup SEMUA posisi & pending order sekarang (Close All Manual)?\nPnL berjalan saat ini: ${fmtMoney(engine.cycle.basketProfit)}.\nCycle akan direset dan mulai lagi dari awal (Level 1).`);
    if (!proceed) return;
    handleManualCloseAll();
  });
}

$('btnSettings').addEventListener('click', openSettings);
$('btnSettings2').addEventListener('click', openSettings);
$('btnCloseSettings').addEventListener('click', closeSettings);
$('btnCancelSettings').addEventListener('click', closeSettings);
el.settingsModal.addEventListener('click', e => { if (e.target === el.settingsModal) closeSettings(); });

el.settingsForm.addEventListener('submit', e => {
  e.preventDefault();
  const proceed = confirm('Menerapkan pengaturan baru akan memulai basket baru dengan modal yang dimasukkan. Riwayat trade & event tidak akan hilang. Lanjutkan?');
  if (!proceed) return;

  settings = {
    ...settings,
    capital: parseFloat($('cfgCapital').value) || DEFAULT_SETTINGS.capital,
    apiKey: $('cfgApiKey').value.trim(),
    enableSafetyNet: $('cfgEnableSafetyNet').value === 'true',
    globalRiskPct: parseFloat($('cfgGlobalRisk').value) || DEFAULT_SETTINGS.globalRiskPct,
    basketStopLossPct: parseFloat($('cfgStopLoss').value) || DEFAULT_SETTINGS.basketStopLossPct,
    lotStart: parseFloat($('cfgLotStart').value) || DEFAULT_SETTINGS.lotStart,
    distancePoints: parseFloat($('cfgDistancePoints').value) || DEFAULT_SETTINGS.distancePoints,
    pointSize: parseFloat($('cfgPointSize').value) || DEFAULT_SETTINGS.pointSize,
    maxBuy: Math.min(10, Math.max(1, parseInt($('cfgMaxBuy').value, 10) || DEFAULT_SETTINGS.maxBuy)),
    maxSell: Math.min(10, Math.max(1, parseInt($('cfgMaxSell').value, 10) || DEFAULT_SETTINGS.maxSell)),
    basketTargetPct: parseFloat($('cfgTargetProfit').value) || DEFAULT_SETTINGS.basketTargetPct,
    enableProfitLock: $('cfgEnableProfitLock').value === 'true',
    profitLockActivateUsd: parseFloat($('cfgProfitLockActivate').value) || DEFAULT_SETTINGS.profitLockActivateUsd,
    profitLockValueUsd: parseFloat($('cfgProfitLockValue').value) || DEFAULT_SETTINGS.profitLockValueUsd,
    spreadPips: parseFloat($('cfgSpread').value) || 0,
    commissionPerLot: parseFloat($('cfgCommission').value) || 0,
    swapPerTick: parseFloat($('cfgSwap').value) || 0,
    pipValue: parseFloat($('cfgPipValue').value) || DEFAULT_SETTINGS.pipValue,
    tqiWeights: {
      trendStrength: parseFloat($('cfgWTrend').value) || 0,
      marketStructure: parseFloat($('cfgWStruct').value) || 0,
      volatility: parseFloat($('cfgWVol').value) || 0,
      breakoutQuality: parseFloat($('cfgWBreakout').value) || 0,
      volume: parseFloat($('cfgWVolume').value) || 0,
      spread: parseFloat($('cfgWSpread').value) || 0,
      momentum: parseFloat($('cfgWMomentum').value) || 0
    }
  };
  saveSettings();

  engine = new ABRSEngine(buildEngineConfig(settings));
  lastFlushedCycleId = null;
  costsAccum = 0;
  lastTqiComponents = null;

  closeSettings();
  renderAll();

  if (feedRunning) refreshCandlesAndMaybeStartCycle();
});

$('btnResetHistory').addEventListener('click', () => {
  const proceed = confirm('Hapus semua riwayat trade & log event? Tindakan ini tidak bisa dibatalkan.');
  if (!proceed) return;
  history = []; eventLog = [];
  saveHistory(); saveEvents();
  renderAll();
});

$('btnExportEvents').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(eventLog, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `gusera-sats-trade-events-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$('btnImportHeadless').addEventListener('click', () => {
  const fileInput = $('cfgImportHeadlessFile');
  const file = fileInput.files && fileInput.files[0];
  if (!file) { alert('Pilih dulu file headless-store.json yang dihasilkan headless-runner.js.'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch (e) { alert('File bukan JSON valid: ' + e.message); return; }

    const importedHistory = Array.isArray(data.history) ? data.history : [];
    const importedEvents = Array.isArray(data.events) ? data.events : [];

    const existingCycleIds = new Set(history.map(h => h.cycleId));
    let addedCycles = 0;
    for (const h of importedHistory) {
      if (h.cycleId && !existingCycleIds.has(h.cycleId)) { history.push(h); existingCycleIds.add(h.cycleId); addedCycles++; }
    }
    history.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));

    const existingEventKeys = new Set(eventLog.map(e => e.cycleId + '|' + e.timestamp + '|' + e.event + '|' + (e.orderId || '')));
    let addedEvents = 0;
    for (const e of importedEvents) {
      const key = e.cycleId + '|' + e.timestamp + '|' + e.event + '|' + (e.orderId || '');
      if (!existingEventKeys.has(key)) { eventLog.push(e); existingEventKeys.add(key); addedEvents++; }
    }
    eventLog.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    saveHistory(); saveEvents();
    renderAll();
    fileInput.value = '';
    alert(`Import selesai: ${addedCycles} cycle baru, ${addedEvents} event baru ditambahkan ke riwayat.`);
  };
  reader.onerror = () => alert('Gagal membaca file.');
  reader.readAsText(file);
});

// ---------------------------------------------------------------
// INIT
// ---------------------------------------------------------------
renderAll();
