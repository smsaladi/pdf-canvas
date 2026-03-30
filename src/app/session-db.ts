// IndexedDB session persistence — saves/restores the open PDF across page reloads.
// Uses a simple key-value store in IndexedDB. Sessions expire after 24 hours.

const DB_NAME = "pdf-canvas";
const DB_VERSION = 1;
const STORE_NAME = "session";
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface SessionData {
  pdfBuffer: ArrayBuffer;
  filename: string;
  currentPage: number;
  zoom: number;
  timestamp: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function put(db: IDBDatabase, key: string, value: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function get<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function clearStore(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = openDB();
  return dbPromise;
}

export async function saveSession(
  pdfBuffer: ArrayBuffer,
  filename: string,
  currentPage: number,
  zoom: number,
): Promise<void> {
  try {
    const db = await getDB();
    await put(db, "pdfBuffer", pdfBuffer);
    await put(db, "filename", filename);
    await put(db, "currentPage", currentPage);
    await put(db, "zoom", zoom);
    await put(db, "timestamp", Date.now());
  } catch (err) {
    console.warn("[Session] Failed to save:", err);
  }
}

export async function loadSession(): Promise<SessionData | null> {
  try {
    const db = await getDB();
    const timestamp = await get<number>(db, "timestamp");
    if (!timestamp || Date.now() - timestamp > SESSION_MAX_AGE_MS) {
      return null; // expired or no session
    }
    const pdfBuffer = await get<ArrayBuffer>(db, "pdfBuffer");
    const filename = await get<string>(db, "filename");
    if (!pdfBuffer || !filename) return null;

    const currentPage = (await get<number>(db, "currentPage")) ?? 0;
    const zoom = (await get<number>(db, "zoom")) ?? 1.0;

    return { pdfBuffer, filename, currentPage, zoom, timestamp };
  } catch (err) {
    console.warn("[Session] Failed to load:", err);
    return null;
  }
}

export async function clearSession(): Promise<void> {
  try {
    const db = await getDB();
    await clearStore(db);
  } catch (err) {
    console.warn("[Session] Failed to clear:", err);
  }
}
