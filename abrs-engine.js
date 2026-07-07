/**
 * ============================================================
 *  ABRS V1.3 - Adaptive Breakout Recovery System
 *  Core Trading Logic Engine untuk GUSERA SATS
 * ============================================================
 *
 *  Implementasi murni client-side (vanilla JS), tanpa backend.
 *  Modul ini adalah SIGNAL / SIMULATION ENGINE - tidak melakukan
 *  eksekusi order nyata ke broker manapun. Semua "posisi" adalah
 *  representasi virtual yang dihitung dari price feed (mis. dari
 *  Twelve Data API) dan bisa dipakai untuk:
 *    - menghasilkan sinyal ENTRY/HEDGE/CLOSE
 *    - mencatat riwayat cycle untuk analisis / self-learning
 *    - ditampilkan di UI (status basket, TQI, target, dsb)
 *
 *  ------------------------------------------------------------
 *  RULE ENTRY (v1.3 - diperbaiki):
 *  ------------------------------------------------------------
 *  1. Entry pertama dibuka LANGSUNG (market, bukan pending
 *     BUY_STOP/SELL_STOP menunggu breakout range) begitu cycle
 *     dimulai. Arah (BUY/SELL) ditentukan oleh arah trend jangka
 *     pendek (SMA cepat vs SMA lambat dari candle terbaru).
 *     Lot = lotStart (default 0.01).
 *
 *     Contoh: entry pertama BUY 0.01.
 *
 *  2. Jika harga bergerak MELAWAN posisi pertama (turun untuk
 *     BUY, naik untuk SELL), sistem langsung membuka posisi
 *     HEDGE di sisi berlawanan dengan lot tetap = hedgeLotSize
 *     (default 0.03). Hedge ini hanya terjadi SEKALI per cycle.
 *
 *     Contoh: BUY 0.01 floating rugi -> open SELL 0.03.
 *     Sebaliknya: SELL 0.01 floating rugi (harga naik) -> open BUY 0.03.
 *
 *  3. Seluruh basket (semua posisi berjalan) ditutup (Close All)
 *     begitu total floating profit basket >= target profit tetap
 *     dalam $ (basketTargetUsd, default $10).
 *
 *  4. Proteksi risiko tetap berjalan sebagai jaring pengaman:
 *     Stop Loss bertingkat (basketStopLossPct x globalRiskBudget)
 *     dan EMERGENCY (100% globalRiskBudget) tetap menutup basket
 *     lebih awal jika harga terus melawan kedua posisi.
 *
 *  Alur pemakaian singkat:
 *    const engine = new ABRSEngine({ capital: 10000 });
 *    engine.startCycle(tqiComponents, candles, atr, currentPrice);
 *    // untuk setiap tick / candle baru:
 *    engine.onPriceTick(currentPrice);
 *    // setelah basket close, mulai cycle baru:
 *    engine.startNewCycleAfterClose();
 *    engine.startCycle(nextTqiComponents, nextCandles, nextAtr, nextPrice);
 * ============================================================
 */

class ABRSEngine {
  constructor(config = {}) {
    this.config = {
      capital: config.capital ?? 10000,
      globalRiskPct: config.globalRiskPct ?? 0.15,      // 15% dari modal
      recoveryBudgetSplit: config.recoveryBudgetSplit ?? 0.35, // porsi budget hedge dari global risk (info/limit)
      basketStopLossPct: config.basketStopLossPct ?? 0.6, // cycle ditutup 'LOSS' saat basketProfit <= -(globalRiskBudget * pct), sebelum menyentuh EMERGENCY penuh
      lotStart: config.lotStart ?? 0.01,       // lot entry pertama
      hedgeLotSize: config.hedgeLotSize ?? 0.03, // lot tetap untuk hedge lawan arah
      lotMax: config.lotMax ?? 0.20,           // batas aman lot (hedge tidak boleh melebihi ini)
      basketTargetUsd: config.basketTargetUsd ?? 10, // target profit tetap ($) untuk Close All
      trendFastPeriod: config.trendFastPeriod ?? 10,  // SMA cepat untuk deteksi arah entry pertama
      trendSlowPeriod: config.trendSlowPeriod ?? 30,  // SMA lambat untuk deteksi arah entry pertama
      // Bobot komponen penyusun TQI (total idealnya = 1) - dipakai untuk info/analisa,
      // tidak lagi menggerbang entry (entry selalu terjadi begitu cycle dimulai).
      tqiWeights: config.tqiWeights ?? {
        trendStrength: 0.25,
        marketStructure: 0.20,
        volatility: 0.15,
        breakoutQuality: 0.15,
        volume: 0.10,
        spread: 0.05,
        momentum: 0.10
      }
    };

    this.resetCycle(this.config.capital);
  }

