const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/db.json');

// FIX: Pehle har call pe disk se poori file read + write hoti thi.
// Ab ek baar load karke RAM mein cache rakhte hain. Reads cache se milte hain
// (instant), writes debounce hoke batch mein disk pe jaati hain (100ms window)
// — 100 users ek second mein aaye toh bhi disk pe sirf 1 write jaayegi, na ki 100.

let cache = null;
let writeTimer = null;
let writeInFlight = false;
let pendingWriteWhileInFlight = false;

function loadDB() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    console.error('DB read error:', e.message);
    cache = {};
  }
  return cache;
}

function flushToDisk() {
  if (!cache) return;
  writeInFlight = true;
  fs.writeFile(DB_PATH, JSON.stringify(cache, null, 2), (err) => {
    writeInFlight = false;
    if (err) console.error('DB write error:', err.message);
    if (pendingWriteWhileInFlight) {
      pendingWriteWhileInFlight = false;
      scheduleWrite();
    }
  });
}

function scheduleWrite() {
  if (writeInFlight) { pendingWriteWhileInFlight = true; return; }
  if (writeTimer) return; // already scheduled, will pick up latest cache
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flushToDisk();
  }, 100);
}

// Synchronous flush — used on process exit so we never lose a debounced write
function flushSync() {
  if (!cache) return;
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error('DB flushSync error:', e.message);
  }
}

['SIGINT', 'SIGTERM'].forEach(evt => process.on(evt, () => { flushSync(); process.exit(0); }));
process.on('beforeExit', flushSync);

// Generic CRUD operations
const db = {
  findAll: (collection) => {
    const data = loadDB();
    return data[collection] || [];
  },

  find: (collection, filter = {}) => {
    const data = loadDB();
    const items = data[collection] || [];
    return items.filter(item =>
      Object.keys(filter).every(key => item[key] === filter[key])
    );
  },

  findOne: (collection, filter = {}) => {
    const data = loadDB();
    const items = data[collection] || [];
    return items.find(item =>
      Object.keys(filter).every(key => item[key] === filter[key])
    ) || null;
  },

  findById: (collection, id) => {
    const data = loadDB();
    const items = data[collection] || [];
    return items.find(item => item.id === id) || null;
  },

  insert: (collection, record) => {
    const data = loadDB();
    if (!data[collection]) data[collection] = [];
    data[collection].push(record);
    scheduleWrite();
    return record;
  },

  updateById: (collection, id, updates) => {
    const data = loadDB();
    const items = data[collection] || [];
    const idx = items.findIndex(item => item.id === id);
    if (idx === -1) return null;
    items[idx] = { ...items[idx], ...updates, updated_at: new Date().toISOString() };
    data[collection] = items;
    scheduleWrite();
    return items[idx];
  },

  updateMany: (collection, filter, updates) => {
    const data = loadDB();
    const items = data[collection] || [];
    let count = 0;
    data[collection] = items.map(item => {
      const matches = Object.keys(filter).every(key => item[key] === filter[key]);
      if (matches) { count++; return { ...item, ...updates, updated_at: new Date().toISOString() }; }
      return item;
    });
    scheduleWrite();
    return count;
  },

  deleteById: (collection, id) => {
    const data = loadDB();
    const items = data[collection] || [];
    const idx = items.findIndex(item => item.id === id);
    if (idx === -1) return false;
    items.splice(idx, 1);
    data[collection] = items;
    scheduleWrite();
    return true;
  },

  count: (collection, filter = {}) => {
    const data = loadDB();
    const items = data[collection] || [];
    if (Object.keys(filter).length === 0) return items.length;
    return items.filter(item =>
      Object.keys(filter).every(key => item[key] === filter[key])
    ).length;
  },

  increment: (collection, id, field, by = 1) => {
    const data = loadDB();
    const items = data[collection] || [];
    const idx = items.findIndex(item => item.id === id);
    if (idx === -1) return null;
    items[idx][field] = (items[idx][field] || 0) + by;
    items[idx].updated_at = new Date().toISOString();
    data[collection] = items;
    scheduleWrite();
    return items[idx];
  }
};

module.exports = db;
