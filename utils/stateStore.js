/**
 * Простий JSON-стор у папці state/ — щоб бот пам'ятав позицію та лічильники ризику після перезапуску.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'state');

function file(name) {
  return path.join(DIR, `${name}.json`);
}

function read(name) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return null;
  }
}

function write(name, data) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (data === null || data === undefined) {
      if (fs.existsSync(file(name))) fs.unlinkSync(file(name));
    } else {
      fs.writeFileSync(file(name), JSON.stringify(data, null, 2));
    }
  } catch (error) {
    console.warn(`⚠️ Не вдалося зберегти стан "${name}": ${error.message}`);
  }
}

module.exports = { read, write };
