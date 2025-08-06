const fetchOHLCV = require('../data/fetchOHLCV');
const { checkBuySignal, checkSellSignal } = require('../strategy/strategy');
const config = require('../config/config');

// Параметри бектесту
const SYMBOL = config.symbol || 'BTC/USDT';
const TIMEFRAME = config.timeframe || '5m';
const LIMIT = 500; // кількість свічок

async function runBacktest() {
  console.log(`🔍 Запуск backtest для ${SYMBOL} (${TIMEFRAME})`);

  const candles = await fetchOHLCV(SYMBOL, TIMEFRAME, LIMIT);

  if (!candles || candles.length < 50) {
    console.log('❌ Недостатньо даних для тесту');
    return;
  }

  const closes = candles.map(c => c.close);
  const times = candles.map(c => c.time || c.timestamp);

  let balance = 1000; // Початковий баланс (в USDT)
  let position = null;
  let trades = [];

  for (let i = 50; i < closes.length; i++) {
    const currentClose = closes[i];
    const slicedCloses = closes.slice(0, i + 1);
    const time = new Date(times[i]).toLocaleString();

    const buySignal = checkBuySignal(slicedCloses);
    const sellSignal = checkSellSignal(slicedCloses);

    if (buySignal && !position) {
      position = {
        entry: currentClose,
        side: 'long',
        time: time
      };
      console.log(`🟢 BUY @ ${currentClose.toFixed(2)} (${time})`);
    } else if (sellSignal && position?.side === 'long') {
      const profit = ((currentClose - position.entry) / position.entry) * 100;
      trades.push(profit);
      balance *= 1 + profit / 100;
      console.log(`🔴 SELL @ ${currentClose.toFixed(2)} ➡️ Profit: ${profit.toFixed(2)}%`);
      position = null;
    }
  }

  // Завершення останньої позиції
  if (position) {
    const lastPrice = closes.at(-1);
    const profit = ((lastPrice - position.entry) / position.entry) * 100;
    trades.push(profit);
    balance *= 1 + profit / 100;
    console.log(`📤 Вихід по останній позиції @ ${lastPrice.toFixed(2)} ➡️ Profit: ${profit.toFixed(2)}%`);
  }

  // Підсумки
  const totalProfit = balance - 1000;
  const winRate = trades.filter(p => p > 0).length / trades.length * 100;

  console.log('\n📊 ПІДСУМКИ BACKTEST');
  console.log(`📈 Всього угод: ${trades.length}`);
  console.log(`💹 Win-rate: ${winRate.toFixed(2)}%`);
  console.log(`💰 Фінальний баланс: ${balance.toFixed(2)} USDT`);
  console.log(`📉 PnL: ${totalProfit.toFixed(2)} USDT (${(totalProfit / 1000 * 100).toFixed(2)}%)`);
}

runBacktest();
