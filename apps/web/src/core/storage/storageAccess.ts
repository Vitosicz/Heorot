export function getIDBFactory(): IDBFactory | undefined {
    try {
        if (typeof self !== "undefined" && self.indexedDB) {
            return self.indexedDB;
        }

        if (typeof window !== "undefined") {
            return window.indexedDB;
        }
    } catch {
        return undefined;
    }

    return undefined;
}

let idb: IDBDatabase | null = null;

async function idbInit(): Promise<void> {
    const idbFactory = getIDBFactory();
    if (!idbFactory) {
        throw new Error("IndexedDB not available");
    }

    idb = await new Promise((resolve, reject) => {
        const request = idbFactory.open("heorot-core", 1);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains("pickleKey")) {
                db.createObjectStore("pickleKey");
            }
            if (!db.objectStoreNames.contains("account")) {
                db.createObjectStore("account");
            }
        };
    });
}

async function idbTransaction<T>(
    table: string,
    mode: IDBTransactionMode,
    fn: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
    if (!idb) {
        await idbInit();
    }

    return await new Promise((resolve, reject) => {
        const txn = idb!.transaction([table], mode);
        txn.onerror = () => reject(txn.error ?? new Error("IndexedDB transaction failed"));

        const objectStore = txn.objectStore(table);
        const request = fn(objectStore);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
        request.onsuccess = () => resolve(request.result as T);
    });
}

export async function idbLoad<T>(table: string, key: string | string[]): Promise<T | undefined> {
    return await idbTransaction<T | undefined>(table, "readonly", (objectStore) => objectStore.get(key));
}

export async function idbSave(table: string, key: string | string[], data: unknown): Promise<void> {
    await idbTransaction(table, "readwrite", (objectStore) => objectStore.put(data, key));
}

export async function idbDelete(table: string, key: string | string[]): Promise<void> {
    await idbTransaction(table, "readwrite", (objectStore) => objectStore.delete(key));
}

export async function idbClear(table: string): Promise<void> {
    await idbTransaction(table, "readwrite", (objectStore) => objectStore.clear());
}
