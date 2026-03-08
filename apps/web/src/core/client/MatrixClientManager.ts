import {
    type ICreateClientOpts,
    type IStartClientOpts,
    type MatrixClient,
    type TokenRefreshFunction,
    MemoryStore,
    PendingEventOrdering,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import type { MatrixClientAssignOpts, MatrixCredentials } from "../types/credentials";
import { createMatrixClient } from "./createMatrixClient";

export interface MatrixClientManagerOptions {
    initialSyncLimit?: number;
    lazyLoadMembers?: boolean;
    initRustCrypto?: boolean;
}

export class MatrixClientManager {
    private matrixClient: MatrixClient | null = null;
    private readonly lazyLoadMembers: boolean;
    private readonly rustCryptoEnabled: boolean;

    public readonly startOptions: IStartClientOpts;

    public constructor(options: MatrixClientManagerOptions = {}) {
        this.startOptions = {
            initialSyncLimit: options.initialSyncLimit ?? 20,
        };
        this.lazyLoadMembers = options.lazyLoadMembers ?? true;
        this.rustCryptoEnabled = options.initRustCrypto !== false;
    }

    public get(): MatrixClient | null {
        return this.matrixClient;
    }

    public safeGet(): MatrixClient {
        if (!this.matrixClient) {
            throw new Error("Matrix client has not been created yet");
        }

        return this.matrixClient;
    }

    public replaceUsingCreds(creds: MatrixCredentials, tokenRefreshFunction?: TokenRefreshFunction): void {
        this.createClient(creds, tokenRefreshFunction);
    }

    public unset(): void {
        this.matrixClient = null;
    }

    public stop(unset = true): void {
        if (!this.matrixClient) {
            return;
        }

        this.matrixClient.stopClient();
        this.matrixClient.removeAllListeners();
        this.matrixClient.store.destroy();

        if (unset) {
            this.unset();
        }
    }

    public async assign(assignOpts: MatrixClientAssignOpts = {}): Promise<IStartClientOpts> {
        if (!this.matrixClient) {
            throw new Error("createClient must be called before assign");
        }

        for (const dbType of ["indexeddb", "memory"]) {
            try {
                await this.matrixClient.store.startup();
                break;
            } catch (error) {
                if (dbType === "indexeddb") {
                    logger.warn("Matrix store startup failed, falling back to MemoryStore", error);
                    this.matrixClient.store = new MemoryStore({ localStorage: window.localStorage });
                } else {
                    throw error;
                }
            }
        }

        if (this.rustCryptoEnabled) {
            await this.initClientCrypto(assignOpts);
        }

        const opts: IStartClientOpts = {
            ...this.startOptions,
            pendingEventOrdering: PendingEventOrdering.Detached,
            lazyLoadMembers: this.lazyLoadMembers,
            threadSupport: true,
            clientWellKnownPollPeriod: 2 * 60 * 60,
        };

        return opts;
    }

    public async start(assignOpts: MatrixClientAssignOpts = {}): Promise<void> {
        const opts = await this.assign(assignOpts);
        await this.safeGet().startClient(opts);
    }

    private createClient(creds: MatrixCredentials, tokenRefreshFunction?: TokenRefreshFunction): void {
        const opts: ICreateClientOpts = {
            baseUrl: creds.homeserverUrl,
            idBaseUrl: creds.identityServerUrl,
            accessToken: creds.accessToken,
            refreshToken: creds.refreshToken,
            tokenRefreshFunction,
            userId: creds.userId,
            deviceId: creds.deviceId,
            pickleKey: creds.pickleKey,
            timelineSupport: true,
        };

        this.matrixClient = createMatrixClient(opts);
        this.matrixClient.setGuest(Boolean(creds.guest));
    }

    private async initClientCrypto(assignOpts: MatrixClientAssignOpts): Promise<void> {
        if (!this.matrixClient) {
            throw new Error("createClient must be called before initClientCrypto");
        }

        await this.matrixClient.initRustCrypto({
            storageKey: assignOpts.rustCryptoStoreKey,
            storagePassword: assignOpts.rustCryptoStorePassword,
        });
    }
}
