# Shared Lens

This repo now runs as a fully self-hosted app.

## Run With Docker

1. Copy `.env.example` to `.env` and set `SESSION_SECRET`
2. If you want account creation to require a host-provided password, set `ACCOUNT_CREATION_PASSWORD` in `.env` (e.g., `ACCOUNT_CREATION_PASSWORD=mypassword`).
3. Start and update the container from this folder with `docker compose up --build`.
4. Open `http://localhost:3000` to run the website from your computer. Or open `http://<YOUR-IP>:3000` to view it from anywhere.
5. To shut down the container but keep your uploaded data and settings, run `docker compose down`. To delete everything the app has stored after shutdown, delete the `data` directory in this folder.

## Notes

- Uploaded originals and thumbnails are stored under `data/media/`.
- Guest uploads use a signed uploader cookie so each browser can only delete its own files. If a browser clears its cookies, that browser loses delete access to uploads it previously made. This matches the anonymous-upload model, but the restriction is now enforced server-side instead of by localStorage alone.
