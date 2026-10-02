const ccxt = require('ccxt');
const config = require('../config/config');
const telegram = require('./telegramNotifier');

// Глобальний флаг для запобігання повторній ініціалізації
let isClientInitialized = false;
let initializationPromise = null;

// Валідація конфігурації
function validateConfig() {
  if (!config.binance) {
    throw new Error('❌ Конфігурація Binance відсутня');
  }

  const apiKey = config.binance.apiKey;
  const apiSecret = config.binance.apiSecret;

  if (!apiKey || !apiSecret) {
    throw new Error('❌ API ключі відсутні у конфігурації');
  }

  if (typeof apiKey !== 'string' || typeof apiSecret !== 'string') {
    throw new Error('❌ API ключі мають бути рядками');
  }

  if (apiKey.trim().length === 0 || apiSecret.trim().length === 0) {
    throw new Error('❌ API ключі не можуть бути порожніми');
  }

  return { apiKey: apiKey.trim(), apiSecret: apiSecret.trim() };
}

// Функція для створення клієнта Binance з правильним контекстом
function createBinanceClient(apiKey, apiSecret) {
  const client = new ccxt.binance({
    apiKey,
    secret: apiSecret,
    options: {
      defaultType: 'future',
      adjustForTimeDifference: true
    },
    enableRateLimit: true,
    timeout: 30000,
    rateLimit: 150
  });

  // Demo Trading (demo.binance.com) -> demo-fapi.binance.com
  // Потрібно викликати ДО loadMarkets()
  if (config.binance.demo) {
    if (typeof client.enableDemoTrading !== 'function') {
      throw new Error(
        '❌ Ваша версія ccxt не підтримує Demo Trading. Виконайте: npm install ccxt@latest'
      );
    }
    client.enableDemoTrading(true);
    console.log('🧪 Режим: Binance DEMO Trading (demo-fapi.binance.com)');
  } else {
    console.log('⚠️ Режим: РЕАЛЬНИЙ акаунт (fapi.binance.com)');
  }

  // Додаємо додаткові методи з правильним контекстом
  client.setLeverage = async (leverage, symbol) => {
    try {
      await client.fapiPrivatePostLeverage({
        symbol: symbol.replace('/', ''),
        leverage: leverage
      });
    } catch (error) {
      console.error('🔴 Помилка встановлення плеча:', error.message);
      if (!error.message.includes('No need to change leverage')) {
        throw error;
      }
    }
  };

  client.setMarginType = async (symbol, marginType = 'ISOLATED') => {
    try {
      await client.fapiPrivatePostMarginType({
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
  };

  client.fetchPosition = async (symbol) => {
    try {
      const cleanSymbol = symbol.replace('/', '');
      const positions = await client.fetchPositions([cleanSymbol]);
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
  };

  client.destroy = async () => {
    try {
      console.log('✅ Binance client destroyed');
    } catch (err) {
      console.error('🔴 Помилка при знищенні ресурсу:', err.message);
    }
  };

  return client;
}

// Обробка завершення процесу
process.on('SIGINT', async () => {
  console.log('🛑 Завершення роботи...');
  process.exit();
});

process.on('SIGTERM', async () => {
  console.log('🛑 Отримано сигнал SIGTERM, завершення роботи...');
  process.exit();
});

// Функція для ініціалізації клієнта
async function initializeBinanceClient() {
  if (isClientInitialized) {
    console.log('ℹ️ Binance клієнт вже ініціалізовано');
    return binanceInstance;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    try {
      console.log('🔄 Початок ініціалізації Binance клієнта...');
      
      const { apiKey, apiSecret } = validateConfig();

      // Створюємо клієнт Binance
      const binanceInstance = createBinanceClient(apiKey, apiSecret);

      // Завантаження ринків
     
      await binanceInstance.loadMarkets();
      console.log('✅ Ринки завантажено');

      // Отримання часу сервера
      console.log('🕐 Отримання часу сервера...');
      const time = await binanceInstance.fetchTime();
      
      let serverDateString;
      try {
        if (typeof time === 'number' && !isNaN(time)) {
          serverDateString = new Date(time).toISOString();
        } else {
          serverDateString = 'невідомий (невалідний час)';
        }
      } catch (dateError) {
        console.warn('🟡 Помилка форматування дати:', dateError.message);
        serverDateString = 'невідомий (помилка форматування)';
      }
      
      console.log('🟢 Успішне підключення до Binance. Час сервера:', serverDateString);

      // Перевірка символу
      if (!config.symbol) {
        throw new Error('❌ Символ торгівлі не вказано в конфігурації');
      }

      const cleanSymbol = config.symbol.replace('/', '');
      console.log(`📊 Використовується символ: ${config.symbol} (${cleanSymbol})`);

      // Налаштування акаунту
      try {
        console.log('⚙️ Налаштування типу маржі...');
        await binanceInstance.setMarginType(config.symbol, 'ISOLATED');
      } catch (marginError) {
        console.warn('🟡 Попередження при налаштуванні маржі:', marginError.message);
      }

      try {
        console.log('⚙️ Налаштування плеча...');
        await binanceInstance.setLeverage(config.leverage || 20, config.symbol);
        console.log(`✅ Плече встановлено: ${config.leverage || 20}x`);
      } catch (leverageError) {
        console.warn('🟡 Попередження при налаштуванні плеча:', leverageError.message);
      }

      // Отримання балансу
      console.log('💰 Отримання балансу...');
      let usdtBalance = 0;
      let balanceInfo = 'невідомий';
      
      try {
        const balance = await binanceInstance.fetchBalance({ type: 'future' });

        if (balance && typeof balance === 'object') {
          usdtBalance = balance.total?.USDT || 
                       balance.USDT?.total || 
                       balance.total?.usdt || 
                       balance.usdt?.total || 
                       balance.free?.USDT ||
                       balance.USDT?.free ||
                       0;
          
          balanceInfo = `${usdtBalance.toFixed(2)} USDT`;
          console.log('✅ Баланс отримано:', balanceInfo);
        } else {
          console.warn('🟡 Неочікувана структура балансу');
        }
      } catch (balanceError) {
        console.error('🔴 Помилка отримання балансу:', balanceError.message);
        balanceInfo = 'помилка отримання';
      }
      
      // Перевірка позицій
      let usedMargin = 0;
      try {
        console.log('📊 Перевірка позицій...');
        const positions = await binanceInstance.fetchPositions([cleanSymbol]);
        const position = positions.find(p => p.symbol === cleanSymbol);
        usedMargin = position ? Math.abs(position.notional) / (config.leverage || 20) : 0;
        console.log(`✅ Використано маржі: ${usedMargin.toFixed(2)} USDT`);
      } catch (positionError) {
        console.warn('🟡 Помилка перевірки позицій:', positionError.message);
      }

      console.log('💰 Підсумок балансу:', {
        total: `${usdtBalance.toFixed(2)} USDT`,
        available: `${(usdtBalance - usedMargin).toFixed(2)} USDT`,
        usedMargin: `${usedMargin.toFixed(2)} USDT`
      });

      // Відправка повідомлення в Telegram
      if (telegram && telegram.enabled) {
        try {
          await telegram.sendMessage(
            `🚀 Бот успішно запущено!\n` +
            `- Символ: ${config.symbol}\n` +
            `- Баланс: ${balanceInfo}\n` +
            `- Плече: ${config.leverage || 20}x\n` +
            `- Використано маржі: ${usedMargin.toFixed(2)} USDT\n` +
            `- Час сервера: ${serverDateString}`
          );
        } catch (telegramError) {
          console.warn('🟡 Помилка відправки в Telegram:', telegramError.message);
        }
      }

      // Попередження про низький баланс
      if (usdtBalance > 0 && usdtBalance < 100) {
        console.warn('⚠️ Увага: баланс менше 100 USDT. Рекомендується поповнити рахунок.');
      }

      isClientInitialized = true;
      console.log('✅ Binance клієнт ініціалізовано успішно');
      return binanceInstance;

    } catch (error) {
      console.error('🔴 Критична помилка ініціалізації:', error.message);
      console.error('🔍 Стек помилки:', error.stack);
      
      if (telegram && telegram.enabled) {
        try {
          await telegram.sendError('initialization', error);
        } catch (telegramError) {
          console.error('🔴 Помилка відправки помилки в Telegram:', telegramError.message);
        }
      }
      
      isClientInitialized = false;
      initializationPromise = null;
      
      throw error;
    }
  })();

  return initializationPromise;
}

// Експортуємо функцію, яка повертає проміс ініціалізації клієнта
module.exports = function getBinanceClient() {
  if (!initializationPromise) {
    initializationPromise = initializeBinanceClient();
  }
  return initializationPromise;
};