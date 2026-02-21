# Windows EXE Build

This project now includes an Electron desktop wrapper.

## Download Ready EXE
- Current release tag: `v31e5266`
- Release page: `https://github.com/mordechimenaker-create/algo-trading-platform/releases/tag/v31e5266`
- Direct file: `https://github.com/mordechimenaker-create/algo-trading-platform/releases/download/v31e5266/Algo-Trading-Platform-1.0.0-x64.exe`

## What the EXE does
- Opens the dashboard URL in a desktop window.
- Tries to auto-start local stack via Docker Compose:
  - `docker compose up --build -d`
- Default URL: `http://localhost:8081/dashboard.html`
- Override URL with env var: `ALGO_DESKTOP_URL`
- Health check URL override: `ALGO_DESKTOP_HEALTH_URL`
- Disable auto-start: `ALGO_AUTO_START_STACK=0`

## Build EXE
From repo root:
```bash
npm install
npm run desktop:pack
```

Output folder:
- `desktop/dist/`

Expected artifact name:
- `Algo-Trading-Platform-1.0.0-x64.exe` (portable target)

## Run in Dev
```bash
npm run desktop:dev
```

## Important
The EXE is a desktop shell around your app URL and attempts to run Docker automatically.
If Docker Desktop is not installed/running, start services manually:
```bash
docker compose up --build -d
```

## Publish EXE to GitHub Release
1. Create/pick release tag in GitHub Releases.
2. Run workflow: `Release EXE` (`.github/workflows/release-exe.yml`).
3. Input `tag` (example: `v31e5266`).
4. Workflow builds on `windows-latest` and uploads:
- `Algo-Trading-Platform-1.0.0-x64.exe`
