/**
 * IndexedDB for Dev Manager — versioned upgrades only add stores/indexes;
 * existing records are preserved across app updates.
 */

const DB_NAME = 'dev-manager-app'
/** Bump when adding stores or indexes; use incremental migrations below. */
export const APP_DB_VERSION = 1

const STORE_CONNECTIONS = 'dbConnections'

let dbPromise: Promise<IDBDatabase> | null = null

function runMigrations(db: IDBDatabase, oldVersion: number, _newVersion: number) {
  if (oldVersion < 1) {
    if (!db.objectStoreNames.contains(STORE_CONNECTIONS)) {
      db.createObjectStore(STORE_CONNECTIONS, { keyPath: 'id' })
    }
  }
  // Example for a future release:
  // if (oldVersion < 2) {
  //   const tx = db.transaction(STORE_CONNECTIONS, 'readwrite')
  //   tx.objectStore(STORE_CONNECTIONS).createIndex('byGroup', 'projectGroupId', { unique: false })
  // }
}

export function openAppDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, APP_DB_VERSION)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
      req.onsuccess = () => resolve(req.result)
      req.onupgradeneeded = (ev) => {
        const db = req.result
        runMigrations(db, ev.oldVersion, ev.newVersion ?? APP_DB_VERSION)
      }
    })
  }
  return dbPromise
}

export async function idbClearConnections(): Promise<void> {
  const db = await openAppDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_CONNECTIONS, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.objectStore(STORE_CONNECTIONS).clear()
  })
}

export async function idbGetAllConnectionRecords<T extends { id: string }>(): Promise<T[]> {
  const db = await openAppDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CONNECTIONS, 'readonly')
    const store = tx.objectStore(STORE_CONNECTIONS)
    const req = store.getAll()
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve((req.result ?? []) as T[])
  })
}

export async function idbPutConnectionRecord<T extends { id: string }>(row: T): Promise<void> {
  const db = await openAppDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_CONNECTIONS, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.objectStore(STORE_CONNECTIONS).put(row)
  })
}

export async function idbPutAllConnectionRecords<T extends { id: string }>(rows: T[]): Promise<void> {
  const db = await openAppDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_CONNECTIONS, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    const store = tx.objectStore(STORE_CONNECTIONS)
    const clearReq = store.clear()
    clearReq.onerror = () => reject(clearReq.error)
    clearReq.onsuccess = () => {
      for (const row of rows) {
        store.put(row)
      }
    }
  })
}
