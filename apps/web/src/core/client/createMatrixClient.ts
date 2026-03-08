import {
    type ICreateClientOpts,
    type MatrixClient,
    MemoryCryptoStore,
    MemoryStore,
    IndexedDBCryptoStore,
    IndexedDBStore,
    LocalStorageCryptoStore,
    createClient,
} from "matrix-js-sdk/src/matrix";

let indexedDBFactory: IDBFactory | undefined;
try {
    indexedDBFactory = window.indexedDB;
} catch {
    indexedDBFactory = undefined;
}

const localStorageRef = typeof window !== "undefined" ? window.localStorage : undefined;

export function createMatrixClient(opts: ICreateClientOpts): MatrixClient {
    const storeOpts: Partial<ICreateClientOpts> = {
        useAuthorizationHeader: true,
    };

    if (indexedDBFactory && localStorageRef) {
        storeOpts.store = new IndexedDBStore({
            indexedDB: indexedDBFactory,
            dbName: "riot-web-sync",
            localStorage: localStorageRef,
        });
    } else if (localStorageRef) {
        storeOpts.store = new MemoryStore({ localStorage: localStorageRef });
    }

    if (indexedDBFactory) {
        storeOpts.cryptoStore = new IndexedDBCryptoStore(indexedDBFactory, "matrix-js-sdk:crypto");
    } else if (localStorageRef) {
        storeOpts.cryptoStore = new LocalStorageCryptoStore(localStorageRef);
    } else {
        storeOpts.cryptoStore = new MemoryCryptoStore();
    }

    return createClient({
        ...storeOpts,
        ...opts,
    });
}
