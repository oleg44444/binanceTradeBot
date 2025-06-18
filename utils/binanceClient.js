const ccxt = require('ccxt');
const config = require('../config/config');
const telegram = require('./telegramNotifier');

// Глобальний флаг для запобігання повторній ініціалізації
let isClientInitialized = false;
let initializationPromise = null;

class CustomBinance extends ccxt.binance {
  constructor(...args) {
    super(...args);
    this.trailingStopUpdateInProgress = false;
    this.listenKey = null;
    this.ws = null;
    this.listenKeyInterval = null;
    this.wsReconnectTimeout = null;
  }

  async createOrder(symbol, type, side, amount, price, params = {}) {
    try {
      if (params.newClientOrderId && params.newClientOrderId.length > 32) {
        params.newClientOrderId = params.newClientOrderId.substring(0, 32);
      }

      const conditionalTypes = ['stop', 'stop_market', 'take_profit', 'take_profit_market'];
      if (conditionalTypes.includes(type) && !params.hasOwnProperty('reduceOnly')) {
        params.reduceOnly = true;
      }

      if (type === 'limit' && !params.timeInForce) {
        params.timeInForce = 'GTC';
      }

      return await super.createOrder(symbol, type, side, amount, price, params);
    } catch (error) {
      console.error('🔴 Order creation error:', error.message);
      if (error.message.includes('reduce only')) {
        console.log('🔄 Retrying without reduceOnly');
        const newParams = { ...params };
        delete newParams.reduceOnly;
        return await super.createOrder(symbol, type, side, amount, price, newParams);
      }
      throw error;
    }
  }

  async setLeverage(leverage, symbol) {
    try {
      await this.fapiPrivatePostLeverage({
        symbol: symbol.replace('/', ''),
        leverage: leverage
      });
    } catch (error) {
      console.error('🔴 Помилка встановлення плеча:', error.message);
      if (!error.message.includes('No need to change leverage')) {
        throw error;
      }
    }
  }

  async setMarginType(symbol, marginType = 'ISOLATED') {
    try {
      await this.fapiPrivatePostMarginType({
        symbol: symbol.replace('/', ''),
        marginType: marginType
      });
      console.log(`✅ Встановлено тип маржі ${marginType} для ${symbol}`);
    } catch (error) {
      if (error.message.includes('No need to change margin type')) {
        console.log(`ℹ️ Тип маржі вже встановлено на ${marginType} для ${symbol}`);
      } else {
        console.error('🔴 Помилка встановлення типу маржі:', error.message);
        throw error;
      }
    }
  }

  async fetchPosition(symbol) {
    try {
      const cleanSymbol = symbol.replace('/', '');
      const positions = await this.fetchPositions([cleanSymbol]);
      const position = positions.find(p => 
        p.symbol === cleanSymbol && 
        Math.abs(p.contracts) > 0.001
      );
      
      if (!position) {
        console.log(`ℹ️ No active position for ${symbol}`);
        return null;
      }
      
      return position;
    } catch (error) {
      console.error('🔴 Position fetch error:', error.message);
      throw error;
    }
  }

  async destroy() {
    try {
      if (this.listenKeyInterval) {
        clearInterval(this.listenKeyInterval);
        this.listenKeyInterval = null;
      }

      if (this.wsReconnectTimeout) {
        clearTimeout(this.wsReconnectTimeout);
        this.wsReconnectTimeout = null;
      }

      if (this.ws) {
        this.ws.removeAllListeners();
        this.ws.close();
        this.ws = null;
      }

      if (this.listenKey) {
        await this.fapiPrivateDeleteListenKey({ listenKey: this.listenKey });
        console.log('🗑️ ListenKey видалено');
        this.listenKey = null;
      }

      console.log('✅ CustomBinance знищено');
    } catch (err) {
      console.error('🔴 Помилка при знищенні ресурсу:', err.message);
    }
  }
}

const apiKey = config.binance?.apiKey;
const apiSecret = config.binance?.apiSecret;

if (!apiKey || !apiSecret) {
  throw new Error('❌ API ключі відсутні у конфігурації');
}

const binance = new CustomBinance({
  apiKey: apiKey.trim(),
  secret: apiSecret.trim(),
  options: {
    defaultType: 'future',
    testnet: config.binance.testnet || false,
    adjustForTimeDifference: true
  },
  enableRateLimit: true,
  timeout: 30000,
  rateLimit: 150
});

// Обробка завершення процесу
process.on('SIGINT', async () => {
  console.log('🛑 Завершення роботи...');
  await binance.destroy();
  process.exit();
});

// Функція для ініціалізації клієнта
async function initializeBinanceClient() {
  if (isClientInitialized) {
    console.log('ℹ️ Binance клієнт вже ініціалізовано');
    return binance;
  }

  try {
    // Завантаження ринків
    await binance.loadMarkets();
    
    const time = await binance.fetchTime();
    console.log('🟢 Успішне підключення до Binance. Час сервера:', new Date(time).toISOString());

    const cleanSymbol = config.symbol.replace('/', '');

    // Налаштування акаунту
    await binance.setMarginType(config.symbol, 'ISOLATED');
    await binance.setLeverage(config.leverage, config.symbol);

    // Перевірка балансу - ВИПРАВЛЕННЯ
    const balance = await binance.fetchBalance();
    const usdtBalance = balance.total?.USDT || 
                       balance.USDT?.total || 
                       balance.total?.usdt || 
                       balance.usdt?.total || 
                       0;
    
    // Перевірка маржі
    const positions = await binance.fetchPositions([cleanSymbol]);
    const position = positions.find(p => p.symbol === cleanSymbol);
    const usedMargin = position ? Math.abs(position.notional) / config.leverage : 0;
    
    console.log('💰 Баланс:', {
      total: usdtBalance,
      available: usdtBalance - usedMargin,
      usedMargin: usedMargin
    });

    if (telegram.enabled) {
      await telegram.sendMessage(
        `🚀 Бот успішно запущено!\n` +
        `- Символ: ${config.symbol}\n` +
        `- Баланс: ${usdtBalance.toFixed(2)} USDT\n` +
        `- Плече: ${config.leverage}x\n` +
        `- Використано маржі: ${usedMargin.toFixed(2)} USDT`
      );
    }

    if (usdtBalance < 100) {
      console.warn('⚠️ Увага: баланс менше 100 USDT. Рекомендується поповнити рахунок.');
    }

    isClientInitialized = true;
    console.log('✅ Binance клієнт ініціалізовано успішно');
    return binance;

  } catch (error) {
    console.error('🔴 Критична помилка ініціалізації:', error);
    if (telegram.enabled) {
      await telegram.sendError('initialization', error);
    }
    throw error;
  }
}
// Експортуємо проміс ініціалізації
module.exports = (() => {
  if (!initializationPromise) {
    initializationPromise = initializeBinanceClient();
  }
  return initializationPromise;
})();