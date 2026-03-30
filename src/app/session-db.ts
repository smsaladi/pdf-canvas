// IndexedDB session persistence + recent files list.
// "session" store: current document state (PDF buffer, page, zoom)
// "recentFiles" store: last N opened files with metadata + thumbnail

const DB_NAME = "pdf-canvas";
const DB_VERSION = 2; // v2 adds recentFiles store
const SESSION_STORE = "session";
const RECENT_STORE = "recentFiles";
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_RECENT_FILES = 10;

export interface SessionData {
  pdfBuffer: ArrayBuffer;
  filename: string;
  currentPage: number;
  zoom: number;
  timestamp: number;
}

export interface RecentFile {
  filename: string;
  /** Size in bytes of the PDF */
  size: number;
  /** When this file was last opened */
  lastOpened: number;
  /** The PDF buffer for reopening */
  pdfBuffer: ArrayBuffer;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE);
      }
      if (!db.objectStoreNames.contains(RECENT_STORE)) {
        db.createObjectStore(RECENT_STORE, { keyPath: "filename" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function putKV(db: IDBDatabase, store: string, key: string, value: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getKV<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function clearStoreData(db: IDBDatabase, store: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getAllFromStore<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

function putObject(db: IDBDatabase, store: string, value: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function deleteFromStore(db: IDBDatabase, store: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = openDB();
  return dbPromise;
}

// ===== Session (current document) =====

export async function saveSession(
  pdfBuffer: ArrayBuffer,
  filename: string,
  currentPage: number,
  zoom: number,
): Promise<void> {
  try {
    const db = await getDB();
    await putKV(db, SESSION_STORE, "pdfBuffer", pdfBuffer);
    await putKV(db, SESSION_STORE, "filename", filename);
    await putKV(db, SESSION_STORE, "currentPage", currentPage);
    await putKV(db, SESSION_STORE, "zoom", zoom);
    await putKV(db, SESSION_STORE, "timestamp", Date.now());
  } catch (err) {
    console.warn("[Session] Failed to save:", err);
  }
}

export async function loadSession(): Promise<SessionData | null> {
  try {
    const db = await getDB();
    const timestamp = await getKV<number>(db, SESSION_STORE, "timestamp");
    if (!timestamp || Date.now() - timestamp > SESSION_MAX_AGE_MS) {
      return null;
    }
    const pdfBuffer = await getKV<ArrayBuffer>(db, SESSION_STORE, "pdfBuffer");
    const filename = await getKV<string>(db, SESSION_STORE, "filename");
    if (!pdfBuffer || !filename || pdfBuffer.byteLength === 0) {
      await clearStoreData(db, SESSION_STORE);
      return null;
    }
    const currentPage = (await getKV<number>(db, SESSION_STORE, "currentPage")) ?? 0;
    const zoom = (await getKV<number>(db, SESSION_STORE, "zoom")) ?? 1.0;
    return { pdfBuffer, filename, currentPage, zoom, timestamp };
  } catch (err) {
    console.warn("[Session] Failed to load:", err);
    return null;
  }
}

export async function getSessionInfo(): Promise<{ filename: string; timestamp: number; currentPage: number; zoom: number } | null> {
  try {
    const db = await getDB();
    const timestamp = await getKV<number>(db, SESSION_STORE, "timestamp");
    if (!timestamp) return null;
    const filename = await getKV<string>(db, SESSION_STORE, "filename") || "unknown";
    const currentPage = (await getKV<number>(db, SESSION_STORE, "currentPage")) ?? 0;
    const zoom = (await getKV<number>(db, SESSION_STORE, "zoom")) ?? 1.0;
    return { filename, timestamp, currentPage, zoom };
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  try {
    const db = await getDB();
    await clearStoreData(db, SESSION_STORE);
  } catch (err) {
    console.warn("[Session] Failed to clear:", err);
  }
}

// ===== Recent Files =====

export async function addRecentFile(filename: string, pdfBuffer: ArrayBuffer): Promise<void> {
  try {
    const db = await getDB();
    const entry: RecentFile = {
      filename,
      size: pdfBuffer.byteLength,
      lastOpened: Date.now(),
      pdfBuffer,
    };
    await putObject(db, RECENT_STORE, entry);

    // Trim to MAX_RECENT_FILES (keep most recent)
    const all = await getAllFromStore<RecentFile>(db, RECENT_STORE);
    if (all.length > MAX_RECENT_FILES) {
      all.sort((a, b) => b.lastOpened - a.lastOpened);
      for (const old of all.slice(MAX_RECENT_FILES)) {
        await deleteFromStore(db, RECENT_STORE, old.filename);
      }
    }
  } catch (err) {
    console.warn("[RecentFiles] Failed to add:", err);
  }
}

export async function getRecentFiles(): Promise<Omit<RecentFile, "pdfBuffer">[]> {
  try {
    const db = await getDB();
    const all = await getAllFromStore<RecentFile>(db, RECENT_STORE);
    // Return metadata only (no buffer) sorted by most recent
    return all
      .sort((a, b) => b.lastOpened - a.lastOpened)
      .map(({ filename, size, lastOpened }) => ({ filename, size, lastOpened }));
  } catch {
    return [];
  }
}

export async function openRecentFile(filename: string): Promise<ArrayBuffer | null> {
  try {
    const db = await getDB();
    const entry = await getKV<RecentFile>(db, RECENT_STORE, filename);
    if (entry?.pdfBuffer) {
      // Update lastOpened
      entry.lastOpened = Date.now();
      await putObject(db, RECENT_STORE, entry);
      return entry.pdfBuffer;
    }
    return null;
  } catch {
    return null;
  }
}

export async function removeRecentFile(filename: string): Promise<void> {
  try {
    const db = await getDB();
    await deleteFromStore(db, RECENT_STORE, filename);
  } catch (err) {
    console.warn("[RecentFiles] Failed to remove:", err);
  }
}

export async function clearRecentFiles(): Promise<void> {
  try {
    const db = await getDB();
    await clearStoreData(db, RECENT_STORE);
  } catch (err) {
    console.warn("[RecentFiles] Failed to clear:", err);
  }
}
