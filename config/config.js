require('dotenv').config();

module.exports = {
    symbol: 'SOLUSDT',
    timeframe: '15m',
    tradeAmount: 1,
    leverage: 20,
    updateInterval: 30000,  // 30 секунд - оновлення кожні 30 сек
    maxRequestsPerMinute: 50,
    binance: {
        apiKey: process.env.BINANCE_API_KEY_REAL,
        apiSecret: process.env.BINANCE_API_SECRET_REAL,
        testnet: false
    },
    
    // === ПАРАМЕТРИ СТРАТЕГІЇ ===
    strategy: {
        // Wave Pattern параметри
        minWaveLength: 8,
        maxWaveLength: 21,
        waveThreshold: 0.003,  // 0.3% - поріг активації сигналу
        
        // ATR параметри
        atrLength: 14,
        atrMultiplierSL: 1.0,       // Стоп-лосс = ATR * 1.0
        atrMultiplierTP: 5.0,       // Тейк-профіт = ATR * 5.0
        atrMultiplierTrail: 1.0,    // Трейлінг-стоп = ATR * 1.0
        
        // MACD параметри
        macdFast: 12,
        macdSlow: 26,
        macdSignal: 9,
    },
    
    // === УПРАВЛІННЯ ПОЗИЦІЯМИ ===
    position: {
        maxOpenPositions: 1,        // Максимум 1 позиція на раз
        breakEvenActivationPercent: 0.5,  // Активація break-even на 0.5% прибутку
        dcaEnabled: false,          // Додаткові buy/sell по меншій ціні
        maxDCACount: 5,
        dcaStepPercent: 1,
        dcaMultiplier: 0.8
    },
    
    // === TELEGRAM СПОВІЩЕННЯ ===
    telegram: {
        token: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID 
    }
  
};
