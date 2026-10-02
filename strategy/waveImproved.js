/**
 * waveImproved — precision-версія покращеної хвильової стратегії.
 *
 * Фокус: підвищення win-rate за рахунок фільтрації слабких/запізнілих входів.
 * Це НЕ гарантує 70% на будь-якому ринку; фактичний win-rate треба перевіряти
 * на out-of-sample історії з реальними fee/slippage.
 */

const { calculateMACD } = require('../indicators/macd');
const { calculateATR, getLastATR } = require('../indicators/atr');
const { calculateEMA } = require('../indicators/ema');
const { calculateADX } = require('../indicators/adx');

const defaults = {
  atrLength: 14,

  // Свіжий swing / wave
  waveLength: 24,
  minWaveAtr: 0.9,
  maxWaveAtr: 3.8,
  minWavePercent: 0.25,
  longWavePosition: 0.58,
  shortWavePosition: 0.42,

  // Тренд
  useTrendFilter: true,
  fastEmaLength: 34,
  trendEmaLength: 200,
  emaSlopeLookback: 5,
  minEmaSlopeAtr: 0.015,
  maxDistanceFromFastEmaAtr: 2.5,

  // ADX
  useAdxFilter: true,
  adxLength: 14,
  adxMin: 18,
  diGapMin: 1.5,

  // MACD
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  macdCrossLookback: 2,
  requireMacdZeroLine: false,
  requireHistogramSlope: true,

  // RSI
  rsiLength: 14,
  rsiLongMin: 51,
  rsiLongMax: 67,
  rsiShortMin: 33,
  rsiShortMax: 49,

  // Свічка
  minBodyAtr: 0.08,
  closePositionLong: 0.60,
  closePositionShort: 0.40,

  // Волатильність
  minAtrPercent: 0.12,

  // Виходи — орієнтир на вищий hit-rate
  atrMultiplierSL: 1.10,
  atrMultiplierTP: 1.90,
  trailActivationAtr: 1.20,
  trailOffsetAtr: 0.80
};

function calculateRSI(closes, length) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length <= length) return rsi;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i++) {
    const d = closes[i] - closes[i - 1];
    gain += Math.max(d, 0);
    loss += Math.max(-d, 0);
  }

  let avgGain = gain / length;
  let avgLoss = loss / length;
  rsi[length] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = length + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = ((avgGain * (length - 1)) + Math.max(d, 0)) / length;
    avgLoss = ((avgLoss * (length - 1)) + Math.max(-d, 0)) / length;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsi;
}

function recentCross(macd, signal, lookback, dir) {
  const end = macd.length - 1;
  const from = Math.max(1, end - lookback + 1);

  for (let i = end; i >= from; i--) {
    const pm = macd[i - 1];
    const cm = macd[i];
    const ps = signal[i - 1];
    const cs = signal[i];
    if ([pm, cm, ps, cs].some(v => v === null || !Number.isFinite(v))) continue;

    if (dir === 'up' && pm <= ps && cm > cs) return true;
    if (dir === 'down' && pm >= ps && cm < cs) return true;
  }

  return false;
}

