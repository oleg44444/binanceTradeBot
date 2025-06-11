require('dotenv').config();

module.exports = {
    symbol: 'SOL/USDT',
    timeframe: '5m',
    tradeAmount: 1,
    leverage: 20,
    updateInterval: 30000,
    maxRequestsPerMinute: 50,
    binance: {
        apiKey: process.env.BINANCE_API_KEY,
        apiSecret: process.env.BINANCE_API_SECRET,
        testnet: true
    },
    telegram: {
        token: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID 
    }
};