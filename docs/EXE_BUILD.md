# Windows EXE Build

This project now includes an Electron desktop wrapper.

## What the EXE does
- Opens the dashboard URL in a desktop window.
- Default URL: `http://localhost:8081/dashboard.html`
- Override URL with env var: `ALGO_DESKTOP_URL`

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
The EXE is a desktop shell around your app URL.
You still need backend/frontend running (for local mode):
```bash
docker compose up --build -d
```
