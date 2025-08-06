const binanceClientPromise = require('../utils/binanceClient');

async function fetchOHLCV(symbol, timeframe, limit = 250) {
  const binance = await binanceClientPromise();
  try {
    console.log(`\uD83D\uDCC8 Завантаження ${limit} свічок ${timeframe} для ${symbol}...`);

    const since = Date.now() - (1000 * 60 * 60 * 24 * 7);
    const candles = await binance.fetchOHLCV(symbol, timeframe, since, limit);

    if (!candles || candles.length === 0) {
      throw new Error('Не отримано даних свічок');
    }

    console.log(`✅ Отримано ${candles.length} свічок`);

    // Повертаємо масив масивів без змін (для зменшення конфлікту типів)
    return candles;
  } catch (error) {
    console.error(`🔴 Помилка завантаження свічок: ${error.message}`);
    throw error;
  }
}

module.exports = fetchOHLCV;
