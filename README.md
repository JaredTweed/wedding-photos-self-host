# Shared Lens

This repo now runs as a fully self-hosted app.

- `index.html`, `form.html`, and `home.html` are served locally by `server.js`
- Site metadata is stored in `data/db.json`
- Uploaded originals and thumbnails are stored under `data/media/`
- Site owners create their own username/password accounts, and each site belongs to its owner account
- Guest uploads use a signed uploader cookie so each browser can only delete its own files
- The editor includes a `Storage Availability` page at `/users` that shows per-user storage usage, total used, remaining available, and total capacity, and refreshes live while open

## Run Locally

1. Copy `.env.example` to `.env` and set `SESSION_SECRET`
2. Install dependencies with `npm install`
3. Start the app with `npm start`
4. Open `http://localhost:3000`
5. Create your first account on the main page, then open the site editor

## Run With Docker

1. Copy `.env.example` to `.env` and set `SESSION_SECRET`
2. Start the container with `docker compose up --build`
3. Open `http://localhost:3000`
4. Create your first account on the main page, then open the site editor

Uploaded data is persisted in the local `./data` directory through the compose volume.

## Shareable Links

- When the app is accessed via `localhost` or loopback, it now tries to replace that hostname with the machine's LAN IP in the editor links and QR codes.
- In Docker, the container cannot reliably infer your host machine's LAN IP, so set `PUBLIC_BASE_URL` to your actual shareable address.
- To force an exact public address or domain, set `PUBLIC_BASE_URL`, for example:
  `PUBLIC_BASE_URL=http://192.168.1.50:3000`

## Notes

- If a browser clears its cookies, that browser loses delete access to uploads it previously made. This matches the anonymous-upload model, but the restriction is now enforced server-side instead of by localStorage alone.

