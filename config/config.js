require('dotenv').config();

module.exports = {
  // ═══ РИНОК ═══════════════════════════════════════════════════════════════
  symbol: 'ETHUSDT',
  timeframe: '15m',
  leverage: 20,
  updateInterval: 10000,   // як часто бот перевіряє ринок (мс). Сигнали рахуються лише по закритих свічках
  candlesLimit: 500,       // скільки останніх свічок завантажувати (для EMA200 потрібно ≥ 250)

  // ═══ ОБРАНА СТРАТЕГІЯ ════════════════════════════════════════════════════
  // Доступні: 'waveImproved' | 'waveClassic'  (файли в папці strategy/)
  strategy: 'waveClassic',

  // Параметри стратегій. Тут можна перевизначити будь-які значення за замовчуванням
  // (повний список — у `defaults` відповідного файлу в strategy/).
  strategies: {
    waveClassic: {
      waveLookback: 32,
      waveThreshold: 0.0035,
      minWaveAtr: 1.0,
      maxWaveAtr: 4.5,
      minWavePositionLong: 0.62,
      maxWavePositionShort: 0.38,
      emaFastLength: 50,
      emaSlowLength: 200,
      emaSlopeLookback: 5,
      minEmaSlopeAtr: 0.02,
      maxDistanceFromEmaAtr: 2.8,
      adxLength: 14,
      adxMin: 18,
      diGapMin: 2,
      macdCrossLookback: 2,
      requireMacdZeroLine: true,
      rsiLongMin: 52,
      rsiLongMax: 68,
      rsiShortMin: 32,
      rsiShortMax: 48,
      minBodyAtr: 0.10,
      minClosePosition: 0.62,
      minAtrPercent: 0.12,
      atrMultiplierSL: 1.15,
      atrMultiplierTP: 2.10,
      atrMultiplierTrailActivation: 1.25,
      atrMultiplierTrail: 0.85
    },
    waveImproved: {
      waveLength: 24,
      minWaveAtr: 0.9,
      maxWaveAtr: 3.8,
      minWavePercent: 0.25,
      longWavePosition: 0.58,
      shortWavePosition: 0.42,
      useTrendFilter: true,
      fastEmaLength: 34,
      trendEmaLength: 200,
      emaSlopeLookback: 5,
      minEmaSlopeAtr: 0.015,
      maxDistanceFromFastEmaAtr: 2.5,
      useAdxFilter: true,
      adxLength: 14,
      adxMin: 18,
      diGapMin: 1.5,
      macdCrossLookback: 2,
      requireMacdZeroLine: false,
      requireHistogramSlope: true,
      rsiLongMin: 51,
      rsiLongMax: 67,
      rsiShortMin: 33,
      rsiShortMax: 49,
      minBodyAtr: 0.08,
      closePositionLong: 0.60,
      closePositionShort: 0.40,
      minAtrPercent: 0.12,
      atrMultiplierSL: 1.10,
      atrMultiplierTP: 1.90,
      trailActivationAtr: 1.20,
      trailOffsetAtr: 0.80
    }
  },

  // ═══ РИЗИК-МЕНЕДЖМЕНТ ════════════════════════════════════════════════════
  risk: {
    sizing: 'risk',            // 'risk' = розмір від % ризику на угоду, 'fixed' = tradeAmount
    tradeAmount: 1,            // використовується при sizing: 'fixed' (кількість в базовій монеті, ETH)
    riskPercent: 0.5,            // % балансу, який ризикуємо до SL
    maxLeverageUse: 0.8,       // макс. частка (плече × баланс), яку може займати позиція
    maxDailyLossPercent: 5,    // денний ліміт збитку (UTC) → зупинка торгівлі до наступного дня
    maxConsecutiveLosses: 3,   // стільки збитків підряд → пауза
    pauseMinutes: 120          // тривалість паузи
  },

  // ═══ ПОЗИЦІЇ ═════════════════════════════════════════════════════════════
  position: {
    reverseOnSignal: true,     // протилежний сигнал закриває позицію і відкриває нову
    entryWindowSeconds: 180    // сигнал старший за N сек після закриття свічки — ігнорується
  },

  // Захист для позиції, знайденої на біржі без збереженого стану (напр. після збою)
  recovery: {
    slPercent: 1.5,
    tpPercent: 3,
    trailPercent: 0.7
  },

  // ═══ БЕКТЕСТ (node backtest/backtest.js) ═════════════════════════════════
  backtest: {
    days: 180,
    startEquity: 1000,
    feePercent: 0.05,          // taker, за кожну сторону
    slippagePercent: 0.02      // проковзування, за кожну сторону
  },

  // ═══ ДОСТУП ══════════════════════════════════════════════════════════════
  binance: {
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
    // true  = Binance Demo Trading (demo.binance.com, ключі звідти ж)
    // false = реальний акаунт (fapi.binance.com)
    demo: process.env.BINANCE_DEMO ? process.env.BINANCE_DEMO === 'true' : true
  },

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  }
};
