/**
 * Реєстр стратегій.
 *
 * Як додати свою стратегію:
 *  1. Створіть файл strategy/myStrategy.js з експортом
 *       { id, title, defaults, minCandles(params), analyze(closedCandles, params) }
 *     analyze повертає { ready, signal: 'buy'|'sell'|null, price, atr, levels, checks }
 *     (формат див. waveImproved.js).
 *  2. Додайте її в REGISTRY нижче.
 *  3. У config/config.js: strategy: 'myStrategy' та параметри в strategies.myStrategy.
 */
const registry = {
  waveClassic:  require('./waveClassic'),
  waveImproved: require('./waveImproved')
};

function listStrategies() {
  return Object.keys(registry);
}

/**
 * Повертає готову до роботи стратегію з підставленими параметрами.
 */
function getStrategy(name, overrides = {}) {
  const impl = registry[name];
  if (!impl) {
    throw new Error(`Невідома стратегія "${name}". Доступні: ${listStrategies().join(', ')}`);
  }
  const params = { ...impl.defaults, ...overrides };
  return {
    id: impl.id,
    title: impl.title,
    params,
    minCandles: impl.minCandles(params),
    analyze: (closedCandles) => impl.analyze(closedCandles, params)
  };
}

/**
 * Абсолютні рівні SL/TP/трейлінгу від ціни входу з дистанцій стратегії.
 */
function buildStops(entryPrice, side, levels) {
  const isBuy = side === 'buy';
  return {
    stopLoss:                  Number((isBuy ? entryPrice - levels.slDist : entryPrice + levels.slDist).toFixed(4)),
    takeProfit:                Number((isBuy ? entryPrice + levels.tpDist : entryPrice - levels.tpDist).toFixed(4)),
    trailingStopDistance:      Number(levels.trailOffsetDist.toFixed(4)),      // відступ
    trailingActivationDistance: Number(levels.trailActivationDist.toFixed(4))  // поріг активації
  };
}

module.exports = { getStrategy, listStrategies, buildStops };
