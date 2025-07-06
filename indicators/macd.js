function calculateEMA(prices, period) {
  try {
    if (!Array.isArray(prices) || prices.length === 0) {
      return [];
    }
    
    const multiplier = 2 / (period + 1);
    const ema = [];
    
    // Start with Simple Moving Average for first value
    let sum = 0;
    for (let i = 0; i < Math.min(period, prices.length); i++) {
      sum += prices[i];
    }
    ema.push(sum / Math.min(period, prices.length));
    
    // Calculate EMA for remaining values
    for (let i = 1; i < prices.length; i++) {
      const currentEMA = (prices[i] * multiplier) + (ema[i - 1] * (1 - multiplier));
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
    // Validate input
    if (!Array.isArray(candles) || candles.length < slowPeriod + signalPeriod) {
      console.warn('⚠️ MACD: Insufficient data for calculation');
      return {
        macd: [],
        signal: [],
        histogram: []
      };
    }
    
    // Extract close prices from candles
    const closePrices = candles.map(candle => {
      // Handle both array format [timestamp, open, high, low, close, volume] 
      // and object format {open, high, low, close, volume}
      const closePrice = Array.isArray(candle) ? candle[4] : candle.close;
      
      if (typeof closePrice !== 'number') {
        throw new Error(`Invalid close price at candle: ${JSON.stringify(candle)}`);
      }
      
      return closePrice;
    });
    
    console.log(`📊 MACD: Processing ${closePrices.length} close prices`);
    console.log(`📊 MACD: Price range ${Math.min(...closePrices).toFixed(2)} - ${Math.max(...closePrices).toFixed(2)}`);
    
    // Calculate EMAs
    const emaFast = calculateEMA(closePrices, fastPeriod);
    const emaSlow = calculateEMA(closePrices, slowPeriod);
    
    if (emaFast.length === 0 || emaSlow.length === 0) {
      throw new Error('Failed to calculate EMAs');
    }
    
    // Calculate MACD line (Fast EMA - Slow EMA)
    const macdLine = [];
    const minLength = Math.min(emaFast.length, emaSlow.length);
    
    for (let i = 0; i < minLength; i++) {
      macdLine.push(emaFast[i] - emaSlow[i]);
    }
    
    if (macdLine.length === 0) {
      throw new Error('Failed to calculate MACD line');
    }
    
    // Calculate Signal line (EMA of MACD line)
    const signalLine = calculateEMA(macdLine, signalPeriod);
    
    if (signalLine.length === 0) {
      throw new Error('Failed to calculate Signal line');
    }
    
    // Calculate Histogram (MACD - Signal)
    const histogram = [];
    const histogramLength = Math.min(macdLine.length, signalLine.length);
    
    for (let i = 0; i < histogramLength; i++) {
      histogram.push(macdLine[i] - signalLine[i]);
    }
    
    const result = {
      macd: macdLine,
      signal: signalLine,
      histogram: histogram
    };
    
    // Log results for debugging
    const latestMACD = macdLine[macdLine.length - 1];
    const latestSignal = signalLine[signalLine.length - 1];
    const latestHistogram = histogram[histogram.length - 1];
    
    console.log(`✅ MACD calculated successfully:`);
    console.log(`   📈 MACD values: ${macdLine.length}, latest: ${latestMACD?.toFixed(6)}`);
    console.log(`   📊 Signal values: ${signalLine.length}, latest: ${latestSignal?.toFixed(6)}`);
    console.log(`   📉 Histogram values: ${histogram.length}, latest: ${latestHistogram?.toFixed(6)}`);
    
    return result;
    
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