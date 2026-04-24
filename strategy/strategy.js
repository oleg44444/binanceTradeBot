/**
 * strategy.js
 * Точна реалізація Pine Script стратегії:
 * "Інноваційна хвильова стратегія з адаптивністю + Trailing Stop"
 *
 * Ключові відмінності від попередньої версії:
 * - lastWaveLow/lastWaveHigh — накопичувальні (як `var float` в Pine)
 * - waveChangeUp  = (high - lastWaveLow)  / lastWaveLow   (від HIGH свічки)
 * - waveChangeDown = (lastWaveHigh - low) / lastWaveHigh  (від LOW свічки)
 * - SL/TP/Trail рахуються від CLOSE на момент сигналу, множники ATR як в Pine
 */

const { calculateMACD, isMACDCrossover, isMACDCrossunder } = require('../indicators/macd');
const { calculateATR, getLastATR } = require('../indicators/atr');
const { calculateDynamicWaveLength } = require('../indicators/waves');

// ─── Параметри за замовчуванням (відповідають input-ам в Pine) ────────────────
const DEFAULTS = {
  minWaveLength:       8,
  maxWaveLength:       21,
  atrLength:           14,
  atrMultiplierSL:     1.0,   // stop    = close ± atr * 1.0
  atrMultiplierTP:     5.0,   // limit   = close ± atr * 5.0
  atrMultiplierTrail:  1.0,   // trail   = atr * 1.0
  waveThreshold:       0.003, // 0.3%
  macdFast:            12,
  macdSlow:            26,
  macdSignal:          9
};

/**
 * Обчислює накопичувальні lastWaveLow / lastWaveHigh по всій історії свічок —
 * точно як `var float` змінні в Pine Script.
 *
 * Pine:
 *   if (na(lastWaveLow) or low < lastWaveLow)  lastWaveLow  := low
 *   if (na(lastWaveHigh) or high > lastWaveHigh) lastWaveHigh := high
 *
 * @param {number[]} highs
 * @param {number[]} lows
 * @returns {{ lastWaveHigh: number, lastWaveLow: number }}
 */
function calcRunningWaveExtremes(highs, lows) {
  let lastWaveLow  = null;
  let lastWaveHigh = null;

  for (let i = 0; i < highs.length; i++) {
    if (lastWaveLow  === null || lows[i]  < lastWaveLow)  lastWaveLow  = lows[i];
    if (lastWaveHigh === null || highs[i] > lastWaveHigh) lastWaveHigh = highs[i];
  }

  return { lastWaveHigh, lastWaveLow };
}

/**
 * Головна функція розрахунку індикаторів.
 *
 * @param {Array}       candles   - OHLCV свічки [[ts, o, h, l, c, v], ...]
 * @param {object}      cfg       - перевизначення параметрів (опціонально)
 * @param {number|null} livePrice - поточна ціна з fetchTicker (для currentClose)
 * @returns {object}
 */
