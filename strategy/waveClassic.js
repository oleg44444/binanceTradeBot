/**
 * waveClassic — консервативна версія класичної хвильової стратегії.
 *
 * Головні зміни:
 *  1. Попередній екстремум НЕ включає поточну свічку (без look-ahead).
 *  2. Хвиля оцінюється через діапазон попереднього вікна + ATR.
 *  3. Додані EMA trend filter, ADX/DI, RSI, MACD zero-line та перевірка розміру тіла свічки.
 *  4. MACD crossover допускається в останніх N закритих свічках.
 *  5. Вхід не дозволяється, якщо ціна вже надто далеко від EMA — захист від FOMO-входів.
 *  6. Виходи налаштовані під вищий hit-rate: помірний TP і коротший trailing.
 */

const { calculateMACD } = require('../indicators/macd');
const { calculateATR, getLastATR } = require('../indicators/atr');
const { calculateEMA } = require('../indicators/ema');
const { calculateADX } = require('../indicators/adx');

const defaults = {
  atrLength: 14,

  // Wave
  waveLookback: 32,
  waveThreshold: 0.0035,    // 0.35%
  minWaveAtr: 1.0,
  maxWaveAtr: 4.5,
  minWavePositionLong: 0.62,
  maxWavePositionShort: 0.38,

  // Trend
  emaFastLength: 50,
  emaSlowLength: 200,
  emaSlopeLookback: 5,
  minEmaSlopeAtr: 0.02,
  maxDistanceFromEmaAtr: 2.8,

  // ADX
  adxLength: 14,
  adxMin: 18,
  diGapMin: 2,

  // Momentum
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  macdCrossLookback: 2,
  requireMacdZeroLine: true,

  // RSI
  rsiLength: 14,
  rsiLongMin: 52,
  rsiLongMax: 68,
  rsiShortMin: 32,
  rsiShortMax: 48,

  // Candle confirmation
  minBodyAtr: 0.10,
  minClosePosition: 0.62,

  // Volatility
  minAtrPercent: 0.12,

  // Risk / exits
  atrMultiplierSL: 1.15,
  atrMultiplierTP: 2.10,
  atrMultiplierTrailActivation: 1.25,
  atrMultiplierTrail: 0.85
};

function calculateRSI(closes, length) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length <= length) return rsi;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }

  let avgGain = gain / length;
  let avgLoss = loss / length;
  rsi[length] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = length + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    avgGain = ((avgGain * (length - 1)) + g) / length;
    avgLoss = ((avgLoss * (length - 1)) + l) / length;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsi;
}

function recentCross(macd, signal, lookback, direction) {
  const end = macd.length - 1;
  const from = Math.max(1, end - lookback + 1);

  for (let i = end; i >= from; i--) {
    const a = macd[i - 1];
    const b = macd[i];
    const sa = signal[i - 1];
    const sb = signal[i];
    if ([a, b, sa, sb].some(v => v === null || !Number.isFinite(v))) continue;

    if (direction === 'up' && a <= sa && b > sb) return true;
    if (direction === 'down' && a >= sa && b < sb) return true;
  }

  return false;
}

function minCandles(p) {
  return Math.max(
    p.emaSlowLength + p.emaSlopeLookback + 5,
    p.macdSlow + p.macdSignal + p.macdCrossLookback + 10,
    p.atrLength + p.waveLookback + 10,
    p.rsiLength + 10,
    p.adxLength * 2 + 10,
    250
  );
}

