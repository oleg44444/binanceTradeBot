const ccxt = require('ccxt');
const config = require('../config/config');
const telegram = require('./telegramNotifier');
const WebSocket = require('ws');

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
      // Обрізання занадто довгого clientOrderId
      if (params.newClientOrderId && params.newClientOrderId.length > 32) {
        params.newClientOrderId = params.newClientOrderId.substring(0, 32);
      }

      // Автоматичне додавання reduceOnly для стоп-ордерів
      const conditionalTypes = ['stop', 'stop_market', 'take_profit', 'take_profit_market'];
      if (conditionalTypes.includes(type) && !params.hasOwnProperty('reduceOnly')) {
        params.reduceOnly = true;
      }

      // Встановлення GTC для лімітних ордерів
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
      console.log(`✅ Встановлено плече ${leverage}x для ${symbol}`);
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

  async getPosition(symbol) {
    try {
      const cleanSymbol = symbol.replace('/', '');
      const positions = await this.fetchPositions([cleanSymbol]);
      const position = positions.find(p => 
        p.symbol === cleanSymbol && 
        Math.abs(p.contracts) > 0.001 // Додатковий поріг для фільтрації нульових позицій
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

  async calculateCurrentProfit(symbol) {
    try {
      const position = await this.getPosition(symbol);
      if (!position) return 0;

      const ticker = await this.fetchTicker(symbol);
      const currentPrice = ticker.last;
      const entryPrice = position.entryPrice;
      const leverage = position.leverage || config.leverage || 1;
      const commissionRate = 0.0004; // Binance комісія

      let priceDifference;
      if (position.side === 'long') {
        priceDifference = currentPrice - entryPrice;
      } else {
        priceDifference = entryPrice - currentPrice;
      }

      const rawProfit = priceDifference * Math.abs(position.contracts);
      const commission = Math.abs(position.contracts) * entryPrice * commissionRate;
      const netProfit = rawProfit - commission;
      
      return netProfit * leverage;
    } catch (error) {
      console.error('🔴 Profit calculation error:', error.message);
      return 0;
    }
  }

  async updateTrailingStop(symbol, trailingPercent = 0.5) {
    if (this.trailingStopUpdateInProgress) {
      console.log('⏳ Трейлінг оновлюється, чекаємо...');
      return;
    }

    this.trailingStopUpdateInProgress = true;
    
    try {
      // Скасування старих стоп-ордерів
      await this.cancelAllOrders(symbol);
      
      const position = await this.getPosition(symbol);
      if (!position) return;

      const ticker = await this.fetchTicker(symbol);
      const price = ticker.last;
      const side = position.side;
      const amount = Math.abs(position.contracts);

      let stopPrice;
      if (side === 'long') {
        stopPrice = price * (1 - trailingPercent / 100);
      } else {
        stopPrice = price * (1 + trailingPercent / 100);
      }

      const precision = await this.getPrecision(symbol);
      const formattedStopPrice = parseFloat(stopPrice.toFixed(precision.price));

      await this.createOrder(
        symbol, 
        'TRAILING_STOP_MARKET', 
        side === 'long' ? 'sell' : 'buy', 
        amount, 
        undefined, 
        {
          callbackRate: trailingPercent,
          activationPrice: formattedStopPrice,
          reduceOnly: true
        }
      );

      console.log(`🔄 Оновлено трейлінг-стоп: ${formattedStopPrice} (${side})`);
    } catch (err) {
      console.error('🔴 Помилка трейлінг-стопа:', err.message);
    } finally {
      this.trailingStopUpdateInProgress = false;
    }
  }

  async getPrecision(symbol) {
    const markets = await this.loadMarkets();
    const market = markets[symbol];
    return {
      price: market.precision.price,
      amount: market.precision.amount
    };
  }

  async updateBreakEvenStop(symbol) {
    try {
      const position = await this.getPosition(symbol);
      if (!position) return;

      const entry = position.entryPrice;
      const side = position.side;
      const amount = Math.abs(position.contracts);
      const precision = await this.getPrecision(symbol);

      await this.createOrder(symbol, 'STOP_MARKET', side === 'long' ? 'sell' : 'buy', amount, undefined, {
        stopPrice: entry.toFixed(precision.price),
        reduceOnly: true,
        closePosition: true
      });

      console.log(`🟩 Break-even стоп оновлено до ${entry} (${side})`);
    } catch (err) {
      console.error('🔴 Помилка break-even стопа:', err.message);
    }
  }

  async initUserDataStream() {
    try {
      await this.createListenKey();
      
      // Періодичне оновлення listenKey
      this.listenKeyInterval = setInterval(async () => {
        try {
          await this.fapiPrivatePutListenKey();
          console.log('🔁 ListenKey оновлено');
        } catch (err) {
          console.error('🔴 Помилка оновлення ListenKey:', err.message);
        }
      }, 30 * 60 * 1000); // Оновлення кожні 30 хв
      
      this.setupWebSocket();
      
    } catch (err) {
      console.error('🔴 Не вдалося підʼєднати WebSocket:', err.message);
      this.scheduleReconnect();
    }
  }

  async createListenKey() {
    const res = await this.fapiPrivatePostListenKey();
    this.listenKey = res.listenKey;
    console.log('🔑 Отримано новий ListenKey');
  }

  setupWebSocket() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }

    this.ws = new WebSocket(`wss://fstream.binance.com/ws/${this.listenKey}`);
    
    this.ws.on('open', () => {
      console.log('🔗 WebSocket зʼєднання відкрите');
      if (this.wsReconnectTimeout) {
        clearTimeout(this.wsReconnectTimeout);
        this.wsReconnectTimeout = null;
      }
    });
    
    this.ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.e === 'ORDER_TRADE_UPDATE') {
          console.log('📦 Оновлення ордеру:', parsed);
          // Обробка подій ордерів
        } else if (parsed.e === 'ACCOUNT_UPDATE') {
          console.log('📊 Оновлення акаунту:', parsed);
          // Обробка змін балансу
        }
      } catch (err) {
        console.error('🔴 Помилка парсингу WebSocket повідомлення:', err);
      }
    });
    
    this.ws.on('close', (code, reason) => {
      console.log(`⚠️ WebSocket закритий: ${code} - ${reason}`);
      this.scheduleReconnect();
    });
    
    this.ws.on('error', (err) => {
      console.error('🔴 WebSocket помилка:', err.message);
      this.ws.close();
    });
  }

  scheduleReconnect() {
    if (this.wsReconnectTimeout) return;
    
    console.log('⏳ Планується перепідключення через 10с...');
    this.wsReconnectTimeout = setTimeout(() => {
      this.initUserDataStream();
    }, 10000);
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

(async () => {
  try {
    await binance.loadMarkets();
    const time = await binance.fetchTime();
    console.log('🟢 Успішне підключення до Binance. Час сервера:', new Date(time).toISOString());

    const cleanSymbol = config.symbol.replace('/', '');

    // Налаштування акаунту
    await binance.setMarginType(config.symbol, 'ISOLATED');
    await binance.setLeverage(config.leverage, config.symbol);

    // Перевірка балансу
    const balance = await binance.fetchBalance();
    const usdtBalance = balance.total?.USDT || balance.USDT?.total || 0;
    
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

    // Запуск WebSocket
    await binance.initUserDataStream();

  } catch (error) {
    console.error('🔴 Критична помилка ініціалізації:', error);
    if (telegram.enabled) {
      await telegram.sendError('initialization', error);
    }
    process.exit(1);
  }
})();

module.exports = binance;