const binanceClientPromise = require('../utils/binanceClient');

async function fetchOHLCV(symbol, timeframe, limit = 100) {
  const binance = await binanceClientPromise();
  try {
    console.log(`📊 Завантаження ${limit} свічок ${timeframe} для ${symbol}...`);
    
    // Розрахунок часу для останніх свічок
    const since = Date.now() - (1000 * 60 * 60 * 24 * 7); // 1 тиждень назад
    
    // Безпечне отримання даних
    const candles = await binance.fetchOHLCV(symbol, timeframe, since, limit);
    
    if (!candles || candles.length === 0) {
      throw new Error('Не отримано даних свічок');
    }
    
    console.log(`✅ Отримано ${candles.length} свічок`);
    return candles;
  } catch (error) {
    console.error(`🔴 Помилка завантаження свічок: ${error.message}`);
    throw error;
  }
}

module.exports = fetchOHLCV;