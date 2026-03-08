import { afterEach } from "vitest";

class MemoryStorage implements Storage {
    private readonly store = new Map<string, string>();

    public get length(): number {
        return this.store.size;
    }

    public clear(): void {
        this.store.clear();
    }

    public getItem(key: string): string | null {
        return this.store.has(key) ? this.store.get(key)! : null;
    }

    public key(index: number): string | null {
        const keys = [...this.store.keys()];
        return index >= 0 && index < keys.length ? keys[index] : null;
    }

    public removeItem(key: string): void {
        this.store.delete(key);
    }

    public setItem(key: string, value: string): void {
        this.store.set(String(key), String(value));
    }
}

const memoryStorage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage,
});

afterEach(() => {
    memoryStorage.clear();
});
