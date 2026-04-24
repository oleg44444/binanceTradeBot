const { calculateMACD, isMACDCrossover, isMACDCrossunder } = require('../indicators/macd');
const { calculateATR } = require('../indicators/atr');
const { calculateWavePatterns, calculateDynamicWaveLength } = require('../indicators/waves');

// Параметри стратегії
const STRATEGY_PARAMS = {
  minWaveLength: 8,
  maxWaveLength: 21,
  atrLength: 14,
  atrMultiplierSL: 1.0,      // ATR множник для стоп-лоссу
  atrMultiplierTP: 5.0,      // ATR множник для тейк-профіту
  atrMultiplierTrail: 1.0,   // ATR множник для трейлінг-стопу
  
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  
  waveThreshold: 0.003       // 0.3% - поріг для сигналу на волні
};

/**
 * Розрахунок всіх індикаторів для стратегії
 */
function calculateAllIndicators(candles) {
  try {
    // Розпакуємо OHLCV
    const opens = candles.map(c => c[0]);
    const closes = candles.map(c => c[4]);
    
    // Розраховуємо ATR
    const atrValues = calculateATR(candles, STRATEGY_PARAMS.atrLength);
    const atr = atrValues[atrValues.length - 1];
    
    // Розраховуємо динамічну довжину хвилі
    const waveLengthDynamic = calculateDynamicWaveLength(
      atr,
      STRATEGY_PARAMS.minWaveLength,
      STRATEGY_PARAMS.maxWaveLength
    );
    
    // Розраховуємо хвильові патерни
    const waveWindow = Math.max(waveLengthDynamic, STRATEGY_PARAMS.maxWaveLength);
    const candlesWindow = candles.slice(-Math.max(50, waveWindow));
    const waves = calculateWavePatterns(candlesWindow, waveLengthDynamic);
    
    // Розраховуємо MACD
    const macd = calculateMACD(
      closes.slice(-Math.max(100, STRATEGY_PARAMS.macdSlow + STRATEGY_PARAMS.macdSignal)),
      STRATEGY_PARAMS.macdFast,
      STRATEGY_PARAMS.macdSlow,
      STRATEGY_PARAMS.macdSignal
    );
    
    return {
      atr,
      atrValues,
      waveLengthDynamic,
      waves,
      macd,
      closes: closes.slice(-100),
      currentPrice: closes[closes.length - 1],
      isValid: atr !== null && waves.isValid && macd.isValid
    };
  } catch (error) {
    console.error('🔴 Помилка розрахунку індикаторів:', error.message);
    return {
      isValid: false,
      error: error.message
    };
  }
}

/**
 * Перевірка сигналу на покупку (LONG)
 * 1. Хвиля йде вгору більше ніж на 0.3%
 * 2. MACD перетинає сигнальну лінію знизу (вгору)
 * 3. Ціна вище локального мінімуму хвилі
 */
function checkBuySignal(indicators) {
  if (!indicators.isValid) {
    return {
      signal: false,
      reason: 'Недостатньо даних для аналізу'
    };
  }
  
  const { waves, macd, currentPrice } = indicators;
  
  // Умова 1: Хвиля йде вгору
  const waveUpCondition = waves.waveChangeUp > STRATEGY_PARAMS.waveThreshold;
  
  // Умова 2: MACD crossover (перетин вгору)
  const macdCrossoverCondition = isMACDCrossover(macd.macdLine, macd.signalLine);
  
  // Умова 3: Ціна вище локального мінімуму
  const priceConfirm = currentPrice > waves.waveLow;
  
  const signal = waveUpCondition && macdCrossoverCondition && priceConfirm;
  
  return {
    signal,
    waveUpCondition,
    macdCrossoverCondition,
    priceConfirm,
    waveChangeUp: waves.waveChangeUp,
    waveLow: waves.waveLow,
    currentPrice,
    macdLine: macd.macdLine[macd.macdLine.length - 1],
    signalLine: macd.signalLine[macd.signalLine.length - 1]
  };
}

/**
 * Перевірка сигналу на продаж (SHORT)
 * 1. Хвиля йде вниз більше ніж на 0.3%
 * 2. MACD перетинає сигнальну лінію зверху (вниз)
 * 3. Ціна нижче локального максимуму хвилі
 */
function checkSellSignal(indicators) {
  if (!indicators.isValid) {
    return {
      signal: false,
      reason: 'Недостатньо даних для аналізу'
    };
  }
  
  const { waves, macd, currentPrice } = indicators;
  
  // Умова 1: Хвиля йде вниз
  const waveDownCondition = waves.waveChangeDown > STRATEGY_PARAMS.waveThreshold;
  
  // Умова 2: MACD crossunder (перетин вниз)
  const macdCrossunderCondition = isMACDCrossunder(macd.macdLine, macd.signalLine);
  
  // Умова 3: Ціна нижче локального максимуму
  const priceConfirm = currentPrice < waves.waveHigh;
  
  const signal = waveDownCondition && macdCrossunderCondition && priceConfirm;
  
  return {
    signal,
    waveDownCondition,
    macdCrossunderCondition,
    priceConfirm,
    waveChangeDown: waves.waveChangeDown,
    waveHigh: waves.waveHigh,
    currentPrice,
    macdLine: macd.macdLine[macd.macdLine.length - 1],
    signalLine: macd.signalLine[macd.signalLine.length - 1]
  };
}

/**
 * Розрахунок стоп-лосу та тейк-профіту на основі ATR
 */
function calculateStopsAndTP(entryPrice, atr, side) {
  const sl = atr * STRATEGY_PARAMS.atrMultiplierSL;
  const tp = atr * STRATEGY_PARAMS.atrMultiplierTP;
  const trail = atr * STRATEGY_PARAMS.atrMultiplierTrail;
  
  if (side === 'long') {
    return {
      stopLoss: entryPrice - sl,
      takeProfit: entryPrice + tp,
      trailingStopDistance: trail
    };
  } else {
    return {
      stopLoss: entryPrice + sl,
      takeProfit: entryPrice - tp,
      trailingStopDistance: trail
    };
  }
}

module.exports = {
  STRATEGY_PARAMS,
  calculateAllIndicators,
  checkBuySignal,
  checkSellSignal,
  calculateStopsAndTP
};