function calculateAllIndicators(candles, cfg = {}, livePrice = null) {
  const p = { ...DEFAULTS, ...cfg };

  const closes = candles.map(c => c[4]);
  const highs  = candles.map(c => c[2]);
  const lows   = candles.map(c => c[3]);

  // Поточна ціна закриття — жива якщо є, інакше остання свічка
  const currentClose = (livePrice && !isNaN(Number(livePrice)))
    ? Number(livePrice)
    : closes[closes.length - 1];

  // Поточні high/low останньої (незакритої або останньої закритої) свічки
  const currentHigh = highs[highs.length - 1];
  const currentLow  = lows[lows.length - 1];

  // ── ATR ──────────────────────────────────────────────────────────────────
  const atrArray   = calculateATR(highs, lows, closes, p.atrLength);
  const currentATR = getLastATR(atrArray);

  if (!currentATR) return { isValid: false, reason: 'ATR: недостатньо даних' };

  // ── Динамічна довжина хвилі ───────────────────────────────────────────────
  // Pine: waveLengthDynamicRaw = atr * 10
  //       waveLengthDynamic = round(clamp(raw, min, max))
  const waveLength = calculateDynamicWaveLength(currentATR, p.minWaveLength, p.maxWaveLength);

  // ── Локальні хвилі (ta.highest / ta.lowest) ───────────────────────────────
  // Pine: waveHigh = ta.highest(high, waveLengthDynamic)
  //       waveLow  = ta.lowest(low,  waveLengthDynamic)
  const sliceHighs = highs.slice(-waveLength);
  const sliceLows  = lows.slice(-waveLength);
  const waveHigh   = Math.max(...sliceHighs);
  const waveLow    = Math.min(...sliceLows);

  // ── Накопичувальні екстремуми (var float у Pine) ──────────────────────────
  const { lastWaveHigh, lastWaveLow } = calcRunningWaveExtremes(highs, lows);

  if (lastWaveLow === null || lastWaveHigh === null) {
    return { isValid: false, reason: 'Waves: недостатньо даних' };
  }

  // ── Зміна хвилі ──────────────────────────────────────────────────────────
  // Pine: waveChangeUp   = (high - lastWaveLow)  / lastWaveLow
  //       waveChangeDown = (lastWaveHigh - low)  / lastWaveHigh
  const waveChangeUp   = lastWaveLow  !== 0 ? (currentHigh - lastWaveLow)  / lastWaveLow  : 0;
  const waveChangeDown = lastWaveHigh !== 0 ? (lastWaveHigh - currentLow) / lastWaveHigh  : 0;

  // ── MACD ─────────────────────────────────────────────────────────────────
  const { macdLine, signalLine, isValid: macdValid } = calculateMACD(
    closes, p.macdFast, p.macdSlow, p.macdSignal
  );

  if (!macdValid) return { isValid: false, reason: 'MACD: недостатньо даних' };

  return {
    isValid: true,
    // Ціни
    currentClose,
    currentHigh,
    currentLow,
    // ATR
    atr: currentATR,
    // Хвилі
    waveLength,
    waves: {
      waveHigh,
      waveLow,
      lastWaveHigh,
      lastWaveLow,
      waveChangeUp,
      waveChangeDown,
      waveThreshold: p.waveThreshold
    },
    // MACD
    macd: { macdLine, signalLine },
    // Множники для стопів
    multipliers: {
      sl:    p.atrMultiplierSL,
      tp:    p.atrMultiplierTP,
      trail: p.atrMultiplierTrail
    }
  };
}

/**
 * Розрахунок SL / TP / Trail — точно як в Pine strategy.exit:
 *
 * Long:  stop  = close - atr * atrMultiplierSL
 *        limit = close + atr * atrMultiplierTP
 *        trail = atr * atrMultiplierTrail
 *
 * Short: stop  = close + atr * atrMultiplierSL
 *        limit = close - atr * atrMultiplierTP
 *        trail = atr * atrMultiplierTrail
 *
 * @param {number} closePrice  - ціна закриття в момент сигналу
 * @param {number} atr         - поточний ATR
 * @param {string} side        - 'long' | 'short'
 * @param {object} multipliers - {sl, tp, trail}
 */
function calculateStopsAndTP(closePrice, atr, side, multipliers = {}) {
  const sl    = multipliers.sl    ?? DEFAULTS.atrMultiplierSL;
  const tp    = multipliers.tp    ?? DEFAULTS.atrMultiplierTP;
  const trail = multipliers.trail ?? DEFAULTS.atrMultiplierTrail;

  const slDist    = atr * sl;
  const tpDist    = atr * tp;
  const trailDist = atr * trail;

  const stopLoss   = side === 'long' ? closePrice - slDist : closePrice + slDist;
  const takeProfit = side === 'long' ? closePrice + tpDist : closePrice - tpDist;

  return {
    stopLoss:             Number(stopLoss.toFixed(4)),
    takeProfit:           Number(takeProfit.toFixed(4)),
    trailingStopDistance: Number(trailDist.toFixed(4))
  };
}