function analyze(candles, p) {
  if (candles.length < minCandles(p)) {
    return { ready: false, reason: `потрібно ≥ ${minCandles(p)} свічок, є ${candles.length}` };
  }

  const n = candles.length;
  const i = n - 1;
  const highs = candles.map(c => c[2]);
  const lows = candles.map(c => c[3]);
  const closes = candles.map(c => c[4]);
  const opens = candles.map(c => c[1]);

  const open = opens[i];
  const high = highs[i];
  const low = lows[i];
  const close = closes[i];

  const atr = getLastATR(calculateATR(highs, lows, closes, p.atrLength));
  if (!Number.isFinite(atr) || atr <= 0) {
    return { ready: false, reason: 'ATR: недостатньо даних' };
  }

  // Попереднє вікно — поточна свічка не входить.
  const start = n - 1 - p.waveLookback;
  const prevHighs = highs.slice(start, n - 1);
  const prevLows = lows.slice(start, n - 1);
  const previousHigh = Math.max(...prevHighs);
  const previousLow = Math.min(...prevLows);
  const range = previousHigh - previousLow;
  if (!(range > 0)) return { ready: false, reason: 'Wave: нульовий діапазон' };

  let highIdx = start;
  let lowIdx = start;
  for (let j = start + 1; j < n - 1; j++) {
    if (highs[j] >= highs[highIdx]) highIdx = j;
    if (lows[j] <= lows[lowIdx]) lowIdx = j;
  }

  const wavePosition = (close - previousLow) / range;
  const upLegAtr = (close - previousLow) / atr;
  const downLegAtr = (previousHigh - close) / atr;

  const longWave =
    upLegAtr >= p.minWaveAtr &&
    upLegAtr <= p.maxWaveAtr &&
    wavePosition >= p.minWavePositionLong &&
    (close - previousLow) / previousLow >= p.waveThreshold;

  const shortWave =
    downLegAtr >= p.minWaveAtr &&
    downLegAtr <= p.maxWaveAtr &&
    wavePosition <= p.maxWavePositionShort &&
    (previousHigh - close) / previousHigh >= p.waveThreshold;

  const emaFastArr = calculateEMA(closes, p.emaFastLength);
  const emaSlowArr = calculateEMA(closes, p.emaSlowLength);
  const emaFast = emaFastArr[i];
  const emaSlow = emaSlowArr[i];
  const emaSlopeAtr =
    Number.isFinite(emaFastArr[i - p.emaSlopeLookback])
      ? (emaFast - emaFastArr[i - p.emaSlopeLookback]) / atr
      : 0;

  const trendLong =
    Number.isFinite(emaFast) &&
    Number.isFinite(emaSlow) &&
    close > emaSlow &&
    emaFast > emaSlow &&
    emaSlopeAtr >= p.minEmaSlopeAtr;

  const trendShort =
    Number.isFinite(emaFast) &&
    Number.isFinite(emaSlow) &&
    close < emaSlow &&
    emaFast < emaSlow &&
    emaSlopeAtr <= -p.minEmaSlopeAtr;

  const distanceFromEmaAtr = emaFast && Number.isFinite(emaFast)
    ? Math.abs(close - emaFast) / atr
    : Infinity;
  const notOverextended = distanceFromEmaAtr <= p.maxDistanceFromEmaAtr;

  const { macdLine, signalLine, histogram, isValid } = calculateMACD(
    closes, p.macdFast, p.macdSlow, p.macdSignal
  );
  if (!isValid) return { ready: false, reason: 'MACD: недостатньо даних' };

  const macdNow = macdLine[i];
  const signalNow = signalLine[i];
  const histNow = histogram[i];
  const histPrev = histogram[i - 1];

  const macdCrossUp = recentCross(macdLine, signalLine, p.macdCrossLookback, 'up');
  const macdCrossDown = recentCross(macdLine, signalLine, p.macdCrossLookback, 'down');

  const macdLong =
    macdCrossUp &&
    macdNow > signalNow &&
    (!p.requireMacdZeroLine || macdNow > 0) &&
    Number.isFinite(histNow) && Number.isFinite(histPrev) && histNow >= histPrev;

  const macdShort =
    macdCrossDown &&
    macdNow < signalNow &&
    (!p.requireMacdZeroLine || macdNow < 0) &&
    Number.isFinite(histNow) && Number.isFinite(histPrev) && histNow <= histPrev;

  const adxR = calculateADX(highs, lows, closes, p.adxLength);
  const adx = adxR.adx[i];
  const plusDI = adxR.plusDI[i];
  const minusDI = adxR.minusDI[i];

  const adxLong = Number.isFinite(adx) && Number.isFinite(plusDI) && Number.isFinite(minusDI) &&
    adx >= p.adxMin && plusDI >= minusDI + p.diGapMin;
  const adxShort = Number.isFinite(adx) && Number.isFinite(plusDI) && Number.isFinite(minusDI) &&
    adx >= p.adxMin && minusDI >= plusDI + p.diGapMin;

  const rsi = calculateRSI(closes, p.rsiLength)[i];
  const rsiLong = Number.isFinite(rsi) && rsi >= p.rsiLongMin && rsi <= p.rsiLongMax;
  const rsiShort = Number.isFinite(rsi) && rsi >= p.rsiShortMin && rsi <= p.rsiShortMax;

  const candleRange = high - low;
  const body = Math.abs(close - open);
  const closePos = candleRange > 0 ? (close - low) / candleRange : 0.5;
  const candleLong = body >= p.minBodyAtr * atr && close > open && closePos >= p.minClosePosition;
  const candleShort = body >= p.minBodyAtr * atr && close < open && closePos <= (1 - p.minClosePosition);

  const atrPct = (atr / close) * 100;
  const volOk = atrPct >= p.minAtrPercent;

  // 3 hard gates + 3 of 5 confirmations = 6/8 conditions.
  // Це дає менше шумових входів, але не перетворює стратегію на систему без угод.
  const longConfirmations = [adxLong, rsiLong, candleLong, volOk, notOverextended].filter(Boolean).length;
  const shortConfirmations = [adxShort, rsiShort, candleShort, volOk, notOverextended].filter(Boolean).length;
  const longOk = longWave && trendLong && macdLong && longConfirmations >= 3;
  const shortOk = shortWave && trendShort && macdShort && shortConfirmations >= 3;

  const signal = longOk && !shortOk ? 'buy' : shortOk && !longOk ? 'sell' : null;

  return {
    ready: true,
    signal,
    price: close,
    atr,
    indicators: {
      emaFast,
      emaSlow,
      emaSlopeAtr,
      distanceFromEmaAtr,
      adx,
      plusDI,
      minusDI,
      rsi,
      macd: macdNow,
      macdSignal: signalNow,
      macdHistogram: histNow,
      atrPct
    },
    wave: {
      previousHigh,
      previousLow,
      highIdx,
      lowIdx,
      wavePosition,
      upLegAtr,
      downLegAtr
    },
    levels: {
      slDist: atr * p.atrMultiplierSL,
      tpDist: atr * p.atrMultiplierTP,
      trailActivationDist: atr * p.atrMultiplierTrailActivation,
      trailOffsetDist: atr * p.atrMultiplierTrail
    },
    checks: {
      long: [
        { name: 'Хвиля вверх', ok: longWave, value: `${upLegAtr.toFixed(2)} ATR / ${(wavePosition * 100).toFixed(1)}% діапазону` },
        { name: 'Тренд EMA', ok: trendLong, value: `EMA${p.emaFastLength} / EMA${p.emaSlowLength}` },
        { name: `MACD cross ≤ ${p.macdCrossLookback}`, ok: macdLong, value: `hist ${Number(histNow).toFixed(4)}` },
        { name: `ADX ≥ ${p.adxMin}`, ok: adxLong, value: Number.isFinite(adx) ? `${adx.toFixed(1)} / +DI ${plusDI.toFixed(1)} / -DI ${minusDI.toFixed(1)}` : 'n/a' },
        { name: 'RSI зона', ok: rsiLong, value: Number.isFinite(rsi) ? rsi.toFixed(1) : 'n/a' },
        { name: 'Bullish candle', ok: candleLong, value: `body ${body.toFixed(2)}, closePos ${(closePos * 100).toFixed(1)}%` },
        { name: 'ATR%', ok: volOk, value: `${atrPct.toFixed(3)}%` },
        { name: 'Не перегріта ціна', ok: notOverextended, value: `${distanceFromEmaAtr.toFixed(2)} ATR від EMA${p.emaFastLength}` }
      ],
      short: [
        { name: 'Хвиля вниз', ok: shortWave, value: `${downLegAtr.toFixed(2)} ATR / ${(wavePosition * 100).toFixed(1)}% діапазону` },
        { name: 'Тренд EMA', ok: trendShort, value: `EMA${p.emaFastLength} / EMA${p.emaSlowLength}` },
        { name: `MACD cross ≤ ${p.macdCrossLookback}`, ok: macdShort, value: `hist ${Number(histNow).toFixed(4)}` },
        { name: `ADX ≥ ${p.adxMin}`, ok: adxShort, value: Number.isFinite(adx) ? `${adx.toFixed(1)} / +DI ${plusDI.toFixed(1)} / -DI ${minusDI.toFixed(1)}` : 'n/a' },
        { name: 'RSI зона', ok: rsiShort, value: Number.isFinite(rsi) ? rsi.toFixed(1) : 'n/a' },
        { name: 'Bearish candle', ok: candleShort, value: `body ${body.toFixed(2)}, closePos ${(closePos * 100).toFixed(1)}%` },
        { name: 'ATR%', ok: volOk, value: `${atrPct.toFixed(3)}%` },
        { name: 'Не перегріта ціна', ok: notOverextended, value: `${distanceFromEmaAtr.toFixed(2)} ATR від EMA${p.emaFastLength}` }
      ]
    }
  };
}

module.exports = {
  id: 'waveClassic',
  title: 'Wave Precision Classic: хвиля + EMA + ADX + RSI + MACD',
  defaults,
  minCandles,
  analyze
};
