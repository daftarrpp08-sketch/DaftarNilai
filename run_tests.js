// run_tests.js
// Automated tests for offline save and automatic sync with Google Spreadsheet
const fs = require('fs');
const assert = require('assert');
const vm = require('vm');

// Simple DOM & browser mock
class ElementMock {
  constructor(tag, id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.value = '';
    this.innerText = '';
    this.textContent = '';
    this.innerHTML = '';
    this.className = '';
    this.classList = {
      add: (c) => {},
      remove: (c) => {},
      toggle: (c, state) => {}
    };
    this.style = {};
    this.options = [];
  }
  closest(sel) { return null; }
  querySelector(sel) { return null; }
  querySelectorAll(sel) { return []; }
  appendChild(el) {}
  focus() {}
  select() {}
}

const elements = {};
function getOrCreateElement(id, tag = 'div') {
  if (!elements[id]) elements[id] = new ElementMock(tag, id);
  return elements[id];
}

const mockDocument = {
  getElementById: (id) => getOrCreateElement(id),
  querySelector: (sel) => {
    if (sel.startsWith('#')) return getOrCreateElement(sel.slice(1));
    return new ElementMock('div');
  },
  querySelectorAll: (sel) => [],
  createElement: (tag) => new ElementMock(tag),
  addEventListener: (event, handler) => {},
  documentElement: { cloneNode: () => new ElementMock('html') }
};

const mockLocalStorage = {
  _store: {},
  getItem: function(k) { return this._store[k] !== undefined ? this._store[k] : null; },
  setItem: function(k, v) { this._store[k] = String(v); },
  removeItem: function(k) { delete this._store[k]; },
  clear: function() { this._store = {}; },
  get length() { return Object.keys(this._store).length; },
  key: function(i) { return Object.keys(this._store)[i] || null; }
};

const listeners = {};
const mockWindow = {
  addEventListener: (evt, cb) => {
    if (!listeners[evt]) listeners[evt] = [];
    listeners[evt].push(cb);
  },
  dispatchEvent: (evt) => {
    if (listeners[evt]) listeners[evt].forEach(cb => cb());
  }
};

const mockNavigator = {
  onLine: false
};

let fetchCalls = [];
let fetchResponse = { status: 'success', message: 'OK' };
let fetchShouldFail = false;

const mockFetch = async (url, options) => {
  fetchCalls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
  if (fetchShouldFail) {
    throw new Error('Network error');
  }
  return {
    ok: true,
    json: async () => fetchResponse
  };
};

// Setup DOM elements needed initially
getOrCreateElement('mapel', 'select');
getOrCreateElement('kktp', 'select');
getOrCreateElement('guru', 'input');
getOrCreateElement('semester', 'input');
getOrCreateElement('tahun', 'input');
getOrCreateElement('gasUrlInput', 'input');
getOrCreateElement('saveStatus', 'span');
getOrCreateElement('syncStatus', 'span');
getOrCreateElement('class-content', 'div');
getOrCreateElement('tabs', 'div');

const registeredIntervals = [];
const mockSetInterval = (fn, delay) => {
  const id = setInterval(fn, delay);
  registeredIntervals.push(id);
  return id;
};

const sandbox = {
  window: mockWindow,
  document: mockDocument,
  localStorage: mockLocalStorage,
  navigator: mockNavigator,
  fetch: mockFetch,
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: mockSetInterval,
  clearInterval: clearInterval,
  Date: Date,
  Math: Math,
  JSON: JSON,
  Array: Array,
  Object: Object,
  String: String,
  Number: Number,
  parseInt: parseInt,
  parseFloat: parseFloat,
  isNaN: isNaN,
  Map: Map,
  Set: Set,
  Promise: Promise
};

vm.createContext(sandbox);

const htmlContent = fs.readFileSync('index.html', 'utf8');
const scriptMatch = htmlContent.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
if (!scriptMatch) {
  console.error('Failed to locate script block in index.html');
  process.exit(1);
}

// Convert top-level `let` and `const` to `var` so they attach to sandbox scope in vm
let scriptCode = scriptMatch[1]
  .replace(/^(\s*)let\s+/gm, '$1var ')
  .replace(/^(\s*)const\s+/gm, '$1var ');

