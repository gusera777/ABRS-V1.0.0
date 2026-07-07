/**
 * ============================================================
 *  ABRS V1.0 - Adaptive Breakout Recovery System
 *  Core Trading Logic Engine untuk GUSERA SATS
 * ============================================================
 *
 *  Implementasi murni client-side (vanilla JS), tanpa backend.
 *  Modul ini adalah SIGNAL / SIMULATION ENGINE - tidak melakukan
 *  eksekusi order nyata ke broker manapun. Semua "posisi" adalah
 *  representasi virtual yang dihitung dari price feed (mis. dari
 *  Twelve Data API) dan bisa dipakai untuk:
 *    - menghasilkan sinyal ENTRY/LOCK/RECOVERY/CLOSE
 *    - mencatat riwayat cycle untuk analisis / self-learning
 *    - ditampilkan di UI (status basket, TQI, target, dsb)
 *
 *  Alur pemakaian singkat:
 *    const engine = new ABRSEngine({ capital: 10000 });
 *    engine.startCycle(tqiComponents, candles, atr);
 *    // untuk setiap tick / candle baru:
 *    engine.onPriceTick(currentPrice);
 *    // setelah basket close, mulai cycle baru:
 *    engine.startNewCycleAfterClose();
 *    engine.startCycle(nextTqiComponents, nextCandles, nextAtr);
 * ============================================================
 */

class ABRSEngine {
  constructor(config = {}) {
    this.config = {
      capital: config.capital ?? 10000,
      globalRiskPct: config.globalRiskPct ?? 0.15,      // 15% dari modal (default lebih konservatif dari versi awal 50%)
      recoveryBudgetSplit: config.recoveryBudgetSplit ?? 0.35, // porsi recovery dari global risk
      basketStopLossPct: config.basketStopLossPct ?? 0.6, // cycle ditutup 'LOSS' saat basketProfit <= -(globalRiskBudget * pct), sebelum menyentuh EMERGENCY penuh
      lotStart: config.lotStart ?? 0.01,
      lotStep: config.lotStep ?? 0.01,
      lotMax: config.lotMax ?? 0.20,
      rangeLookback: config.rangeLookback ?? 20,
      atrMinRangeMultiplier: config.atrMinRangeMultiplier ?? 1.5, // lebar range minimum = ATR x multiplier
      atrOffsetMultiplier: config.atrOffsetMultiplier ?? 0.25,   // offset pending order dari S/R
      // Bobot komponen penyusun TQI (total idealnya = 1)
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
  // 16. CYCLE RESET
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
      marketMode: null,      // 'RANGE' | 'TREND'
      basketTarget: null,
      basketProfit: 0,
      maxDrawdown: 0,
      recoveryCount: 0,
      maxLotUsed: 0,
      result: null,          // 'WIN' | 'LOSS' | 'EMERGENCY'
      status: 'IDLE'         // IDLE, RANGE_DETECTED, PENDING_DEPLOYED, BUY_ACTIVE, SELL_ACTIVE, CLOSED
    };

    this.positions = [];      // { id, side, lot, entryPrice, status, openTime, floatingPnl }
    this.pendingOrders = [];  // { side, type, triggerPrice, lot }
    this.events = [];

    this.globalRiskBudget = this.config.capital * this.config.globalRiskPct;
    this.recoveryBudget = this.globalRiskBudget * this.config.recoveryBudgetSplit;
    this.floatingBudget = this.globalRiskBudget - this.recoveryBudget;
    this.recoveryBudgetUsed = 0;
    this.tradingDisabled = false;
  }

  startNewCycleAfterClose() {
    const nextEquity = this.cycle.equityEnd ?? this.cycle.equityStart;
    this.resetCycle(nextEquity);
  }

  // ------------------------------------------------------------
  // 3. TREND QUALITY INDEX (TQI) - komposit 0-100
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
  // 4. MARKET MODE
  // ------------------------------------------------------------
  getMarketMode(tqi) {
    return tqi <= 30 ? 'RANGE' : 'TREND';
  }

