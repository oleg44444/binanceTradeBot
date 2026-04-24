require('dotenv').config();

module.exports = {
    symbol: 'SOLUSDT',
    timeframe: '15m',
    tradeAmount: 1,
    leverage: 20,
    updateInterval: 30000,
    maxRequestsPerMinute: 50,
    binance: {
        apiKey: process.env.BINANCE_API_KEY_REAL,
        apiSecret: process.env.BINANCE_API_SECRET_REAL,
        testnet: false
    },
    DCA_CONFIG: {
        MAX_DCA_COUNT: 5,
        STEP_PERCENT: 1, 
        MULTIPLIER: 0.8   
      },
    telegram: {
        token: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID 
    }
  
};