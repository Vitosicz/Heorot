# @heorot/web

React web app package within the Heorot monorepo. For user-facing documentation, setup guides, and voice configuration see the [root README](../../README.md).

---

## Development

```bash
# From repo root
pnpm dev:web        # dev server → http://localhost:5173
pnpm build:web      # production build → apps/web/dist/
pnpm typecheck      # TypeScript type check

# From this package directory
pnpm dev
pnpm build
pnpm typecheck
pnpm test           # vitest unit tests
```

---

## Architecture

```
src/
├── core/           # Matrix infrastructure (config, session lifecycle, storage, crypto)
│   ├── client/     # MatrixClientManager — client instance lifecycle
│   ├── config/     # Config loading and types
│   ├── lifecycle/  # SessionLifecycle — login, restore, sign-out
│   ├── platform/   # WebPlatform abstraction (pickle key, OIDC)
│   └── storage/    # IndexedDB, localStorage, encrypted token helpers
└── ui/             # React UI layer
    ├── adapters/   # Bridge between Matrix SDK and UI components
    ├── components/ # React components (AppShell, Timeline, Composer, ...)
    ├── emoji/      # Custom emoji pack store and resolver
    ├── hooks/      # Shared React hooks
    ├── mentions/   # @mention tokenization
    ├── notifications/ # Sound and notification hooks
    ├── presence/   # Presence VM and config
    ├── providers/  # MatrixProvider (central state machine)
    ├── serviceWorker/ # Media service worker registration
    ├── settings/   # User and server settings panels
    ├── stores/     # Channel order, categories, spacers
    ├── utils/      # Avatar color, MXC helpers, permalink
    └── voice/      # Voice channel discovery and LiveKit integration
```

**State machine** (`MatrixProvider`): `booting` → `login_required` / `starting` → `security_verification` / `security_recovery` → `ready`

---

## Runtime config

Config is loaded from `config.json` at startup. Copy from `config.example.json`:

```bash
cp config.example.json config.json
```

See the [root README configuration reference](../../README.md#configuration-reference-configjson) for all keys.

---

## Presence gate

Presence indicators are gated per homeserver in `config.json`:

```json
{
  "enable_presence_by_hs_url": {
    "https://matrix.example.com": true,
    "http://localhost:8008": true
  }
}
```

If omitted, presence defaults to enabled for localhost and the configured homeserver.

---

## Troubleshooting

**`WebAssembly: Response has unsupported MIME type 'text/html'`**
Run through `pnpm dev` or `pnpm preview`. If self-hosting, ensure `.wasm` files are served as `application/wasm`.

**`Failed to resolve import "@matrix-org/matrix-sdk-crypto-wasm"`**
Run `pnpm install` from the repo root, then clear Vite cache (`node_modules/.vite`) and restart.

---

## Tests

```bash
pnpm test           # run all unit tests (vitest)
```

Tests live in `test/unit-tests/`. Coverage areas: adapters, emoji, mentions, presence, settings, stores, voice.
