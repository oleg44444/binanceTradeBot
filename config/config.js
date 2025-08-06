require('dotenv').config();

module.exports = {
    symbol: 'SOLUSDT',
    timeframe: '5m',
    tradeAmount: 5,
    leverage: 20,
    updateInterval: 30000,
    maxRequestsPerMinute: 50,
    binance: {
        apiKey: process.env.BINANCE_API_KEY,
        apiSecret: process.env.BINANCE_API_SECRET,
        testnet: true
    },
    DCA_CONFIG: {
        MAX_DCA_COUNT: 10,
        STEP_PERCENT: 1, // наприклад, 1.5% відстань між докупками
        MULTIPLIER: 0.8    // коефіцієнт збільшення кожної наступної докупки
      },
    telegram: {
        token: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID 
    }
  
};