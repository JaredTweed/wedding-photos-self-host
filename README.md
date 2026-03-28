# Shared Lens

This repo now runs as a fully self-hosted app.

- `index.html`, `form.html`, and `home.html` are served locally by `server.js`
- Site metadata is stored in `data/db.json`
- Uploaded originals and thumbnails are stored under `data/media/`
- Admin access uses a password-backed session cookie
- Guest uploads use a signed uploader cookie so each browser can only delete its own files
- Stripe, Firebase, Firestore, Google login, S3, Cognito, and external QR generation have been removed

## Run Locally

1. Copy `.env.example` to `.env` and set `ADMIN_PASSWORD` and `SESSION_SECRET`
2. Install dependencies with `npm install`
3. Start the app with `npm start`
4. Open `http://localhost:3000`

## Run With Docker

1. Copy `.env.example` to `.env` and set `ADMIN_PASSWORD` and `SESSION_SECRET`
2. Start the container with `docker compose up --build`
3. Open `http://localhost:3000`

Uploaded data is persisted in the local `./data` directory through the compose volume.

## Notes

- The landing page uses `/demo` as the built-in empty demo gallery.
- If a browser clears its cookies, that browser loses delete access to uploads it previously made. This matches the anonymous-upload model, but the restriction is now enforced server-side instead of by localStorage alone.