  // ------------------------------------------------------------
  // CYCLE RESET
  // ------------------------------------------------------------
  resetCycle(equityStart = this.config.capital) {
    this.cycle = {
      cycleId: (crypto?.randomUUID?.() ?? `cycle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
      startTime: Date.now(),
      endTime: null,
      balanceStart: equityStart,
      balanceEnd: null,
      equityStart,
      equityEnd: null,
      tqiStart: null,
      marketMode: null,      // 'RANGE' | 'TREND' (info)
      initialSide: null,     // 'BUY' | 'SELL' - arah entry pertama
      basketTarget: null,    // target profit tetap ($)
      basketProfit: 0,
      maxDrawdown: 0,
      recoveryCount: 0,      // jumlah hedge terpasang (0 atau 1)
      maxLotUsed: 0,
      result: null,          // 'WIN' | 'LOSS' | 'EMERGENCY'
      status: 'IDLE'         // IDLE, BUY_ACTIVE, SELL_ACTIVE, CLOSED
    };

    this.positions = [];      // { id, side, lot, entryPrice, status, openTime, floatingPnl }
    this.pendingOrders = [];  // selalu kosong - dipertahankan untuk kompatibilitas UI lama
    this.events = [];

    this.globalRiskBudget = this.config.capital * this.config.globalRiskPct;
    this.recoveryBudget = this.globalRiskBudget * this.config.recoveryBudgetSplit;
    this.floatingBudget = this.globalRiskBudget - this.recoveryBudget;
    this.recoveryBudgetUsed = 0;
    this.hedgePlaced = false;
    this.tradingDisabled = false;
  }

  startNewCycleAfterClose() {
    const nextEquity = this.cycle.equityEnd ?? this.cycle.equityStart;
    this.resetCycle(nextEquity);
  }

  // ------------------------------------------------------------
  // TREND QUALITY INDEX (TQI) - komposit 0-100 (info/analisa)
  // ------------------------------------------------------------
  // components = { trendStrength, marketStructure, volatility,
  //                breakoutQuality, volume, spread, momentum } masing2 0-100
  computeTQI(components) {
    const w = this.config.tqiWeights;
    let score = 0;
    let totalWeight = 0;
    for (const key of Object.keys(w)) {
      if (components[key] != null) {
        score += components[key] * w[key];
        totalWeight += w[key];
      }
    }
    const tqi = totalWeight > 0 ? score / totalWeight : 0;
    return Math.max(0, Math.min(100, tqi));
  }

  classifyTQI(tqi) {
    if (tqi <= 30) return 'SIDEWAYS';
    if (tqi <= 60) return 'WEAK_TREND';
    if (tqi <= 80) return 'TRENDING';
    return 'STRONG_TREND';
  }

  // ------------------------------------------------------------
  // MARKET MODE (info, tidak menggerbang entry)
  // ------------------------------------------------------------
  getMarketMode(tqi) {
    return tqi <= 30 ? 'RANGE' : 'TREND';
  }

  // ------------------------------------------------------------
  // DETEKSI ARAH ENTRY PERTAMA (SMA cepat vs SMA lambat)
  // ------------------------------------------------------------
  detectTrendDirection(candles) {
    const closes = candles.map(c => c.close);
    const fastN = Math.min(this.config.trendFastPeriod, closes.length);
    const slowN = Math.min(this.config.trendSlowPeriod, closes.length);
    const fast = closes.slice(-fastN).reduce((a, b) => a + b, 0) / fastN;
    const slow = closes.slice(-slowN).reduce((a, b) => a + b, 0) / slowN;
    return fast >= slow ? 'BUY' : 'SELL';
  }

  // ------------------------------------------------------------
  // ENTRY ENGINE - membuka posisi (entry pertama maupun hedge)
  // ------------------------------------------------------------
  openPosition(side, lot, price, reason) {
    const position = {
      id: `pos_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      side,
      lot,
      entryPrice: price,
      status: 'ACTIVE',
      openTime: Date.now(),
      floatingPnl: 0
    };
    this.positions.push(position);
    this.cycle.maxLotUsed = Math.max(this.cycle.maxLotUsed, lot);
    this.logEvent({ orderId: position.id, type: side, lot, price, event: 'ENTRY', reason });
    return position;
  }

  // ------------------------------------------------------------
  // HEDGE RULE
  // ------------------------------------------------------------
  // Begitu harga bergerak melawan posisi pertama, langsung buka
  // posisi lawan arah dengan lot tetap (hedgeLotSize). Hanya
  // terjadi sekali per cycle.
  checkHedgeTrigger(price) {
    if (this.hedgePlaced || this.cycle.status === 'CLOSED' || !this.cycle.initialSide) return null;

    const initialSide = this.cycle.initialSide;
    const initialPositions = this.positions.filter(p => p.side === initialSide && p.status !== 'CLOSED');
    if (!initialPositions.length) return null;

    const refEntry = initialPositions[0].entryPrice;
    const isAdverse = initialSide === 'BUY' ? price < refEntry : price > refEntry;
    if (!isAdverse) return null;

    const hedgeSide = initialSide === 'BUY' ? 'SELL' : 'BUY';
    const hedgeLot = Math.min(this.config.hedgeLotSize, this.config.lotMax);

    const hedgePosition = this.openPosition(hedgeSide, hedgeLot, price, 'HEDGE_ADVERSE_MOVE');
    this.hedgePlaced = true;
    this.cycle.recoveryCount += 1;
    this.recoveryBudgetUsed += hedgeLot; // proxy sederhana; bisa diganti margin riil

    this.logEvent({ orderId: hedgePosition.id, type: hedgeSide, lot: hedgeLot, price, event: 'HEDGE', reason: 'PRICE_MOVED_AGAINST_INITIAL_ENTRY' });
    return hedgePosition;
  }

  // ------------------------------------------------------------
  // TICK HANDLER - dipanggil setiap ada harga baru
  // ------------------------------------------------------------
  onPriceTick(price) {
    if (this.tradingDisabled) return;

    this.checkHedgeTrigger(price);
    this.updateFloating(price);
    this.checkGlobalRisk();
    this.checkBasketTarget();
  }

  // ------------------------------------------------------------
  // BASKET ENGINE
  // ------------------------------------------------------------
  updateFloating(currentPrice, pipValue = 1, swap = 0, commission = 0) {
    let buyFloating = 0;
    let sellFloating = 0;

    for (const p of this.positions) {
      if (p.status === 'CLOSED') continue;
      const diff = p.side === 'BUY' ? (currentPrice - p.entryPrice) : (p.entryPrice - currentPrice);
      const pnl = diff * p.lot * pipValue;
      p.floatingPnl = pnl;
      if (p.side === 'BUY') buyFloating += pnl; else sellFloating += pnl;
    }

    this.cycle.basketProfit = buyFloating + sellFloating + swap - commission;
    this.cycle.maxDrawdown = Math.min(this.cycle.maxDrawdown, this.cycle.basketProfit);
    return this.cycle.basketProfit;
  }

  // ------------------------------------------------------------
  // BASKET TARGET & CLOSE RULE - Close All saat profit >= target tetap ($)
  // ------------------------------------------------------------
  checkBasketTarget() {
    if (this.cycle.basketTarget == null || this.cycle.status === 'CLOSED') return;
    if (this.cycle.basketProfit >= this.cycle.basketTarget) {
      this.closeBasket('WIN');
    }
  }

  closeBasket(result) {
    for (const p of this.positions) {
      if (p.status !== 'CLOSED') {
        p.status = 'CLOSED';
        this.logEvent({ orderId: p.id, type: p.side, lot: p.lot, event: 'CLOSE', reason: `BASKET_${result}` });
      }
    }
    this.pendingOrders = [];
    this.cycle.endTime = Date.now();
    this.cycle.equityEnd = this.cycle.equityStart + this.cycle.basketProfit;
    this.cycle.balanceEnd = this.cycle.equityEnd;
    this.cycle.result = result;
    this.cycle.status = 'CLOSED';
    this.logEvent({ event: 'CYCLE_CLOSE', reason: result });
  }

  // ------------------------------------------------------------
  // GLOBAL RISK ENGINE (jaring pengaman, tetap berjalan)
  // ------------------------------------------------------------
  // Dua jenjang proteksi:
  //  a) STOP LOSS bertingkat di basketStopLossPct x globalRiskBudget -> cycle
  //     ditutup 'LOSS' (kerugian dibatasi lebih awal, trading TIDAK dihentikan,
  //     cycle berikutnya bisa mulai normal).
  //  b) EMERGENCY di 100% globalRiskBudget -> circuit breaker keras, trading
  //     dihentikan (tradingDisabled) sampai user reset/mulai ulang.
  checkGlobalRisk() {
    if (this.cycle.status === 'CLOSED') return;

    const stopLossLevel = this.globalRiskBudget * this.config.basketStopLossPct;

    if (this.cycle.basketProfit <= -this.globalRiskBudget) {
      this.tradingDisabled = true;
      this.closeBasket('EMERGENCY');
      this.logEvent({ event: 'EMERGENCY_CLOSE', reason: 'GLOBAL_RISK_LIMIT_HIT' });
    } else if (this.cycle.basketProfit <= -stopLossLevel) {
      this.closeBasket('LOSS');
      this.logEvent({ event: 'STOP_LOSS_CLOSE', reason: 'BASKET_STOP_LOSS_LEVEL_HIT' });
    }
  }

  // ------------------------------------------------------------
  // BOOTSTRAP CYCLE - entry pertama langsung (market), tanpa
  // menunggu breakout range.
  // ------------------------------------------------------------
  startCycle(tqiComponents, candles, atr, currentPrice) {
    if (this.tradingDisabled) {
      return { started: false, reason: 'TRADING_DISABLED' };
    }
    if (currentPrice == null || !Number.isFinite(currentPrice)) {
      return { started: false, reason: 'NO_PRICE' };
    }
    if (!candles || candles.length < 2) {
      return { started: false, reason: 'INSUFFICIENT_CANDLES' };
    }

    const tqi = this.computeTQI(tqiComponents);
    this.cycle.tqiStart = tqi;
    this.cycle.marketMode = this.getMarketMode(tqi);
    this.cycle.basketTarget = this.config.basketTargetUsd;

    const direction = this.detectTrendDirection(candles);
    this.cycle.initialSide = direction;
    this.cycle.status = direction === 'BUY' ? 'BUY_ACTIVE' : 'SELL_ACTIVE';

    this.openPosition(direction, this.config.lotStart, currentPrice, 'INITIAL_ENTRY');

    return {
      started: true,
      tqi,
      classification: this.classifyTQI(tqi),
      mode: this.cycle.marketMode,
      direction,
      basketTarget: this.cycle.basketTarget
    };
  }

  // ------------------------------------------------------------
  // LOGGING / EXPORT (untuk tabel trading_cycle & trade_event)
  // ------------------------------------------------------------
  logEvent(evt) {
    this.events.push({ cycleId: this.cycle.cycleId, timestamp: Date.now(), ...evt });
  }

  exportCycleRecord() {
    return { ...this.cycle };
  }

  exportEvents() {
    return [...this.events];
  }

  exportSnapshot() {
    return {
      cycle: this.exportCycleRecord(),
      positions: [...this.positions],
      pendingOrders: [...this.pendingOrders],
      events: this.exportEvents(),
      risk: {
        globalRiskBudget: this.globalRiskBudget,
        recoveryBudget: this.recoveryBudget,
        recoveryBudgetUsed: this.recoveryBudgetUsed,
        floatingBudget: this.floatingBudget,
        tradingDisabled: this.tradingDisabled
      }
    };
  }
}

// Export untuk pemakaian sebagai module (<script type="module">) atau global (<script>)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ABRSEngine;
} else if (typeof window !== 'undefined') {
  window.ABRSEngine = ABRSEngine;
}
