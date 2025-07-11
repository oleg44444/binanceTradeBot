const TelegramBot = require('node-telegram-bot-api');
const config = require('../config/config');

class TelegramNotifier {
  constructor() {
    if (config.telegram && config.telegram.token && config.telegram.chatId) {
      this.bot = new TelegramBot(config.telegram.token, {polling: false});
      this.chatId = config.telegram.chatId;
      this.enabled = true;
      console.log('🟢 Telegram сповіщення увімкнено');
    } else {
      this.enabled = false;
      console.warn('⚠️ Telegram сповіщення вимкнено: відсутні токен або chatId');
    }
  }

  async sendMessage(message, markdown = true) {
    if (!this.enabled) return false;
    
    try {
      const options = markdown ? {parse_mode: 'Markdown'} : {};
      await this.bot.sendMessage(this.chatId, message, options);
      console.log('✉️ Повідомлення відправлено в Telegram');
      return true;
    } catch (error) {
      console.error('🔴 Помилка відправки в Telegram:', error.message);
      return false;
    }
  }

  async sendPositionOpened(type, symbol, amount, entryPrice, tpPrice, slPrice, balance) {
    if (!this.enabled) return false;
    
    const positionSize = (amount * entryPrice).toFixed(2);
    const positionPercent = ((amount * entryPrice) / balance * 100).toFixed(1);
    const positionType = type === 'buy' ? 'LONG 🟢' : 'SHORT 🔴';
    const symbolName = symbol.replace('/USDT', '');
    
    const message = `
*${positionType} НОВА ПОЗИЦІЯ ${symbolName}*

▫️ *Напрямок:* ${type.toUpperCase()}
▫️ *Обсяг:* ${amount} ${symbolName}
▫️ *Ціна входу:* ${entryPrice.toFixed(2)}
▫️ *Тейк-профіт:* ${tpPrice.toFixed(2)}
▫️ *Стоп-лосс:* ${slPrice.toFixed(2)}
▫️ *Розмір позиції:* $${positionSize} (${positionPercent}%)
▫️ *Баланс:* ${balance.toFixed(2)} USDT
    `;

    return this.sendMessage(message);
  }

  async sendPositionUpdated(newStop, newTakeProfit, currentProfit) {
    if (!this.enabled) return false;
    
    const profitIcon = currentProfit >= 0 ? '📈' : '📉';
    const profitSign = currentProfit >= 0 ? '+' : '';
    
    const message = `
*🔄 ОНОВЛЕНО УМОВИ*

▫️ *Новий стоп:* ${newStop.toFixed(2)}
▫️ *Новий тейк:* ${newTakeProfit.toFixed(2)}
▫️ *Поточний прибуток:* ${profitSign}${currentProfit.toFixed(2)}% ${profitIcon}
    `;

    return this.sendMessage(message);
  }

  async sendPositionClosed(closePrice, profitPercent, profitAmount, newBalance) {
    if (!this.enabled) return false;
    
    const resultIcon = profitPercent >= 0 ? '✅' : '❌';
    const resultText = profitPercent >= 0 
      ? `*Прибуток:* +${profitPercent.toFixed(2)}% (+${profitAmount.toFixed(2)} USDT)` 
      : `*Збиток:* ${profitPercent.toFixed(2)}% (${profitAmount.toFixed(2)} USDT)`;
    
    const profitSign = profitAmount >= 0 ? '+' : '';
    
    const message = `
*${resultIcon} ПОЗИЦІЮ ЗАКРИТО*

▫️ *Ціна закриття:* ${closePrice.toFixed(2)}
▫️ ${resultText}
▫️ *Новий баланс:* ${newBalance.toFixed(2)} USDT
▫️ *Зміна балансу:* ${profitSign}${profitAmount.toFixed(2)} USDT
    `;

    return this.sendMessage(message);
  }

  async sendError(context, error) {
    if (!this.enabled) return false;
    
    const message = `
*🚨 ПОМИЛКА ${context.toUpperCase()}*

_Деталі:_ ${error.message || error}
_Час:_ ${new Date().toLocaleString()}
    `;

    return this.sendMessage(message);
  }
}


module.exports = new TelegramNotifier();