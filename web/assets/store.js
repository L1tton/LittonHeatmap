/**
 * Small IndexedDB wrapper for the visitor's current dataset.
 * Everything stays in the browser; the server never receives imported/synced
 * tracks after the sync response has been rendered.
 */
const DB_NAME = 'xingzhe-trail-map';
const DB_VERSION = 1;
const STORE = 'datasets';
const KEY = 'current';

function openDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('浏览器不支持本地存储'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开本地存储'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('本地存储写入失败'));
    tx.onabort = () => reject(tx.error || new Error('本地存储写入被中止'));
  });
}

export async function saveDataset(dataset) {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ ...dataset, savedAt: Date.now() }, KEY);
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function loadDataset() {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('本地存储读取失败'));
    });
  } finally {
    db.close();
  }
}

export async function clearDataset() {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY);
    await txDone(tx);
  } finally {
    db.close();
  }
}