vm.runInContext(scriptCode, sandbox);

async function runTestSuite() {
  console.log('Starting automated tests in VM context...');

  try {
    // Initialize app
    await sandbox.initApp();

    console.log('Test 1: Check initial app state and local storage');
    assert.strictEqual(typeof sandbox.saveData, 'function', 'saveData function exists');
    assert.strictEqual(typeof sandbox.autoSave, 'function', 'autoSave function exists');
    assert.strictEqual(typeof sandbox.syncCurrentClassToGas, 'function', 'syncCurrentClassToGas exists');
    assert.strictEqual(typeof sandbox.syncAllClassesToGas, 'function', 'syncAllClassesToGas exists');
    assert.strictEqual(typeof sandbox.queueAllClassesSync, 'function', 'queueAllClassesSync exists');
    assert.ok(sandbox.classData.length > 0, 'classData is initialized');
    console.log('✓ Initial functions and classData defined with ' + sandbox.classData.length + ' classes');

    console.log('Test 2: Set GAS URL and verify offline queue behavior when offline');
    sandbox.gasUrl = 'https://script.google.com/macros/s/test/exec';
    sandbox.navigator.onLine = false;
    fetchCalls = [];

    // Update a student and trigger autoSave
    sandbox.classData[0].students[0].name = 'Budi Santoso';
    sandbox.classData[0].students[0].uh[0] = '85';
    sandbox.saveData();

    // Test sync when offline
    sandbox.queueClassSync(0);

    assert.strictEqual(fetchCalls.length, 0, 'No network fetch when offline');
    const storedQueue = JSON.parse(mockLocalStorage.getItem(sandbox.GAS_QUEUE_KEY) || '[]');
    assert.ok(storedQueue.length > 0, 'Offline queue has pending items');
    assert.ok(sandbox.document.getElementById('syncStatus').innerText.includes('Offline'), 'Sync status displays offline');
    console.log('✓ Queued successfully while offline, queue count:', storedQueue.length);

    console.log('Test 3: Queue deduplication for same class');
    sandbox.classData[0].students[0].uh[1] = '90';
    sandbox.queueClassSync(0);
    const queueAfterSecond = JSON.parse(mockLocalStorage.getItem(sandbox.GAS_QUEUE_KEY) || '[]');
    const matchingClass0 = queueAfterSecond.filter(item => item.className === sandbox.classData[0].name);
    assert.strictEqual(matchingClass0.length, 1, 'Class 0 payload is deduplicated in queue');
    console.log('✓ Queue deduplication works');

    console.log('Test 4: Queue all classes offline');
    sandbox.queueAllClassesSync();
    const queueAll = JSON.parse(mockLocalStorage.getItem(sandbox.GAS_QUEUE_KEY) || '[]');
    assert.strictEqual(queueAll.length, sandbox.classData.length, 'All classes queued for offline sync');
    console.log('✓ Queue all classes works with ' + queueAll.length + ' classes');

    console.log('Test 5: Online event triggers queue processing');
    sandbox.navigator.onLine = true;
    fetchCalls = [];
    fetchShouldFail = false;

    await sandbox.processGasQueue();

    assert.ok(fetchCalls.length > 0, 'Fetch was called when processing queue online');
    const queueAfterOnline = JSON.parse(mockLocalStorage.getItem(sandbox.GAS_QUEUE_KEY) || '[]');
    assert.strictEqual(queueAfterOnline.length, 0, 'Queue is empty after successful sync');
    assert.ok(sandbox.document.getElementById('syncStatus').innerText.includes('Tersinkron'), 'Sync status displays synced');
    console.log('✓ Offline queue successfully synchronized when online');

    console.log('\nAll offline save & sync assertions passed successfully!\n');
  } finally {
    // Clean up intervals so node process exits cleanly
    registeredIntervals.forEach(id => clearInterval(id));
  }
}

runTestSuite().catch(err => {
  registeredIntervals.forEach(id => clearInterval(id));
  console.error('Test failed with error:', err);
  process.exit(1);
});
