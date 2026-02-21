# PWA Installation

The dashboard is now installable as a Progressive Web App (PWA).

## Endpoints/Files
- Manifest: `/manifest.webmanifest`
- Service worker: `/service-worker.js`
- Icons: `/icons/icon-192.svg`, `/icons/icon-512.svg`

## How to Install
- Desktop Chrome/Edge:
  - Open `http://localhost:8081`
  - Click `Install App` in the dashboard header (or browser install icon).
- Android Chrome:
  - Open the app URL.
  - Use browser menu: `Install app`.
- iOS Safari:
  - Open app URL.
  - `Share` -> `Add to Home Screen`.

## Notes
- API calls (`/api/*`) remain network-first.
- App shell is cached for offline opening of dashboard UI.
- For full PWA installability in some browsers, HTTPS is required outside localhost.
