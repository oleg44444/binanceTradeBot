const binanceClient = require('../utils/binanceClient');

async function fetchOHLCV(symbol, timeframe, limit = 100) {
  try {
    // Отримуємо екземпляр клієнта Binance
    const binance = await binanceClient;
    
    // Використовуємо правильний метод API
    const candles = await binance.fetchOHLCV(
      symbol, 
      timeframe, 
      undefined, 
      limit,
      {
        price: 'mark'
      }
    );
    
    // Перетворюємо дані у зручний формат
    return candles.map(candle => ({
      timestamp: candle[0],
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
      volume: candle[5],
      closeTime: candle[6]
    }));
  } catch (error) {
    console.error(`🔴 Помилка отримання свічок для ${symbol}:`, error.message);
    throw error;
  }
}

module.exports = fetchOHLCV;
