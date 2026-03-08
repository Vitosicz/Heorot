# Heorot

A self-hosted Matrix client built to feel like Discord. Spaces are servers. Rooms are channels. End-to-end encryption is on by default.

Runs as a web app or a native desktop client (Windows · macOS · Linux).

**What makes it different:**
- Discord-style spaces and channels on top of the open Matrix protocol
- Voice channels — self-hosted, no third-party infra required
- Custom emoji per space and personal packs
- Fully self-hostable in minutes via Docker Compose

> Heavily inspired by [Element Web](https://github.com/element-hq/element-web). Independent implementation, not a fork.

---

## Status

Personal open-source experiment — alpha stage. Core features work, rough edges remain. Breaking changes between updates are possible.

---

## Goals

- Community-first Matrix UX with Discord-like interaction patterns
- Strong self-hosting support — one domain, one compose file
- Privacy by default: E2EE on, no analytics, no telemetry
- Open protocol, open source

---

## Features

**Messaging**
- Channels and DMs with replies and message editing
- Reactions with custom emoji support (per-space and personal emoji packs)
- Read receipts and typing indicators
- Inline image viewer (lightbox)
- Pinned messages

**Voice** *(requires heorot-voice-relay)*
- Voice channels alongside text channels
- Mic mute / audio mute
- Live participant list
- Auto-discovery via `/.well-known/matrix/client`

**Spaces (servers)**
- Space hierarchy: spaces contain channels, categories keep them organized
- Channel ordering — manual drag-and-drop or activity-sorted
- Collapsible categories
- Discoverable channels within a space
- Space and channel settings, visibility controls, member management, role permissions

**Security**
- End-to-end encryption via Rust Crypto WASM (matrix-sdk-crypto)
- Cross-signing and device verification (SAS and QR code)
- Key backup and security recovery (secret storage)
- Forced verification mode (server-configurable)

**User experience**
- Online/offline/away presence indicators
- User profiles with avatar and roles
- Resizable channel sidebar
- Appearance themes (light / dark)
- Notification sounds

**Desktop extras** *(Electron)*
- Native window with titlebar overlay
- Screen sharing and system audio capture (Windows)
- Window state persistence across restarts
- Authenticated media (no token-in-URL)

---

## Stack

| Layer | Technology |
|---|---|
| UI | React 19, TypeScript, Vite |
| Matrix | matrix-js-sdk 40.x, Rust Crypto WASM |
| Voice | LiveKit client |
| Desktop | Electron 34, electron-builder |
| Package manager | pnpm 10 |

---

## Prerequisites

- Node.js 22 LTS (or later)
- pnpm 10+ (or npm 10+)
- A Matrix homeserver (e.g. [Synapse](https://github.com/element-hq/synapse))

---

## Quick start (web)

```bash
git clone https://github.com/Vitosicz/heorot.git
cd heorot
pnpm install
```

Copy the example config and point it at your homeserver:

```bash
cp apps/web/config.example.json apps/web/config.json
```

Edit `apps/web/config.json`:

```json
{
  "default_server_config": {
    "m.homeserver": {
      "base_url": "https://matrix.example.com",
      "server_name": "matrix.example.com"
    }
  },
  "brand": "Heorot",
  "disable_guests": false,
  "disable_custom_urls": false,
  "force_verification": false,
  "voice_enabled": false
}
```

Start the dev server:

```bash
pnpm dev:web
# → http://localhost:5173
```

Build for production:

```bash
pnpm build:web
# Output: apps/web/dist/
```

---

## Desktop (Electron)

Requires the web app to be built first.

```bash
# Development
pnpm dev:desktop

# Windows installer (.exe)
pnpm dist:desktop

# Linux AppImage
pnpm dist:linux

# macOS DMG (unsigned, local dev)
pnpm dist:mac:universal:unsigned
```

macOS signed release requires `APPLE_TEAM_ID`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `CSC_LINK`, and `CSC_KEY_PASSWORD` — see `apps/desktop/package.json` for the full command.

### Linux setup

Some Linux environments fail on Windows-targeted install scripts during `pnpm install`. Use the safe path:

```bash
pnpm setup:linux
```

---

## Configuration reference (`config.json`)

| Key | Type | Default | Description |
|---|---|---|---|
| `default_server_config` | object | — | Default homeserver and identity server |
| `brand` | string | `"Heorot"` | App name shown in the UI |
| `disable_guests` | boolean | `false` | Hide guest login option |
| `disable_custom_urls` | boolean | `false` | Lock to the default homeserver |
| `force_verification` | boolean | `false` | Require device verification before access |
| `voice_enabled` | boolean | `false` | Enable voice channel UI |
| `voice_service_url` | string | — | Base URL of heorot-voice-relay (e.g. `https://matrix.example.com`) |
| `livekit_ws_url` | string | — | LiveKit WebSocket URL (legacy, overridden by discovery) |
| `enable_presence_by_hs_url` | object | `{}` | Map of homeserver URLs to presence opt-in |

The app also supports voice auto-discovery via `/.well-known/matrix/client` — if the relay is running, `voice_service_url` can be omitted.

---

## Voice channels

Voice requires two additional services:

- **[heorot-voice-relay](https://github.com/Vitosicz/heorot-voice-relay)** — Matrix-authenticated token service
- **[LiveKit](https://livekit.io)** — media server

**heorot-voice-relay ships a ready-made Docker Compose stack** (Synapse + LiveKit + relay + Caddy with auto TLS). Three commands from zero to running:

```bash
cp .env.example .env          # set your domain and LiveKit keys (5 placeholders)
docker compose up -d           # starts all four services

# Create the first admin (one-time):
docker compose exec synapse register_new_matrix_user -c /data/homeserver.yaml http://localhost:8008

# Get an admin access token (log in as the admin you just created):
curl -s -X POST "https://your-domain.com/_matrix/client/v3/login" \
  -H "Content-Type: application/json" \
  -d '{"type":"m.login.password","user":"admin","password":"your_password"}' \
  | grep -o '"access_token":"[^"]*"'

# Create a registration token so others can sign up:
curl -X POST "https://your-domain.com/_synapse/admin/v1/registration_tokens/new" \
  -H "Authorization: Bearer <access_token_from_above>" \
  -H "Content-Type: application/json" \
  -d '{"uses_allowed": 10}'
# Users enter the token on the registration screen.
# Omit uses_allowed for an unlimited token, or add "expiry_time" (unix ms) to expire it.
```

Then set `"voice_enabled": true` in `config.json` — the relay URL is auto-discovered via `/.well-known/matrix/client`.

See [heorot-voice-relay](https://github.com/Vitosicz/heorot-voice-relay) for the full setup guide.

---

## All commands

```bash
# From repo root — pnpm
pnpm dev:web
pnpm dev:desktop
pnpm build:web
pnpm build:desktop
pnpm dist:desktop       # Windows
pnpm dist:linux         # Linux AppImage
pnpm dist:mac           # macOS DMG (unsigned)

# Tests
pnpm --filter @heorot/web test

# Type checking
pnpm typecheck

# From repo root — npm
npm run dev:web
npm run dev:desktop
npm run build:web
npm run build:desktop
```

---

## Known limitations

- **Alpha stage** — UX and some settings flows are still evolving
- **No auto-updater** — update by pulling the repo and rebuilding
- **Voice is in-memory** — participant state resets on relay restart; rate limiting is not shared across multiple relay instances
- **No push notifications** — browser/OS notifications only while the app is open
- **Voice media is direct UDP** — RTP traffic cannot go through an HTTP proxy; clients need UDP access to LiveKit or an external TURN server
- **End-to-end tests** — coverage is unit tests only; integration and E2E test suite is not yet in place

---

## Roadmap

Planned:
- Mobile clients (Android / iOS)
- Push notifications
- Voice participant limit and scaling improvements
- Federation UX improvements

---

## Contributing

1. Fork and clone the repo
2. Install dependencies: `pnpm install`
3. Start dev server: `pnpm dev:web`
4. Make your changes and open a pull request

Bug reports and feature requests are welcome via [GitHub Issues](https://github.com/Vitosicz/heorot/issues).

---

## License

[AGPL-3.0](LICENSE)