/**
 * Перевірка LONG сигналу.
 * Pine:
 *   longWaveCondition = waveChangeUp > 0.003
 *   longMacdCondition = ta.crossover(macdLine, signalLine)
 *   longConfirm       = longWaveCondition and longMacdCondition and close > lastWaveLow
 */
function checkBuySignal(indicators) {
  if (!indicators?.isValid) return { signal: false, details: {} };

  const { currentClose, currentHigh, waves, macd } = indicators;
  const { waveChangeUp, waveThreshold, lastWaveLow, lastWaveHigh, waveHigh, waveLow } = waves;
  const { macdLine, signalLine } = macd;

  const waveOk  = waveChangeUp > waveThreshold;               // waveChangeUp > 0.003
  const macdOk  = isMACDCrossover(macdLine, signalLine);      // ta.crossover
  const closeOk = currentClose > lastWaveLow;                 // close > lastWaveLow

  const signal = waveOk && macdOk && closeOk;

  console.log(`
  📊 === BUY SIGNAL ANALYSIS ===
  🌊 Wave Up: ${(waveChangeUp * 100).toFixed(3)}% [high=${currentHigh.toFixed(4)}, lastWaveLow=${lastWaveLow.toFixed(4)}] (${waveOk ? '✅' : '❌'} > ${(waveThreshold * 100).toFixed(1)}%)
  📈 MACD Crossover: ${macdOk ? '✅' : '❌'}
  💹 Close > lastWaveLow: ${currentClose.toFixed(4)} > ${lastWaveLow.toFixed(4)} (${closeOk ? '✅' : '❌'})
  📍 waveHigh: ${waveHigh.toFixed(4)}, waveLow: ${waveLow.toFixed(4)}
  🎯 RESULT: ${signal ? '✅ BUY SIGNAL' : '❌ NO SIGNAL'}
  `);

  return { signal, details: { waveChangeUp, waveOk, macdOk, closeOk, currentClose, lastWaveLow, lastWaveHigh } };
}

/**
 * Перевірка SHORT сигналу.
 * Pine:
 *   shortWaveCondition = waveChangeDown > 0.003
 *   shortMacdCondition = ta.crossunder(macdLine, signalLine)
 *   shortConfirm       = shortWaveCondition and shortMacdCondition and close < lastWaveHigh
 */
function checkSellSignal(indicators) {
  if (!indicators?.isValid) return { signal: false, details: {} };

  const { currentClose, currentLow, waves, macd } = indicators;
  const { waveChangeDown, waveThreshold, lastWaveHigh, lastWaveLow, waveHigh, waveLow } = waves;
  const { macdLine, signalLine } = macd;

  const waveOk  = waveChangeDown > waveThreshold;             // waveChangeDown > 0.003
  const macdOk  = isMACDCrossunder(macdLine, signalLine);     // ta.crossunder
  const closeOk = currentClose < lastWaveHigh;                // close < lastWaveHigh

  const signal = waveOk && macdOk && closeOk;

  console.log(`
  📊 === SELL SIGNAL ANALYSIS ===
  🌊 Wave Down: ${(waveChangeDown * 100).toFixed(3)}% [low=${currentLow.toFixed(4)}, lastWaveHigh=${lastWaveHigh.toFixed(4)}] (${waveOk ? '✅' : '❌'} > ${(waveThreshold * 100).toFixed(1)}%)
  📉 MACD Crossunder: ${macdOk ? '✅' : '❌'}
  💹 Close < lastWaveHigh: ${currentClose.toFixed(4)} < ${lastWaveHigh.toFixed(4)} (${closeOk ? '✅' : '❌'})
  📍 waveHigh: ${waveHigh.toFixed(4)}, waveLow: ${waveLow.toFixed(4)}
  🎯 RESULT: ${signal ? '✅ SELL SIGNAL' : '❌ NO SIGNAL'}
  `);

  return { signal, details: { waveChangeDown, waveOk, macdOk, closeOk, currentClose, lastWaveHigh, lastWaveLow } };
}

module.exports = {
  calculateAllIndicators,
  calculateStopsAndTP,
  checkBuySignal,
  checkSellSignal
};