  // ------------------------------------------------------------
  // 5. RANGE DETECTION
  // ------------------------------------------------------------
  detectRange(candles, atr) {
    const lookback = candles.slice(-this.config.rangeLookback);
    if (lookback.length < this.config.rangeLookback) {
      return { valid: false, reason: 'INSUFFICIENT_CANDLES' };
    }

    const resistance = Math.max(...lookback.map(c => c.high));
    const support = Math.min(...lookback.map(c => c.low));
    const rangeWidth = resistance - support;
    const minWidth = atr * this.config.atrMinRangeMultiplier;

    if (rangeWidth < minWidth) {
      return { valid: false, reason: 'RANGE_TOO_NARROW', resistance, support, rangeWidth, minWidth };
    }
    return { valid: true, resistance, support, rangeWidth };
  }

  // ------------------------------------------------------------
  // 6. PENDING ORDER ENGINE
  // ------------------------------------------------------------
  deployPendingOrders(range, atr) {
    const offset = atr * this.config.atrOffsetMultiplier;
    const buyStopPrice = range.resistance + offset;
    const sellStopPrice = range.support - offset;

    this.pendingOrders = [
      { side: 'BUY', type: 'BUY_STOP', triggerPrice: buyStopPrice, lot: this.config.lotStart },
      { side: 'SELL', type: 'SELL_STOP', triggerPrice: sellStopPrice, lot: this.config.lotStart }
    ];
    this.cycle.status = 'PENDING_DEPLOYED';
    this.logEvent({
      type: 'PENDING', event: 'DEPLOY',
      reason: `BUY_STOP@${buyStopPrice.toFixed(2)} SELL_STOP@${sellStopPrice.toFixed(2)}`
    });
    return this.pendingOrders;
  }

  // ------------------------------------------------------------
  // 7. LOT LADDER (linear, bukan martingale eksponensial)
  // ------------------------------------------------------------
  nextLadderLot(currentLot) {
    const next = Math.round((currentLot + this.config.lotStep) * 100) / 100;
    return Math.min(next, this.config.lotMax);
  }

  // ------------------------------------------------------------
  // 8/9. BREAKOUT & FALSE BREAKOUT RULE
  // ------------------------------------------------------------
  onPriceTick(price) {
    if (this.tradingDisabled) return;

    // Cek trigger pending order
    for (const po of [...this.pendingOrders]) {
      const triggered =
        (po.type === 'BUY_STOP' && price >= po.triggerPrice) ||
        (po.type === 'SELL_STOP' && price <= po.triggerPrice);
      if (triggered) this.triggerOrder(po, price);
    }

    this.updateFloating(price);
    this.runRecoveryCheck(price);
    this.checkGlobalRisk();
    this.checkBasketTarget();
  }

