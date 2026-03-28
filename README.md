# Shared Lens

This version is fully self-hosted. It does not use Firebase, Google login, Stripe, S3, or any other third-party runtime service.

## What It Does

- Protects the admin area with a local password
- Stores gallery metadata in a local JSON database
- Stores uploaded photos and videos on disk
- Serves the public gallery directly from the same container
- Lets guests upload anonymously, with optional credit names
- Lets visitors download the full gallery archive

## Run Locally

1. Set `ADMIN_PASSWORD` and `COOKIE_SECRET` in `docker-compose.yml` or pass them as environment variables.
2. Start the app:

```bash
docker compose up --build
```

3. Open `http://localhost:3000`

## Data Storage

- Gallery metadata is stored in `db.json` inside the mounted data volume.
- Uploads are stored in the same volume under `uploads/`.

## Useful Notes

- The public gallery URL format is `http://your-host/<gallery-slug>`.
- The admin page is at `/form`.
- The gallery page still supports `Ctrl+Shift+D` / `Cmd+Shift+D` to download the full archive.