function minCandles(p) {
  return Math.max(
    p.trendEmaLength + p.emaSlopeLookback + 5,
    p.macdSlow + p.macdSignal + p.macdCrossLookback + 10,
    p.waveLength + p.atrLength + 10,
    p.adxLength * 2 + 10,
    p.rsiLength + 10,
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

  // Поточна свічка виключена з swing-розрахунку.
  const start = n - 1 - p.waveLength;
  const endExclusive = n - 1;

  let hiIdx = start;
  let loIdx = start;
  for (let j = start + 1; j < endExclusive; j++) {
    if (highs[j] >= highs[hiIdx]) hiIdx = j;
    if (lows[j] <= lows[loIdx]) loIdx = j;
  }

  const swingHigh = highs[hiIdx];
  const swingLow = lows[loIdx];
  const range = swingHigh - swingLow;
  if (!(range > 0)) return { ready: false, reason: 'Wave: нульовий діапазон' };

  const wavePosition = (close - swingLow) / range;
  const upLegAtr = (close - swingLow) / atr;
  const downLegAtr = (swingHigh - close) / atr;

  const longWave =
    upLegAtr >= p.minWaveAtr &&
    upLegAtr <= p.maxWaveAtr &&
    wavePosition >= p.longWavePosition &&
    ((close - swingLow) / swingLow) * 100 >= p.minWavePercent;

  const shortWave =
    downLegAtr >= p.minWaveAtr &&
    downLegAtr <= p.maxWaveAtr &&
    wavePosition <= p.shortWavePosition &&
    ((swingHigh - close) / swingHigh) * 100 >= p.minWavePercent;

  // EMA trend + slope
  const fastEmaArr = calculateEMA(closes, p.fastEmaLength);
  const trendEmaArr = calculateEMA(closes, p.trendEmaLength);
  const fastEma = fastEmaArr[i];
  const trendEma = trendEmaArr[i];

  const fastSlopeAtr = Number.isFinite(fastEmaArr[i - p.emaSlopeLookback])
    ? (fastEma - fastEmaArr[i - p.emaSlopeLookback]) / atr
    : 0;

  const trendLong = !p.useTrendFilter || (
    Number.isFinite(fastEma) && Number.isFinite(trendEma) &&
    close > trendEma &&
    fastEma > trendEma &&
    fastSlopeAtr >= p.minEmaSlopeAtr
  );

  const trendShort = !p.useTrendFilter || (
    Number.isFinite(fastEma) && Number.isFinite(trendEma) &&
    close < trendEma &&
    fastEma < trendEma &&
    fastSlopeAtr <= -p.minEmaSlopeAtr
  );

  const distanceFromFastEmaAtr = Number.isFinite(fastEma)
    ? Math.abs(close - fastEma) / atr
    : Infinity;
  const notOverextended = distanceFromFastEmaAtr <= p.maxDistanceFromFastEmaAtr;

  // MACD
  const { macdLine, signalLine, histogram, isValid } = calculateMACD(
    closes, p.macdFast, p.macdSlow, p.macdSignal
  );
  if (!isValid) return { ready: false, reason: 'MACD: недостатньо даних' };

  const macd = macdLine[i];
  const macdSignal = signalLine[i];
  const hist = histogram[i];
  const histPrev = histogram[i - 1];

  const crossUp = recentCross(macdLine, signalLine, p.macdCrossLookback, 'up');
  const crossDown = recentCross(macdLine, signalLine, p.macdCrossLookback, 'down');

  const macdLong =
    crossUp &&
    macd > macdSignal &&
    (!p.requireMacdZeroLine || macd > 0) &&
    (!p.requireHistogramSlope || (Number.isFinite(hist) && Number.isFinite(histPrev) && hist >= histPrev));

  const macdShort =
    crossDown &&
    macd < macdSignal &&
    (!p.requireMacdZeroLine || macd < 0) &&
    (!p.requireHistogramSlope || (Number.isFinite(hist) && Number.isFinite(histPrev) && hist <= histPrev));

  // ADX / DI
  const adxR = calculateADX(highs, lows, closes, p.adxLength);
  const adx = adxR.adx[i];
  const plusDI = adxR.plusDI[i];
  const minusDI = adxR.minusDI[i];

  const adxLong = !p.useAdxFilter || (
    Number.isFinite(adx) && Number.isFinite(plusDI) && Number.isFinite(minusDI) &&
    adx >= p.adxMin && plusDI >= minusDI + p.diGapMin
  );

  const adxShort = !p.useAdxFilter || (
    Number.isFinite(adx) && Number.isFinite(plusDI) && Number.isFinite(minusDI) &&
    adx >= p.adxMin && minusDI >= plusDI + p.diGapMin
  );

  // RSI
  const rsi = calculateRSI(closes, p.rsiLength)[i];
  const rsiLong = Number.isFinite(rsi) && rsi >= p.rsiLongMin && rsi <= p.rsiLongMax;
  const rsiShort = Number.isFinite(rsi) && rsi >= p.rsiShortMin && rsi <= p.rsiShortMax;

  // Свічка-підтвердження
  const candleRange = high - low;
  const body = Math.abs(close - open);
  const closePos = candleRange > 0 ? (close - low) / candleRange : 0.5;

  const candleLong = body >= p.minBodyAtr * atr && close > open && closePos >= p.closePositionLong;
  const candleShort = body >= p.minBodyAtr * atr && close < open && closePos <= p.closePositionShort;

  const atrPct = (atr / close) * 100;
  const volOk = atrPct >= p.minAtrPercent;

  // 3 hard gates + 3 of 5 confirmations = 6/8 conditions.
  // ADX/RSI/candle/volatility/extension працюють як score, щоб не пропускати
  // якісний сигнал через один другорядний фільтр.
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
      fastEma,
      trendEma,
      fastSlopeAtr,
      distanceFromFastEmaAtr,
      adx,
      plusDI,
      minusDI,
      rsi,
      macd,
      macdSignal,
      macdHistogram: hist,
      atrPct
    },
    wave: {
      swingHigh,
      swingLow,
      hiIdx,
      loIdx,
      wavePosition,
      upLegAtr,
      downLegAtr
    },
    levels: {
      slDist: atr * p.atrMultiplierSL,
      tpDist: atr * p.atrMultiplierTP,
      trailActivationDist: atr * p.trailActivationAtr,
      trailOffsetDist: atr * p.trailOffsetAtr
    },
    checks: {
      long: [
        { name: 'Свіжа хвиля вверх', ok: longWave, value: `${upLegAtr.toFixed(2)} ATR / ${(wavePosition * 100).toFixed(1)}%` },
        { name: 'Тренд EMA', ok: trendLong },
        { name: 'ADX / DI', ok: adxLong, value: Number.isFinite(adx) ? `${adx.toFixed(1)} / ${plusDI.toFixed(1)} / ${minusDI.toFixed(1)}` : 'n/a' },
        { name: `MACD cross ≤ ${p.macdCrossLookback}`, ok: macdLong },
        { name: 'RSI зона', ok: rsiLong, value: Number.isFinite(rsi) ? rsi.toFixed(1) : 'n/a' },
        { name: 'Bullish candle', ok: candleLong },
        { name: 'ATR%', ok: volOk, value: `${atrPct.toFixed(3)}%` },
        { name: 'Не перегріта ціна', ok: notOverextended, value: `${distanceFromFastEmaAtr.toFixed(2)} ATR` }
      ],
      short: [
        { name: 'Свіжа хвиля вниз', ok: shortWave, value: `${downLegAtr.toFixed(2)} ATR / ${(wavePosition * 100).toFixed(1)}%` },
        { name: 'Тренд EMA', ok: trendShort },
        { name: 'ADX / DI', ok: adxShort, value: Number.isFinite(adx) ? `${adx.toFixed(1)} / ${plusDI.toFixed(1)} / ${minusDI.toFixed(1)}` : 'n/a' },
        { name: `MACD cross ≤ ${p.macdCrossLookback}`, ok: macdShort },
        { name: 'RSI зона', ok: rsiShort, value: Number.isFinite(rsi) ? rsi.toFixed(1) : 'n/a' },
        { name: 'Bearish candle', ok: candleShort },
        { name: 'ATR%', ok: volOk, value: `${atrPct.toFixed(3)}%` },
        { name: 'Не перегріта ціна', ok: notOverextended, value: `${distanceFromFastEmaAtr.toFixed(2)} ATR` }
      ]
    }
  };
}

module.exports = {
  id: 'waveImproved',
  title: 'Wave Precision Improved: swing + trend + ADX + RSI + MACD',
  defaults,
  minCandles,
  analyze
};
