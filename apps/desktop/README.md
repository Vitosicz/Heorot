# Heorot Desktop

Electron desktop wrapper for Heorot Web.

## Install

```bash
cd apps/desktop
pnpm install
```

## Development

Starts the workspace web Vite dev server and launches Electron:

```bash
pnpm run dev
```

Optional override for custom web URL:

```bash
HEOROT_DESKTOP_DEV_URL=http://127.0.0.1:5173 pnpm run dev
```

System audio capture mode on Windows screen sharing:

- default: `loopback` (keeps local Windows playback unchanged)
- optional strict mode: `loopbackWithMute` (prevents local app audio bleed into stream)

```bash
HEOROT_DESKTOP_SYSTEM_AUDIO_CAPTURE_MODE=loopbackWithMute pnpm run dev
```

## Build web assets

Builds workspace web app and copies `dist` into `apps/desktop/web`:

```bash
pnpm run build:web
```

## Build desktop app

Compiles Electron main/preload:

```bash
pnpm run build:electron
```

Build everything + package installer:

```bash
pnpm run dist
```

## macOS packaging (Matrix-native flow)

Build unsigned (default, local/dev):

```bash
pnpm run dist:mac
```

Build specific unsigned architectures:

```bash
pnpm run dist:mac:x64:unsigned
pnpm run dist:mac:arm64:unsigned
pnpm run dist:mac:universal:unsigned
```

Build signed/notarized-ready packages (for CI/release):

```bash
APPLE_TEAM_ID=... \
APPLE_ID=... \
APPLE_APP_SPECIFIC_PASSWORD=... \
CSC_LINK=... \
CSC_KEY_PASSWORD=... \
pnpm run dist:mac:universal:signed
```

Notes:

- macOS builds should be run on macOS hosts.
- Output artifacts are in `apps/desktop/dist-electron` (`.dmg` + `-mac.zip`).
- The mac build uses hardened runtime + entitlements from `electron/entitlements.mac.plist`.
