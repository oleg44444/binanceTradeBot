require('dotenv').config();

const fetchOHLCV = require('./data/fetchOHLCV');
const config = require('./config/config');
const binanceClientPromise = require('./utils/binanceClient');
const telegram = require('./utils/telegramNotifier');
const logger = require('./utils/logger');
const { getStrategy, buildStops } = require('./strategy');
const RiskManager = require('./trading/riskManager');
const { initializeTradingModule } = require('./trading/executeOrder');
const { handleTradeSignal } = require('./trading/positionManager');

let binance;
let trading;
let strategy;
let risk;
let isRunning = false;
let timeframeMs = 0;
let lastProcessedBar = 0;
let cycleCounter = 0;
let lastRiskNotice = '';

logger.setLogLevel('INFO');

process.on('uncaughtException', (error) => {
  logger.error('Невідловлена помилка', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Невідловлена відмова', reason instanceof Error ? reason : new Error(String(reason)));
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n🔴 Бот зупинено');
  process.exit(0);
});

// ─── Ініціалізація ───────────────────────────────────────────────────────────

async function initializeBot() {
  logger.info('🚀 Запуск бота...');

  strategy = getStrategy(config.strategy, config.strategies?.[config.strategy]);
  logger.info(`🧠 Стратегія: ${strategy.id} — ${strategy.title}`);

  binance = await binanceClientPromise();   // плече та тип маржі налаштовуються всередині клієнта
  timeframeMs = binance.parseTimeframe(config.timeframe) * 1000;

  risk = new RiskManager(config.risk, { persistName: 'risk' });

  trading = await initializeTradingModule(binance);

  // Результат кожної закритої угоди (у т.ч. по TP/SL на біржі) потрапляє в ризик-менеджер
  trading.setPositionClosedHandler(async ({ pnl }) => {
    const equity = await trading.getAccountBalance();
    const event = risk.recordResult(pnl, equity);
    if (event) {
      logger.warn(event);
      telegram.sendMessage(event, false);
    }
  });

  const balance = await trading.getAccountBalance();
  logger.info(`💰 Початковий баланс: ${balance.toFixed(2)} USDT`);

  telegram.sendMessage(
    `🧠 Стратегія: ${strategy.id}\n` +
    `${config.symbol} ${config.timeframe}, плече ${config.leverage}x\n` +
    `Розмір: ${config.risk.sizing === 'risk' ? `ризик ${config.risk.riskPercent}% на угоду` : `фіксований ${config.risk.tradeAmount}`}\n` +
    `Ліміти: день -${config.risk.maxDailyLossPercent}%, пауза після ${config.risk.maxConsecutiveLosses} збитків`,
    false
  );
}

// ─── Розмір позиції з урахуванням правил біржі ──────────────────────────────

function sizePosition({ equity, price, slDistance }) {
  const { qty: rawQty, note } = risk.calcQty({
    equity, price, slDistance, leverage: config.leverage
  });
  if (!(rawQty > 0)) return { qty: 0, reason: note };

  const market = binance.market(config.symbol);
  const qty = Number(binance.amountToPrecision(config.symbol, rawQty));
  const minQty  = market?.limits?.amount?.min || 0;
  const minCost = market?.limits?.cost?.min || 0;

  if (qty <= 0 || qty < minQty) {
    return { qty: 0, reason: `розмір ${rawQty.toFixed(4)} менший за мінімум біржі (${minQty}); збільште баланс/ризик` };
  }
  if (minCost && qty * price < minCost) {
    return { qty: 0, reason: `вартість ${(qty * price).toFixed(2)} USDT менша за мінімальну ${minCost}` };
  }
  return { qty, note };
}

// ─── Реакція на сигнал ───────────────────────────────────────────────────────

async function handleSignal(analysis, barCloseTime) {
  const side = analysis.signal;                       // 'buy' | 'sell'
  const wantSide = side === 'buy' ? 'long' : 'short';
  let position = trading.getActivePosition();

  // Сигнал застарів (напр. бот запущено посеред свічки)
  const ageSec = (Date.now() - barCloseTime) / 1000;
  if (ageSec > config.position.entryWindowSeconds) {
    logger.info(`⏭️ Сигнал ${side.toUpperCase()} застарів (${Math.round(ageSec)} с після закриття свічки) — пропускаємо`);
    return;
  }

  if (position.isOpen && position.side === wantSide) {
    logger.info(`ℹ️ Позиція ${wantSide.toUpperCase()} вже відкрита — сигнал ігноруємо`);
    return;
  }
  if (position.isOpen && !config.position.reverseOnSignal) {
    logger.info('ℹ️ Є протилежна позиція, reverseOnSignal=false — сигнал ігноруємо');
    return;
  }

  // Ліміти ризику
  let equity = await trading.getAccountBalance();
  let gate = risk.canTrade(equity);
  if (!gate.ok) {
    notifyRisk(`⛔ Нову угоду пропущено: ${gate.reason}`);
    return;
  }

  // Розворот: спочатку закриваємо протилежну позицію
  if (position.isOpen) {
    logger.info(`🔄 Закриваємо ${position.side.toUpperCase()} перед ${wantSide.toUpperCase()}`);
    await trading.closePosition();
    equity = await trading.getAccountBalance();
    gate = risk.canTrade(equity);       // закриття могло активувати паузу
    if (!gate.ok) {
      notifyRisk(`⛔ Після закриття нову угоду не відкриваємо: ${gate.reason}`);
      return;
    }
  }

  // Актуальна ціна та рівні від неї
  const ticker = await binance.fetchTicker(config.symbol);
  const price = Number(ticker.last);
  if (!price) { logger.warn('Невалідна ціна, угоду пропущено'); return; }

  const stops = buildStops(price, side, analysis.levels);
  const sized = sizePosition({ equity, price, slDistance: analysis.levels.slDist });
  if (!(sized.qty > 0)) {
    logger.warn(`Угоду пропущено: ${sized.reason}`);
    telegram.sendMessage(`⚠️ Сигнал ${side.toUpperCase()} пропущено: ${sized.reason}`, false);
    return;
  }
  logger.info(`📐 Розмір: ${sized.qty} (${sized.note})`);

  await handleTradeSignal(side, price, sized.qty, stops);

  position = trading.getActivePosition();
  if (position.isOpen) {
    logger.tradeOpen(side, position.size, config.symbol, position.entryPrice, {
      ...stops, trailingStopDistance: stops.trailingStopDistance
    });
  } else {
    logger.warn('Позиція не відкрилась — перевірте помилки вище');
  }
}

function notifyRisk(text) {
  logger.warn(text);
  if (text !== lastRiskNotice) {          // не спамимо одним і тим самим повідомленням
    lastRiskNotice = text;
    telegram.sendMessage(text, false);
  }
}

// ─── Головний цикл ───────────────────────────────────────────────────────────

async function runTradingCycle() {
  cycleCounter++;
  try {
    const candles = await fetchOHLCV(config.symbol, config.timeframe, config.candlesLimit);
    if (!candles || candles.length < strategy.minCandles + 1) {
      logger.warn(`⚠️ Недостатньо даних: ${candles?.length || 0} свічок, потрібно ${strategy.minCandles + 1}`);
      return;
    }

    // Остання свічка ще формується — для сигналів використовуємо тільки закриті
    const closed = candles.slice(0, -1);
    const lastClosed = closed[closed.length - 1];
    const lastClosedTime = lastClosed[0];
    const barCloseTime = lastClosedTime + timeframeMs;

    // Перевірка свіжості даних (захист від повторення старої помилки з since)
    if (Date.now() - barCloseTime > timeframeMs * 3) {
      logger.warn(`⚠️ Дані застарілі: остання закрита свічка ${new Date(lastClosedTime).toLocaleString('uk-UA')}`);
      return;
    }

    // Одна оцінка на кожну нову закриту свічку
    if (lastClosedTime === lastProcessedBar) {
      if (cycleCounter % 20 === 0) {
        const bal = await trading.getAccountBalance();
        logger.cycleStatus(bal, trading.getActivePosition());
      }
      return;
    }
    lastProcessedBar = lastClosedTime;

    const analysis = strategy.analyze(closed);
    if (!analysis.ready) {
      logger.warn(`Стратегія не готова: ${analysis.reason}`);
      return;
    }

    logger.strategyReport(strategy.id, lastClosedTime, analysis);

    if (analysis.signal) {
      await handleSignal(analysis, barCloseTime);
    }

    const bal = await trading.getAccountBalance();
    logger.cycleStatus(bal, trading.getActivePosition());
  } catch (error) {
    logger.error('Помилка циклу торгівлі', error);
  }
}

async function startBot() {
  try {
    await initializeBot();
    isRunning = true;

    console.log(`\n${'='.repeat(60)}`);
    console.log('🎯 БОТ ЗАПУЩЕНО');
    console.log(`${'='.repeat(60)}`);
    console.log(`📍 ${config.symbol} (${config.timeframe}) | стратегія: ${strategy.id}`);
    console.log(`⏰ Перевірка ринку кожні ${config.updateInterval / 1000} с, сигнали — по закритих свічках`);
    console.log(`${'='.repeat(60)}\n`);

    const runLoop = async () => {
      if (!isRunning) return;
      await runTradingCycle();
      setTimeout(runLoop, config.updateInterval);
    };
    runLoop();
  } catch (error) {
    logger.error('Фатальна помилка', error);
    process.exit(1);
  }
}

startBot();