  triggerOrder(po, price) {
    const opposite = po.side === 'BUY' ? 'SELL' : 'BUY';
    const oppositeActive = this.positions.filter(p => p.side === opposite && p.status === 'ACTIVE');

    // Rule 9: posisi sisi berlawanan yang masih ACTIVE menjadi LOCKED,
    // tidak boleh ditutup kecuali oleh Basket Engine.
    for (const p of oppositeActive) {
      p.status = 'LOCKED';
      this.logEvent({
        orderId: p.id, type: p.side, lot: p.lot, price,
        event: 'LOCK', reason: 'FALSE_BREAKOUT_OPPOSITE_TRIGGERED'
      });
    }

    const newPosition = {
      id: `pos_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      side: po.side,
      lot: po.lot,
      entryPrice: price,
      status: 'ACTIVE',
      openTime: Date.now(),
      floatingPnl: 0
    };
    this.positions.push(newPosition);
    this.cycle.status = po.side === 'BUY' ? 'BUY_ACTIVE' : 'SELL_ACTIVE';
    this.cycle.maxLotUsed = Math.max(this.cycle.maxLotUsed, po.lot);

    this.logEvent({
      orderId: newPosition.id, type: po.type, lot: po.lot, price,
      event: 'ENTRY', reason: 'BREAKOUT_TRIGGERED'
    });

    this.pendingOrders = this.pendingOrders.filter(o => o !== po);
  }

  // ------------------------------------------------------------
  // 10. RECOVERY ENGINE
  // ------------------------------------------------------------
  // Dipanggil otomatis dari onPriceTick untuk setiap sisi yang
  // memiliki posisi LOCKED dan sedang floating loss.
  runRecoveryCheck(price) {
    const lockedSides = new Set(
      this.positions.filter(p => p.status === 'LOCKED').map(p => p.side)
    );

    for (const side of lockedSides) {
      const sideFloating = this.positions
        .filter(p => p.side === side && p.status !== 'CLOSED')
        .reduce((sum, p) => sum + (p.floatingPnl || 0), 0);

      if (sideFloating < 0) {
        this.attemptRecovery(side, price, Math.abs(sideFloating));
      }
    }
  }

  attemptRecovery(side, price, floatingLossOnSide) {
    if (this.recoveryBudgetUsed >= this.recoveryBudget) {
      this.logEvent({ type: side, event: 'RECOVERY_SKIPPED', reason: 'RECOVERY_BUDGET_EXHAUSTED', price });
      return null;
    }
    if (floatingLossOnSide >= this.floatingBudget) {
      this.logEvent({ type: side, event: 'RECOVERY_SKIPPED', reason: 'FLOATING_LOSS_LIMIT', price });
      return null;
    }

    const sidePositions = this.positions.filter(p => p.side === side);
    const lastLot = sidePositions.length ? sidePositions[sidePositions.length - 1].lot : this.config.lotStart;

    if (lastLot >= this.config.lotMax) {
      this.logEvent({ type: side, event: 'RECOVERY_STOPPED', reason: 'LOT_MAX_REACHED', price });
      return null;
    }

    const nextLot = this.nextLadderLot(lastLot);
    const recoveryPosition = {
      id: `pos_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      side,
      lot: nextLot,
      entryPrice: price,
      status: 'ACTIVE',
      openTime: Date.now(),
      floatingPnl: 0
    };
    this.positions.push(recoveryPosition);
    this.cycle.recoveryCount += 1;
    this.cycle.maxLotUsed = Math.max(this.cycle.maxLotUsed, nextLot);
    this.recoveryBudgetUsed += nextLot; // proxy sederhana; bisa diganti margin riil

    this.logEvent({
      orderId: recoveryPosition.id, type: side, lot: nextLot, price,
      event: 'RECOVERY', reason: 'LADDER_STEP'
    });
    return recoveryPosition;
  }

  // ------------------------------------------------------------
  // 11. BASKET ENGINE
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
  // 12/13. BASKET TARGET & CLOSE RULE
  // ------------------------------------------------------------
  getBasketTargetPct(tqi) {
    if (tqi <= 30) return 0.03;
    if (tqi <= 60) return 0.05;
    if (tqi <= 80) return 0.10;
    // 81-100 -> band 20-30%, diskalakan linear terhadap posisi TQI dalam band
    const t = (tqi - 81) / (100 - 81);
    return 0.20 + t * 0.10;
  }

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
  // 14. GLOBAL RISK ENGINE
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
  // BOOTSTRAP CYCLE (Market Analysis -> Range -> Pending Deploy)
  // ------------------------------------------------------------
  startCycle(tqiComponents, candles, atr) {
    if (this.tradingDisabled) {
      return { started: false, reason: 'TRADING_DISABLED' };
    }

    const tqi = this.computeTQI(tqiComponents);
    this.cycle.tqiStart = tqi;
    this.cycle.marketMode = this.getMarketMode(tqi);
    this.cycle.basketTarget = this.cycle.equityStart * this.getBasketTargetPct(tqi);

    const range = this.detectRange(candles, atr);
    if (!range.valid) {
      this.logEvent({ event: 'RANGE_INVALID', reason: range.reason });
      return { started: false, reason: range.reason };
    }

    this.cycle.status = 'RANGE_DETECTED';
    this.deployPendingOrders(range, atr);

    return {
      started: true,
      tqi,
      classification: this.classifyTQI(tqi),
      mode: this.cycle.marketMode,
      range,
      basketTarget: this.cycle.basketTarget
    };
  }

  // ------------------------------------------------------------
  // 17. LOGGING / EXPORT (untuk tabel trading_cycle & trade_event)
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
