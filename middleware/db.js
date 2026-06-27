const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/db.json');

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    console.error('DB read error:', e.message);
    return {};
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.error('DB write error:', e.message);
    return false;
  }
}

// Generic CRUD operations
const db = {
  // Find all records in a collection
  findAll: (collection) => {
    const data = readDB();
    return data[collection] || [];
  },

  // Find records matching a filter
  find: (collection, filter = {}) => {
    const data = readDB();
    const items = data[collection] || [];
    return items.filter(item =>
      Object.keys(filter).every(key => item[key] === filter[key])
    );
  },

  // Find one record
  findOne: (collection, filter = {}) => {
    const data = readDB();
    const items = data[collection] || [];
    return items.find(item =>
      Object.keys(filter).every(key => item[key] === filter[key])
    ) || null;
  },

  // Find by ID
  findById: (collection, id) => {
    const data = readDB();
    const items = data[collection] || [];
    return items.find(item => item.id === id) || null;
  },

  // Insert a record
  insert: (collection, record) => {
    const data = readDB();
    if (!data[collection]) data[collection] = [];
    data[collection].push(record);
    writeDB(data);
    return record;
  },

  // Update a record by ID
  updateById: (collection, id, updates) => {
    const data = readDB();
    const items = data[collection] || [];
    const idx = items.findIndex(item => item.id === id);
    if (idx === -1) return null;
    items[idx] = { ...items[idx], ...updates, updated_at: new Date().toISOString() };
    data[collection] = items;
    writeDB(data);
    return items[idx];
  },

  // Update many matching records
  updateMany: (collection, filter, updates) => {
    const data = readDB();
    const items = data[collection] || [];
    let count = 0;
    data[collection] = items.map(item => {
      const matches = Object.keys(filter).every(key => item[key] === filter[key]);
      if (matches) { count++; return { ...item, ...updates, updated_at: new Date().toISOString() }; }
      return item;
    });
    writeDB(data);
    return count;
  },

  // Delete by ID
  deleteById: (collection, id) => {
    const data = readDB();
    const items = data[collection] || [];
    const idx = items.findIndex(item => item.id === id);
    if (idx === -1) return false;
    items.splice(idx, 1);
    data[collection] = items;
    writeDB(data);
    return true;
  },

  // Count records
  count: (collection, filter = {}) => {
    const data = readDB();
    const items = data[collection] || [];
    if (Object.keys(filter).length === 0) return items.length;
    return items.filter(item =>
      Object.keys(filter).every(key => item[key] === filter[key])
    ).length;
  },

  // Increment a field
  increment: (collection, id, field, by = 1) => {
    const data = readDB();
    const items = data[collection] || [];
    const idx = items.findIndex(item => item.id === id);
    if (idx === -1) return null;
    items[idx][field] = (items[idx][field] || 0) + by;
    items[idx].updated_at = new Date().toISOString();
    data[collection] = items;
    writeDB(data);
    return items[idx];
  }
};

module.exports = db;
