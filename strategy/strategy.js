const { calculateMACD, isMACDCrossover, isMACDCrossunder } = require('../indicators/macd');
const { calculateATR, getLastATR } = require('../indicators/atr');
const { 
  calculateWavePatterns, 
  calculateDynamicWaveLength, 
  calculateWaveChange 
} = require('../indicators/waves');

/**
 * Перевірка BUY сигналу за стратегією TradingView
 * Умови:
 * 1. Хвиля йде ВГОРУ > 0.3%
 * 2. MACD перетинає Signal Line (crossover)
 * 3. Ціна > локального мінімуму хвилі
 */
function checkBuySignal(candles, config = {}) {
  const {
    minWaveLength = 8,
    maxWaveLength = 21,
    waveThreshold = 0.003, // 0.3%
    atrLength = 14,
    macdFast = 12,
    macdSlow = 26,
    macdSignal = 9
  } = config;

  const closes = candles.map(c => c[4]);
  const highs = candles.map(c => c[2]);
  const lows = candles.map(c => c[3]);
  const currentPrice = closes[closes.length - 1];

  // Розраховуємо ATR
  const atr = calculateATR(highs, lows, closes, atrLength);
  const currentATR = getLastATR(atr);

  if (!currentATR) {
    console.log('❌ BUY: Недостатньо даних для ATR');
    return { signal: false, details: {} };
  }

  // Розраховуємо динамічну довжину хвилі
  const waveLength = calculateDynamicWaveLength(currentATR, minWaveLength, maxWaveLength);

  // Розраховуємо хвильові патерни
  const { waveHigh, waveLow } = calculateWavePatterns(highs, lows, waveLength);

  if (waveHigh === null || waveLow === null) {
    console.log('❌ BUY: Недостатньо даних для хвиль');
    return { signal: false, details: {} };
  }

  // Розраховуємо зміну хвилі
  const { waveChangeUp } = calculateWaveChange(currentPrice, waveLow, waveHigh);

  // Перевіряємо умову 1: Хвиля вгору > 0.3%
  const waveUpCondition = waveChangeUp > waveThreshold;

  // Розраховуємо MACD
  const { macdLine, signalLine, isValid: macdValid } = calculateMACD(
    closes,
    macdFast,
    macdSlow,
    macdSignal
  );

  if (!macdValid) {
    console.log('❌ BUY: Недостатньо даних для MACD');
    return { signal: false, details: {} };
  }

  // Перевіряємо умову 2: MACD crossover
  const macdCrossover = isMACDCrossover(macdLine, signalLine);

  // Перевіряємо умову 3: Ціна > локального мінімуму
  const priceConfirm = currentPrice > waveLow;

  const signal = waveUpCondition && macdCrossover && priceConfirm;

  console.log(`
  📊 === BUY SIGNAL ANALYSIS ===
  🌊 Wave Up: ${(waveChangeUp * 100).toFixed(3)}% (${waveUpCondition ? '✅' : '❌'} > ${(waveThreshold * 100).toFixed(1)}%)
  📈 MACD Crossover: ${macdCrossover ? '✅' : '❌'}
  💹 Price > Wave Low: ${currentPrice.toFixed(4)} > ${waveLow.toFixed(4)} (${priceConfirm ? '✅' : '❌'})
  📍 Wave High: ${waveHigh.toFixed(4)}, Wave Low: ${waveLow.toFixed(4)}
  🎯 RESULT: ${signal ? '✅ BUY SIGNAL' : '❌ NO SIGNAL'}
  `);

  return {
    signal,
    details: {
      waveChangeUp,
      waveUpCondition,
      macdCrossover,
      priceConfirm,
      currentPrice,
      waveLow,
      waveHigh,
      currentATR,
      waveLength
    }
  };
}

/**
 * Перевірка SELL сигналу за стратегією TradingView
 * Умови:
 * 1. Хвиля йде ВНИЗ > 0.3%
 * 2. MACD перетинає Signal Line (crossunder)
 * 3. Ціна < локального максимуму хвилі
 */
function checkSellSignal(candles, config = {}) {
  const {
    minWaveLength = 8,
    maxWaveLength = 21,
    waveThreshold = 0.003, // 0.3%
    atrLength = 14,
    macdFast = 12,
    macdSlow = 26,
    macdSignal = 9
  } = config;

  const closes = candles.map(c => c[4]);
  const highs = candles.map(c => c[2]);
  const lows = candles.map(c => c[3]);
  const currentPrice = closes[closes.length - 1];

  // Розраховуємо ATR
  const atr = calculateATR(highs, lows, closes, atrLength);
  const currentATR = getLastATR(atr);

  if (!currentATR) {
    console.log('❌ SELL: Недостатньо даних для ATR');
    return { signal: false, details: {} };
  }

  // Розраховуємо динамічну довжину хвилі
  const waveLength = calculateDynamicWaveLength(currentATR, minWaveLength, maxWaveLength);

  // Розраховуємо хвильові патерни
  const { waveHigh, waveLow } = calculateWavePatterns(highs, lows, waveLength);

  if (waveHigh === null || waveLow === null) {
    console.log('❌ SELL: Недостатньо даних для хвиль');
    return { signal: false, details: {} };
  }

  // Розраховуємо зміну хвилі
  const { waveChangeDown } = calculateWaveChange(currentPrice, waveLow, waveHigh);

  // Перевіряємо умову 1: Хвиля вниз > 0.3%
  const waveDownCondition = waveChangeDown > waveThreshold;

  // Розраховуємо MACD
  const { macdLine, signalLine, isValid: macdValid } = calculateMACD(
    closes,
    macdFast,
    macdSlow,
    macdSignal
  );

  if (!macdValid) {
    console.log('❌ SELL: Недостатньо даних для MACD');
    return { signal: false, details: {} };
  }

  // Перевіряємо умову 2: MACD crossunder
  const macdCrossunder = isMACDCrossunder(macdLine, signalLine);

  // Перевіряємо умову 3: Ціна < локального максимуму
  const priceConfirm = currentPrice < waveHigh;

  const signal = waveDownCondition && macdCrossunder && priceConfirm;

  console.log(`
  📊 === SELL SIGNAL ANALYSIS ===
  🌊 Wave Down: ${(waveChangeDown * 100).toFixed(3)}% (${waveDownCondition ? '✅' : '❌'} > ${(waveThreshold * 100).toFixed(1)}%)
  📉 MACD Crossunder: ${macdCrossunder ? '✅' : '❌'}
  💹 Price < Wave High: ${currentPrice.toFixed(4)} < ${waveHigh.toFixed(4)} (${priceConfirm ? '✅' : '❌'})
  📍 Wave High: ${waveHigh.toFixed(4)}, Wave Low: ${waveLow.toFixed(4)}
  🎯 RESULT: ${signal ? '✅ SELL SIGNAL' : '❌ NO SIGNAL'}
  `);

  return {
    signal,
    details: {
      waveChangeDown,
      waveDownCondition,
      macdCrossunder,
      priceConfirm,
      currentPrice,
      waveHigh,
      waveLow,
      currentATR,
      waveLength
    }
  };
}

module.exports = {
  checkBuySignal,
  checkSellSignal
};
