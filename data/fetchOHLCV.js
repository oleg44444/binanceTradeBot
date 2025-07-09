const binanceClientPromise = require('../utils/binanceClient');

async function fetchOHLCV(symbol, timeframe, limit = 100) {
  const binance = await binanceClientPromise();
  try {
    console.log(`📊 Завантаження ${limit} свічок ${timeframe} для ${symbol}...`);
    
    const since = Date.now() - (1000 * 60 * 60 * 24 * 7); // 1 тиждень назад
    const candles = await binance.fetchOHLCV(symbol, timeframe, since, limit);

    if (!candles || candles.length === 0) {
      throw new Error('Не отримано даних свічок');
    }

    console.log(`✅ Отримано ${candles.length} свічок`);

    // Перетворюємо масив масивів у масив об'єктів
    const parsedCandles = candles.map(c => ({
      time: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5]
    }));

    return parsedCandles;
  } catch (error) {
    console.error(`🔴 Помилка завантаження свічок: ${error.message}`);
    throw error;
  }
}

module.exports = fetchOHLCV;

