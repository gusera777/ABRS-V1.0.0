/**
 * ============================================================
 *  ABRS V2.0 - Adaptive Breakout Recovery System
 *  Core Trading Logic Engine untuk GUSERA SATS
 *  (Basket Hedging + Reverse Martingale V2.0)
 * ============================================================
 *
 *  Implementasi murni client-side (vanilla JS), tanpa backend.
 *  Modul ini adalah SIGNAL / SIMULATION ENGINE - tidak melakukan
 *  eksekusi order nyata ke broker manapun. Semua "posisi" dan
 *  "pending order" adalah representasi virtual yang dihitung dari
 *  price feed dan bisa dipakai untuk:
 *    - menghasilkan sinyal ENTRY / PENDING / CLOSE
 *    - mencatat riwayat cycle untuk analisis / self-learning
 *    - ditampilkan di UI (status basket, TQI, target, dsb)
 *
 *  ------------------------------------------------------------
 *  RULE ENTRY (v2.0 - Basket Hedging + Reverse Martingale):
 *  ------------------------------------------------------------
 *  1. Begitu cycle dimulai, EA langsung membuka entry pertama
 *     (market) dengan lot Level 1 (default 0.10). Arah (BUY/SELL)
 *     ditentukan oleh arah trend jangka pendek (SMA cepat vs SMA
 *     lambat), atau opsional digerbang oleh filter TQI (lihat
 *     `tqiTrendFilter`).
 *
 *  2. Begitu entry pertama terbuka, EA langsung memasang SATU
 *     pending order lawan arah pada jarak tetap (`distancePoints`
 *     x `pointSize`) dari harga entry, dengan lot Level berikutnya
 *     dari Tabel Lot progresif (0.10, 0.30, 0.60, 1.20, 2.40, 4.80,
 *     9.60, 19.20, 38.40, 76.80 - x3 di level 2, x2 setiap level
 *     berikutnya).
 *
 *  3. Setiap kali pending order tersentuh (triggered), EA:
 *       a. Membuka posisi baru di level tsb.
 *       b. Menghapus pending order tsb (EA hanya boleh punya
 *          1 pending order aktif setiap saat).
 *       c. Memasang pending order BARU di sisi berlawanan, pada
 *          jarak tetap dari harga trigger, dengan lot level
 *          berikutnya.
 *     Siklus ini berulang: BUY -> SELL -> BUY -> SELL -> ...
 *     hingga salah satu sisi mencapai batas maksimum.
 *
 *  4. Batas posisi: Maksimum BUY = 10, Maksimum SELL = 10,
 *     Maksimum Total = 20. Begitu satu sisi mencapai batasnya,
 *     EA berhenti memasang pending baru di sisi itu (tidak
 *     membuat level 11) dan hanya mengelola basket yang sudah ada
 *     hingga target profit tercapai atau proteksi lain aktif.
 *
 *  5. Basket dianggap satu kesatuan - tidak ada TP/SL individual
 *     per posisi. Begitu total floating profit basket (BUY+SELL)
 *     >= target (default 1% Equity), SELURUH posisi ditutup
 *     sekaligus (Close All), pending order dihapus, dan basket
 *     di-reset kembali ke Level 1.
 *
 *  6. Proteksi tambahan (di luar dokumen rules asli, sebagai
 *     jaring pengaman opsional untuk trading akun riil): Stop
 *     Loss bertingkat & EMERGENCY (Global Risk) tetap tersedia dan
 *     bisa menutup basket lebih awal jika harga terus bergerak
 *     melawan basket tanpa reversal (tail risk dari sistem
 *     martingale-like ini tidak bisa dihilangkan sepenuhnya,
 *     hanya dibatasi).
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

      // --- Proteksi tambahan (opsional, di luar dokumen rules asli) ---
      globalRiskPct: config.globalRiskPct ?? 0.15,       // 15% dari modal - dipakai sbg jaring pengaman
      basketStopLossPct: config.basketStopLossPct ?? 0.6, // cycle ditutup 'LOSS' saat basketProfit <= -(globalRiskBudget * pct), sebelum menyentuh EMERGENCY penuh
      enableSafetyNet: config.enableSafetyNet ?? true,    // matikan jika ingin murni mengikuti dokumen rules (tanpa stoploss $)

      // --- Tabel Lot Progresif ---
      initialLot: config.initialLot ?? config.lotStart ?? 0.10, // lot Level 1
      // Multiplier relatif terhadap initialLot untuk Level 1..10.
      // Default (initialLot 0.10) menghasilkan 0.10, 0.30, 0.60, 1.20, 2.40, 4.80, 9.60, 19.20, 38.40, 76.80
      // (x3 dari Level 1 ke Level 2, lalu x2 setiap level berikutnya) - sesuai tabel lot dokumen.
      lotMultipliers: config.lotMultipliers ?? [1, 3, 6, 12, 24, 48, 96, 192, 384, 768],

      // --- Jarak Breakout / Pending Order ---
      distancePoints: config.distancePoints ?? 300,  // jarak antar level, dalam "point"
      pointSize: config.pointSize ?? 0.01,            // nilai harga 1 point (sesuaikan per instrumen: XAU~0.01, BTC~1, EUR/USD~0.0001, US30~1)

      // --- Batas Posisi ---
      maxBuy: config.maxBuy ?? 10,
      maxSell: config.maxSell ?? 10,
      maxTotal: config.maxTotal ?? (config.maxBuy != null && config.maxSell != null ? config.maxBuy + config.maxSell : 20),

      // --- Target Profit Basket ---
      // Jika basketTargetPct diisi (default 1% Equity), target dihitung sebagai
      // persentase dari equity awal cycle. basketTargetUsd (jika diisi) akan
      // dipakai sebagai override nilai tetap $ (menonaktifkan mode persentase).
      basketTargetPct: config.basketTargetPct ?? 0.01, // 1% Equity
      basketTargetUsd: config.basketTargetUsd ?? null,

      // --- Deteksi arah entry pertama (SMA cepat vs SMA lambat) ---
      trendFastPeriod: config.trendFastPeriod ?? 10,
      trendSlowPeriod: config.trendSlowPeriod ?? 30,

      // --- Filter TQI opsional (saran dari dokumen rules) ---
      // Jika enabled, cycle hanya dimulai bila TQI >= threshold, supaya entry
      // pertama searah dengan tren yang cukup kuat (bukan sekadar SMA silang tipis).
      tqiTrendFilter: config.tqiTrendFilter ?? { enabled: false, threshold: 70 },

      // Bobot komponen penyusun TQI (total idealnya = 1) - dipakai untuk info/analisa
      // dan (opsional) filter TQI di atas.
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

    this.lotTable = this.config.lotMultipliers.map(m => Math.round(this.config.initialLot * m * 100) / 100);

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
      basketTarget: null,    // target profit ($) untuk cycle ini (hasil hitung dari basketTargetPct atau basketTargetUsd)
      basketProfit: 0,
      maxDrawdown: 0,
      recoveryCount: 0,      // jumlah posisi tambahan di luar entry pertama (level 2, 3, dst yang sudah terpicu)
      maxLotUsed: 0,
      globalLevel: 0,        // step ke berapa dalam urutan alternating BUY/SELL (dipakai untuk indeks Tabel Lot)
      buyLevel: 0,           // jumlah posisi BUY yang sudah terbuka (0-10, dipakai untuk cek batas Max BUY)
      sellLevel: 0,          // jumlah posisi SELL yang sudah terbuka (0-10, dipakai untuk cek batas Max SELL)
      result: null,          // 'WIN' | 'LOSS' | 'EMERGENCY'
      status: 'IDLE'         // IDLE, BUY_ACTIVE, SELL_ACTIVE, CLOSED
    };

    this.positions = [];      // { id, side, lot, level, entryPrice, status, openTime, floatingPnl }
    this.pendingOrders = [];  // maksimum 1 item: { id, side, type, level, lot, triggerPrice, createdAt }
    this.events = [];

    this.globalRiskBudget = this.config.capital * this.config.globalRiskPct;
    this.tradingDisabled = false;
  }

  startNewCycleAfterClose() {
    const nextEquity = this.cycle.equityEnd ?? this.cycle.equityStart;
    this.resetCycle(nextEquity);
  }

  // ------------------------------------------------------------
  // TREND QUALITY INDEX (TQI) - komposit 0-100 (info/analisa + filter opsional)
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
  // MARKET MODE (info)
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
  // ENTRY ENGINE - membuka posisi. `level` = step ke berapa dalam
  // urutan alternating global (1 = entry pertama, 2 = pending
  // pertama yang triggered, dst) - dipakai untuk mengindeks Tabel
  // Lot (0.10, 0.30, 0.60, 1.20, ...), BUKAN hitungan per sisi.
  // ------------------------------------------------------------
  openPosition(side, lot, level, price, reason) {
    const position = {
      id: `pos_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      side,
      lot,
      level,
      entryPrice: price,
      status: 'ACTIVE',
      openTime: Date.now(),
      floatingPnl: 0
    };
    this.positions.push(position);
    this.cycle.maxLotUsed = Math.max(this.cycle.maxLotUsed, lot);
    this.cycle.globalLevel = Math.max(this.cycle.globalLevel, level);
    if (side === 'BUY') this.cycle.buyLevel += 1; else this.cycle.sellLevel += 1;
    if (level > 1) this.cycle.recoveryCount += 1;
    this.logEvent({ orderId: position.id, type: side, lot, level, price, event: 'ENTRY', reason });
    return position;
  }

  // ------------------------------------------------------------
  // DISTANCE (jarak antar level dalam satuan harga)
  // ------------------------------------------------------------
  getDistancePrice() {
    return this.config.distancePoints * this.config.pointSize;
  }

  // ------------------------------------------------------------
  // PENDING ORDER - memasang SATU pending order lawan arah, pada
  // jarak tetap dari harga acuan. Lot diambil dari Tabel Lot
  // berdasarkan STEP GLOBAL berikutnya dalam urutan alternating
  // (mis. BUY level1=0.01, SELL level2=0.03, BUY level3=0.06, ...
  // sesuai contoh alur di dokumen rules - bukan hitungan per sisi).
  // Tidak memasang apapun jika sisi tsb sudah mencapai batas
  // Max BUY/Max SELL, atau total posisi sudah mencapai maxTotal.
  // ------------------------------------------------------------
  placeNextPendingOrder(anchorPrice, justFilledSide, justFilledLevel = this.cycle.globalLevel) {
    this.pendingOrders = []; // EA hanya boleh punya 1 pending order aktif

    if (this.cycle.status === 'CLOSED' || this.tradingDisabled) return null;

    const totalOpen = this.cycle.buyLevel + this.cycle.sellLevel;
    if (totalOpen >= this.config.maxTotal) {
      this.logEvent({ event: 'PENDING_SKIPPED', reason: 'MAX_TOTAL_POSITIONS_REACHED' });
      return null;
    }

    const nextSide = justFilledSide === 'BUY' ? 'SELL' : 'BUY';
    const countForSide = nextSide === 'BUY' ? this.cycle.buyLevel : this.cycle.sellLevel;
    const maxForSide = nextSide === 'BUY' ? this.config.maxBuy : this.config.maxSell;

    if (countForSide >= maxForSide) {
      this.logEvent({ event: 'PENDING_SKIPPED', reason: `MAX_${nextSide}_POSITIONS_REACHED` });
      return null;
    }

    const nextGlobalLevel = justFilledLevel + 1;
    // Tabel Lot hanya mendefinisikan 10 level; jika urutan global melebihi 10
    // (mungkin terjadi karena Max BUY/SELL bisa sampai 10 masing-masing = 20 total),
    // gunakan lot Level 10 (nilai terbesar) untuk step-step selanjutnya.
    const lotIndex = Math.min(nextGlobalLevel, this.lotTable.length) - 1;
    const lot = this.lotTable[lotIndex];
    const distance = this.getDistancePrice();
    const triggerPrice = nextSide === 'BUY' ? anchorPrice + distance : anchorPrice - distance;

    const pending = {
      id: `pend_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      side: nextSide,
      type: nextSide === 'BUY' ? 'BUY_STOP' : 'SELL_STOP',
      level: nextGlobalLevel,
      lot,
      triggerPrice,
      createdAt: Date.now()
    };
    this.pendingOrders = [pending];
    this.logEvent({ orderId: pending.id, type: pending.type, lot, level: nextGlobalLevel, price: triggerPrice, event: 'PENDING_PLACED', reason: 'LADDER_NEXT_LEVEL' });
    return pending;
  }

  // ------------------------------------------------------------
  // CEK & EKSEKUSI PENDING ORDER - dipanggil tiap tick harga baru.
  // Jika trigger tersentuh: buka posisi di level tsb, hapus
  // pending, lalu pasang pending baru (lawan arah, level berikutnya)
  // jika kapasitas masih ada.
  // ------------------------------------------------------------
  checkPendingOrders(price) {
    if (this.tradingDisabled || this.cycle.status === 'CLOSED' || !this.pendingOrders.length) return null;

    const po = this.pendingOrders[0];
    const triggered = po.type === 'BUY_STOP' ? price >= po.triggerPrice : price <= po.triggerPrice;
    if (!triggered) return null;

    const position = this.openPosition(po.side, po.lot, po.level, po.triggerPrice, 'PENDING_ORDER_TRIGGERED');
    this.logEvent({ orderId: po.id, type: po.type, lot: po.lot, level: po.level, price: po.triggerPrice, event: 'PENDING_FILLED', reason: 'PRICE_REACHED_TRIGGER' });

    this.placeNextPendingOrder(po.triggerPrice, po.side, po.level);

    return position;
  }

  // Alias kompatibilitas (nama lama dipakai UI sebelumnya)
  checkHedgeTrigger(price) {
    return this.checkPendingOrders(price);
  }

  // ------------------------------------------------------------
  // TICK HANDLER - dipanggil setiap ada harga baru
  // ------------------------------------------------------------
  onPriceTick(price) {
    if (this.tradingDisabled) return;

    this.checkPendingOrders(price);
    this.updateFloating(price);
    if (this.config.enableSafetyNet) this.checkGlobalRisk();
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
  // BASKET TARGET & CLOSE RULE - Close All saat profit >= target
  // (persentase equity, default 1%, atau override $ tetap)
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
    if (this.pendingOrders.length) {
      this.logEvent({ event: 'PENDING_DELETED', reason: `BASKET_${result}` });
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
  // GLOBAL RISK ENGINE (proteksi tambahan / jaring pengaman opsional,
  // di luar dokumen rules asli - lihat enableSafetyNet)
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
  // BOOTSTRAP CYCLE - entry pertama langsung (market) di Level 1,
  // lalu langsung memasang pending order lawan arah di Level 2.
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
    const filter = this.config.tqiTrendFilter;
    if (filter && filter.enabled && tqi < filter.threshold) {
      return { started: false, reason: 'TQI_BELOW_TREND_FILTER_THRESHOLD', tqi };
    }

    this.cycle.tqiStart = tqi;
    this.cycle.marketMode = this.getMarketMode(tqi);
    this.cycle.basketTarget = this.config.basketTargetUsd != null
      ? this.config.basketTargetUsd
      : this.cycle.equityStart * this.config.basketTargetPct;

    const direction = this.detectTrendDirection(candles);
    this.cycle.initialSide = direction;
    this.cycle.status = direction === 'BUY' ? 'BUY_ACTIVE' : 'SELL_ACTIVE';

    this.openPosition(direction, this.lotTable[0], 1, currentPrice, 'INITIAL_ENTRY');
    this.placeNextPendingOrder(currentPrice, direction, 1);

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
      lotTable: [...this.lotTable],
      risk: {
        globalRiskBudget: this.globalRiskBudget,
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
