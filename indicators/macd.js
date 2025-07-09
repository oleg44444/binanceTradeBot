function calculateEMA(prices, period) {
  try {
    if (!Array.isArray(prices) || prices.length < period) {
      return [];
    }

    const multiplier = 2 / (period + 1);
    const ema = [];

    // Перший елемент — це Simple Moving Average (SMA)
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += prices[i];
    }
    ema.push(sum / period);

    // Обчислюємо решту значень EMA
    for (let i = period; i < prices.length; i++) {
      const currentEMA = (prices[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1];
      ema.push(currentEMA);
    }

    return ema;
  } catch (error) {
    console.error('🔴 EMA calculation error:', error.message);
    return [];
  }
}

function calculateMACD(candles, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  try {
    if (!Array.isArray(candles) || candles.length < slowPeriod + signalPeriod) {
      console.warn('⚠️ MACD: Insufficient data for calculation');
     
      return {
        macd: [],
        signal: [],
        histogram: []
      };
    }

    // Отримуємо закриття цін
    const closePrices = candles.map(candle => {
      const closePrice = Array.isArray(candle) ? candle[4] : candle.close;

      if (typeof closePrice !== 'number') {
        throw new Error(`Invalid close price at candle: ${JSON.stringify(candle)}`);
      }

      return closePrice;
    });

    console.log(`📊 MACD: Processing ${closePrices.length} close prices`);
    console.log(`📊 MACD: Price range ${Math.min(...closePrices).toFixed(2)} - ${Math.max(...closePrices).toFixed(2)}`);

    // Обчислення EMA
    const emaFast = calculateEMA(closePrices, fastPeriod);
    const emaSlow = calculateEMA(closePrices, slowPeriod);

    if (emaFast.length === 0 || emaSlow.length === 0) {
      throw new Error('Failed to calculate EMAs');
    }

    // Вирівнюємо масиви EMA
    const offset = emaFast.length - emaSlow.length;
    const alignedEmaFast = emaFast.slice(offset); // обрізаємо, щоб довжини співпадали

    const macdLine = [];
    for (let i = 0; i < emaSlow.length; i++) {
      macdLine.push(alignedEmaFast[i] - emaSlow[i]);
    }

    if (macdLine.length === 0) {
      throw new Error('Failed to calculate MACD line');
    }

    // Signal line (EMA від MACD)
    const signalLine = calculateEMA(macdLine, signalPeriod);
    if (signalLine.length === 0) {
      throw new Error('Failed to calculate Signal line');
    }

    // Histogram (MACD - Signal)
    const histogram = [];
    const histLength = Math.min(macdLine.length, signalLine.length);
    const alignedMacdLine = macdLine.slice(macdLine.length - histLength);

    for (let i = 0; i < histLength; i++) {
      histogram.push(alignedMacdLine[i] - signalLine[i]);
    }

    // Логування результатів
    const latestMACD = macdLine[macdLine.length - 1];
    const latestSignal = signalLine[signalLine.length - 1];
    const latestHistogram = histogram[histogram.length - 1];

    console.log(`✅ MACD calculated successfully:`);
    console.log(`   📈 MACD values: ${macdLine.length}, latest: ${latestMACD?.toFixed(6)}`);
    console.log(`   📊 Signal values: ${signalLine.length}, latest: ${latestSignal?.toFixed(6)}`);
    console.log(`   📉 Histogram values: ${histogram.length}, latest: ${latestHistogram?.toFixed(6)}`);

    return {
      macd: macdLine,
      signal: signalLine,
      histogram: histogram
    };

  } catch (error) {
    console.error('🔴 MACD calculation error:', error.message);
    return {
      macd: [],
      signal: [],
      histogram: []
    };
  }
}

module.exports = { calculateMACD, calculateEMA };
