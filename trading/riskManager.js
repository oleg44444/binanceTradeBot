/**
 * RiskManager — розмір позиції від ризику + захисні ліміти.
 *  • calcQty:   qty = (баланс × riskPercent) / відстань до SL, з обмеженням по плечу
 *  • canTrade:  денний ліміт збитку та пауза після серії збитків
 * Використовується і в живому боті, і в бектесті (час передається параметром `now`).
 */
const stateStore = require('../utils/stateStore');

const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

class RiskManager {
  constructor(cfg = {}, { persistName = null } = {}) {
    this.cfg = {
      sizing: 'risk',
      tradeAmount: 1,
      riskPercent: 1,
      maxLeverageUse: 0.8,
      maxDailyLossPercent: 5,
      maxConsecutiveLosses: 3,
      pauseMinutes: 120,
      ...cfg
    };
    this.persistName = persistName;
    this.state = { day: null, dayStartEquity: 0, dailyPnl: 0, consecutiveLosses: 0, pausedUntil: 0 };

    if (persistName) {
      const saved = stateStore.read(persistName);
      if (saved) this.state = { ...this.state, ...saved };
    }
  }

  _save() {
    if (this.persistName) stateStore.write(this.persistName, this.state);
  }

  _rollDay(equity, now) {
    const key = dayKey(now);
    if (this.state.day !== key) {
      this.state.day = key;
      this.state.dayStartEquity = equity;
      this.state.dailyPnl = 0;
      this._save();
    }
  }

  /** Чи можна відкривати нову угоду зараз. */
  canTrade(equity, now = Date.now()) {
    this._rollDay(equity, now);

    if (now < this.state.pausedUntil) {
      const mins = Math.ceil((this.state.pausedUntil - now) / 60000);
      return { ok: false, reason: `пауза після ${this.cfg.maxConsecutiveLosses} збитків підряд (ще ~${mins} хв)` };
    }

    const limit = (this.state.dayStartEquity * this.cfg.maxDailyLossPercent) / 100;
    if (this.cfg.maxDailyLossPercent > 0 && this.state.dailyPnl <= -limit) {
      return {
        ok: false,
        reason: `досягнуто денний ліміт збитку (${this.state.dailyPnl.toFixed(2)} USDT ≤ -${limit.toFixed(2)})`
      };
    }
    return { ok: true };
  }

  /** Записати результат закритої угоди (чистий PnL у USDT). Повертає подію, якщо спрацювала пауза. */
  recordResult(pnl, equity = 0, now = Date.now()) {
    this._rollDay(equity || this.state.dayStartEquity, now);
    this.state.dailyPnl += pnl;

    let event = null;
    if (pnl < 0) {
      this.state.consecutiveLosses += 1;
      if (this.cfg.maxConsecutiveLosses > 0 && this.state.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
        this.state.pausedUntil = now + this.cfg.pauseMinutes * 60000;
        this.state.consecutiveLosses = 0;
        event = `⏸️ Пауза ${this.cfg.pauseMinutes} хв після ${this.cfg.maxConsecutiveLosses} збитків підряд`;
      }
    } else if (pnl > 0) {
      this.state.consecutiveLosses = 0;
    }
    this._save();
    return event;
  }

  /**
   * Розмір позиції (у базовій монеті, ще без округлення по кроку біржі).
   * Повертає { qty, note }.
   */
  calcQty({ equity, price, slDistance, leverage = 1 }) {
    if (this.cfg.sizing === 'fixed') {
      return { qty: this.cfg.tradeAmount, note: 'фіксований розмір' };
    }
    if (!(equity > 0) || !(slDistance > 0) || !(price > 0)) {
      return { qty: 0, note: 'некоректні дані для розрахунку розміру' };
    }

    const riskAmount = (equity * this.cfg.riskPercent) / 100;
    let qty = riskAmount / slDistance;

    const maxQty = (equity * leverage * this.cfg.maxLeverageUse) / price;
    let note = `ризик ${this.cfg.riskPercent}% = ${riskAmount.toFixed(2)} USDT`;
    if (qty > maxQty) {
      qty = maxQty;
      note += `, обмежено плечем (${leverage}x × ${this.cfg.maxLeverageUse})`;
    }
    return { qty, note };
  }
}

module.exports = RiskManager;
