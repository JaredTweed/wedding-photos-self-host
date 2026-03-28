const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promises: fs, createReadStream, createWriteStream, existsSync } = require('node:fs');

const ROOT_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'change-me-too';
const AUTH_COOKIE_NAME = 'sl_admin';
const TITLE_RE = /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/;
const FONT_KEYS = new Set(['serif', 'sans']);
const RESERVED_SLUGS = new Set([
  '404',
  'api',
  'assets',
  'form',
  'home',
  'icons',
  'media',
  'scripts',
  'styles'
]);
const EMPTY_DB = { sites: [], uploads: [] };
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webm': 'video/webm',
  '.webp': 'image/webp'
};

let writeQueue = Promise.resolve();

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || 'http';
  const host = req.headers.host || `localhost:${PORT}`;
  return `${protocol}://${host}`;
}

function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function parseCookies(header = '') {
  return header.split(';').reduce((acc, entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return acc;
    const separator = trimmed.indexOf('=');
    if (separator === -1) return acc;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function adminCookieValue() {
  return crypto.createHmac('sha256', COOKIE_SECRET).update(ADMIN_PASSWORD).digest('hex');
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return cookies[AUTH_COOKIE_NAME] === adminCookieValue();
}

function authCookieHeader() {
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(adminCookieValue())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}

function clearCookieHeader() {
  return `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function siteDirectory(slug) {
  return path.join(UPLOADS_DIR, slug);
}

function filesDirectory(slug) {
  return path.join(siteDirectory(slug), 'files');
}

function thumbsDirectory(slug) {
  return path.join(siteDirectory(slug), 'thumbs');
}

function mediaUrl(slug, folder, fileName) {
  return `/media/${encodeURIComponent(slug)}/${folder}/${encodeURIComponent(fileName)}`;
}

function sanitizeFilename(name) {
  const rawName = String(name || 'upload');
  const originalExt = path.extname(rawName);
  const safeExt = originalExt.replace(/[^A-Za-z0-9.]/g, '').toLowerCase().slice(0, 12);
  const base = path
    .basename(rawName, originalExt)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return `${base || 'upload'}${safeExt}`;
}

function normalizeClientId(value) {
  const clientId = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(clientId)) {
    throw createHttpError(400, 'A valid browser client id is required.');
  }
  return clientId;
}

function normalizeCredit(value) {
  return String(value || '').trim().slice(0, 80);
}

function normalizeIsoDate(value, fallback = new Date()) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fallback.toISOString();
  }
  return parsed.toISOString();
}

function slugFromTitle(title) {
  const cleanTitle = String(title || '').trim().replace(/\s+/g, ' ');
  if (!TITLE_RE.test(cleanTitle)) {
    throw createHttpError(400, 'Title may only contain letters, numbers, and single spaces between words.');
  }
  const slug = cleanTitle.toLowerCase().replace(/ /g, '-');
  if (RESERVED_SLUGS.has(slug)) {
    throw createHttpError(400, 'That title is reserved. Please choose a different gallery name.');
  }
  return { cleanTitle, slug };
}

function normalizeFontKey(value) {
  const key = String(value || '').trim();
  return FONT_KEYS.has(key) ? key : 'serif';
}

function normalizePrimaryColor(value) {
  const color = String(value || '').trim();
  const match = color.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/i);
  if (!match) {
    throw createHttpError(400, 'Primary color must be an hsl(...) value.');
  }
  const hue = Number(match[1]);
  const saturation = Number(match[2]);
  const lightness = Number(match[3]);
  const valid =
    Number.isFinite(hue) &&
    Number.isFinite(saturation) &&
    Number.isFinite(lightness) &&
    hue >= 0 &&
    hue <= 360 &&
    saturation >= 0 &&
    saturation <= 100 &&
    lightness >= 0 &&
    lightness <= 100;
  if (!valid) {
    throw createHttpError(400, 'Primary color must be an hsl(...) value.');
  }
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function safeJoin(baseDir, unsafeRelativePath) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, unsafeRelativePath);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw createHttpError(403, 'Invalid path.');
  }
  return resolved;
}

function sortByUpdatedAt(a, b) {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function sortUploads(a, b) {
  return new Date(b.takenAt || b.createdAt).getTime() - new Date(a.takenAt || a.createdAt).getTime();
}

function serializeSite(site, db, req) {
  const uploadCount = db.uploads.filter((upload) => upload.siteSlug === site.slug).length;
  return {
    slug: site.slug,
    title: site.title,
    primaryColor: site.primaryColor,
    fontFamily: site.fontFamily,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
    uploadCount,
    url: `${requestOrigin(req)}/${site.slug}`
  };
}

function serializeUpload(upload) {
  return {
    id: upload.id,
    siteSlug: upload.siteSlug,
    originalName: upload.originalName,
    mimeType: upload.mimeType,
    mediaType: upload.mediaType,
    size: upload.size,
    createdAt: upload.createdAt,
    takenAt: upload.takenAt,
    credit: upload.credit || '',
    url: mediaUrl(upload.siteSlug, 'files', upload.storedName),
    thumbUrl: upload.thumbName ? mediaUrl(upload.siteSlug, 'thumbs', upload.thumbName) : mediaUrl(upload.siteSlug, 'files', upload.storedName)
  };
}

async function ensureStorage() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  try {
    await fs.access(DB_FILE);
  } catch {
    await writeDb(EMPTY_DB);
  }
}

async function readDbDirect() {
  await ensureStorage();
  const raw = await fs.readFile(DB_FILE, 'utf8');
  const parsed = JSON.parse(raw || '{}');
  return {
    sites: Array.isArray(parsed.sites) ? parsed.sites : [],
    uploads: Array.isArray(parsed.uploads) ? parsed.uploads : []
  };
}

async function readDb() {
  try {
    await writeQueue;
  } catch {
    // Ignore previous write failures here; they will surface on the originating request.
  }
  return readDbDirect();
}

async function writeDb(db) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${DB_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(db, null, 2), 'utf8');
  await fs.rename(tempFile, DB_FILE);
}

async function updateDb(mutator) {
  const operation = writeQueue
    .catch(() => {})
    .then(async () => {
      const db = await readDbDirect();
      const result = await mutator(db);
      await writeDb(db);
      return result;
    });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function headersFromNodeRequest(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => headers.append(key, entry));
      continue;
    }
    if (value != null) {
      headers.set(key, value);
    }
  }
  return headers;
}

function toWebRequest(req, url) {
  const init = {
    method: req.method,
    headers: headersFromNodeRequest(req)
  };
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }
  return new Request(url, init);
}

async function readJsonBody(req, url, { allowEmpty = false } = {}) {
  const request = toWebRequest(req, url);
  const text = await request.text();
  if (!text.trim()) {
    if (allowEmpty) return {};
    throw createHttpError(400, 'Request body is required.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw createHttpError(400, 'Request body must be valid JSON.');
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

function redirect(res, location, status = 302) {
  res.writeHead(status, { Location: location });
  res.end();
}

async function serveFile(req, res, filePath, status = 200, extraHeaders = {}) {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    throw createHttpError(404, 'File not found.');
  }
  res.writeHead(status, {
    'Content-Type': contentTypeFor(filePath),
    'Content-Length': stats.size,
    ...extraHeaders
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(createReadStream(filePath), res);
}

async function serve404(req, res) {
  await serveFile(req, res, path.join(ROOT_DIR, '404.html'), 404);
}

async function writeBlobToFile(blob, targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await pipeline(Readable.fromWeb(blob.stream()), createWriteStream(targetPath));
}

async function renameSiteDirectory(fromSlug, toSlug) {
  if (!fromSlug || !toSlug || fromSlug === toSlug) return;
  const source = siteDirectory(fromSlug);
  const target = siteDirectory(toSlug);
  if (!existsSync(source)) return;
  if (existsSync(target)) {
    throw createHttpError(409, 'A storage directory for that gallery already exists.');
  }
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.rename(source, target);
}

async function removeUploadFiles(upload) {
  const tasks = [
    fs.rm(path.join(filesDirectory(upload.siteSlug), upload.storedName), { force: true }),
    upload.thumbName ? fs.rm(path.join(thumbsDirectory(upload.siteSlug), upload.thumbName), { force: true }) : Promise.resolve()
  ];
  await Promise.all(tasks);
}

async function handleArchive(req, res, slug) {
  const db = await readDb();
  const site = db.sites.find((entry) => entry.slug === slug);
  if (!site) {
    sendJson(res, 404, { error: 'Gallery not found.' });
    return true;
  }

  const uploads = db.uploads.filter((entry) => entry.siteSlug === slug).sort(sortUploads);
  if (uploads.length === 0) {
    sendJson(res, 404, { error: 'This gallery does not have any uploads yet.' });
    return true;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveName = `${slug}-originals-${timestamp}.zip`;
  const zip = spawn('zip', ['-j', '-', '-@'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stderr = '';
  zip.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  zip.on('error', (error) => {
    if (!res.headersSent) {
      sendJson(res, 500, { error: error.message || 'Could not build the archive.' });
      return;
    }
    res.destroy(error);
  });

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${archiveName}"`,
    'Cache-Control': 'no-store'
  });

  zip.stdout.pipe(res);
  uploads.forEach((upload) => {
    zip.stdin.write(`${path.join(filesDirectory(slug), upload.storedName)}\n`);
  });
  zip.stdin.end();

  zip.on('close', (code) => {
    if (code === 0) return;
    const error = stderr.trim() || 'Could not build the archive.';
    if (!res.writableEnded) {
      res.destroy(new Error(error));
    }
  });

  return true;
}

async function routeRequest(req, res) {
  const url = new URL(req.url || '/', requestOrigin(req));
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (pathname === '/api/auth/status' && req.method === 'GET') {
    sendJson(res, 200, { authenticated: isAuthenticated(req) });
    return true;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readJsonBody(req, url);
    const password = String(body.password || '');
    if (!password) {
      throw createHttpError(400, 'Password is required.');
    }
    const provided = Buffer.from(password);
    const expected = Buffer.from(ADMIN_PASSWORD);
    const matches = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
    if (!matches) {
      throw createHttpError(401, 'Incorrect password.');
    }
    sendJson(
      res,
      200,
      { authenticated: true },
      { 'Set-Cookie': authCookieHeader() }
    );
    return true;
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    sendJson(
      res,
      200,
      { authenticated: false },
      { 'Set-Cookie': clearCookieHeader() }
    );
    return true;
  }

  if (pathname === '/api/public/sites' && req.method === 'GET') {
    const db = await readDb();
    const sites = db.sites.slice().sort(sortByUpdatedAt).map((site) => serializeSite(site, db, req));
    sendJson(res, 200, { sites });
    return true;
  }

  const publicSiteMatch = pathname.match(/^\/api\/public\/sites\/([a-z0-9-]+)$/);
  if (publicSiteMatch && req.method === 'GET') {
    const slug = publicSiteMatch[1];
    const db = await readDb();
    const site = db.sites.find((entry) => entry.slug === slug);
    if (!site) {
      throw createHttpError(404, 'Gallery not found.');
    }
    sendJson(res, 200, {
      site: {
        ...serializeSite(site, db, req),
        primaryColor: site.primaryColor,
        fontFamily: site.fontFamily
      }
    });
    return true;
  }

  const publicUploadListMatch = pathname.match(/^\/api\/public\/sites\/([a-z0-9-]+)\/uploads$/);
  if (publicUploadListMatch && req.method === 'GET') {
    const slug = publicUploadListMatch[1];
    const db = await readDb();
    const site = db.sites.find((entry) => entry.slug === slug);
    if (!site) {
      throw createHttpError(404, 'Gallery not found.');
    }
    const uploads = db.uploads
      .filter((entry) => entry.siteSlug === slug)
      .sort(sortUploads)
      .map((entry) => serializeUpload(entry));
    sendJson(res, 200, { uploads });
    return true;
  }

  if (publicUploadListMatch && req.method === 'POST') {
    const slug = publicUploadListMatch[1];
    const db = await readDb();
    const site = db.sites.find((entry) => entry.slug === slug);
    if (!site) {
      throw createHttpError(404, 'Gallery not found.');
    }

    const formData = await toWebRequest(req, url).formData();
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) {
      throw createHttpError(400, 'A file upload is required.');
    }

    const thumb = formData.get('thumb');
    const hasThumb = thumb instanceof File && thumb.size > 0;
    const clientId = normalizeClientId(formData.get('clientId'));
    const credit = normalizeCredit(formData.get('credit'));
    const takenAt = normalizeIsoDate(formData.get('takenAt'), new Date(file.lastModified || Date.now()));
    const createdAt = new Date().toISOString();
    const id = crypto.randomUUID();
    const safeOriginalName = sanitizeFilename(file.name);
    const storedName = `${id}-${safeOriginalName}`;
    const thumbName = hasThumb ? `thumb-${id}.jpg` : '';
    const mediaType = String(file.type || '').startsWith('video/') ? 'video' : 'image';
    const upload = {
      id,
      siteSlug: slug,
      originalName: file.name || safeOriginalName,
      storedName,
      thumbName,
      mimeType: file.type || 'application/octet-stream',
      mediaType,
      size: file.size,
      credit,
      clientId,
      createdAt,
      takenAt
    };

    await writeBlobToFile(file, path.join(filesDirectory(slug), storedName));
    if (hasThumb) {
      await writeBlobToFile(thumb, path.join(thumbsDirectory(slug), thumbName));
    }

    await updateDb(async (mutableDb) => {
      const existingSite = mutableDb.sites.find((entry) => entry.slug === slug);
      if (!existingSite) {
        throw createHttpError(404, 'Gallery not found.');
      }
      mutableDb.uploads.push(upload);
      existingSite.updatedAt = createdAt;
    });

    sendJson(res, 201, { upload: serializeUpload(upload) });
    return true;
  }

  const publicUploadMatch = pathname.match(/^\/api\/public\/sites\/([a-z0-9-]+)\/uploads\/([0-9a-f-]+)$/);
  if (publicUploadMatch && req.method === 'DELETE') {
    const [, slug, uploadId] = publicUploadMatch;
    const authenticated = isAuthenticated(req);
    const body = await readJsonBody(req, url, { allowEmpty: true });
    const suppliedClientId = body.clientId ? normalizeClientId(body.clientId) : '';

    await updateDb(async (db) => {
      const upload = db.uploads.find((entry) => entry.siteSlug === slug && entry.id === uploadId);
      if (!upload) {
        throw createHttpError(404, 'Upload not found.');
      }
      if (!authenticated && upload.clientId !== suppliedClientId) {
        throw createHttpError(403, 'You can only delete uploads from this browser session.');
      }
      db.uploads = db.uploads.filter((entry) => !(entry.siteSlug === slug && entry.id === uploadId));
      const site = db.sites.find((entry) => entry.slug === slug);
      if (site) {
        site.updatedAt = new Date().toISOString();
      }
      await removeUploadFiles(upload);
    });

    sendJson(res, 200, { deleted: true });
    return true;
  }

  const publicArchiveMatch = pathname.match(/^\/api\/public\/sites\/([a-z0-9-]+)\/archive$/);
  if (publicArchiveMatch && req.method === 'GET') {
    return handleArchive(req, res, publicArchiveMatch[1]);
  }

  if (pathname === '/api/admin/sites') {
    if (!isAuthenticated(req)) {
      throw createHttpError(401, 'Authentication required.');
    }

    if (req.method === 'GET') {
      const db = await readDb();
      const slugFilter = String(url.searchParams.get('slug') || '').trim().toLowerCase();
      if (slugFilter) {
        const site = db.sites.find((entry) => entry.slug === slugFilter);
        sendJson(res, 200, { site: site ? serializeSite(site, db, req) : null });
        return true;
      }
      const sites = db.sites.slice().sort(sortByUpdatedAt).map((site) => serializeSite(site, db, req));
      sendJson(res, 200, { sites });
      return true;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req, url);
      const { cleanTitle, slug } = slugFromTitle(body.title);
      const primaryColor = normalizePrimaryColor(body.primaryColor);
      const fontFamily = normalizeFontKey(body.fontFamily);
      const previousSlug = String(body.previousSlug || '').trim().toLowerCase();
      const now = new Date().toISOString();

      const site = await updateDb(async (db) => {
        const existing = previousSlug ? db.sites.find((entry) => entry.slug === previousSlug) : null;
        const conflict = db.sites.find((entry) => entry.slug === slug && entry.slug !== previousSlug);
        if (conflict) {
          throw createHttpError(409, 'That gallery title is already taken.');
        }

        if (previousSlug && !existing) {
          throw createHttpError(404, 'The gallery you are editing no longer exists.');
        }

        if (existing && previousSlug !== slug) {
          await renameSiteDirectory(previousSlug, slug);
          db.uploads.forEach((upload) => {
            if (upload.siteSlug === previousSlug) {
              upload.siteSlug = slug;
            }
          });
        }

        const nextSite = {
          slug,
          title: cleanTitle,
          primaryColor,
          fontFamily,
          createdAt: existing?.createdAt || now,
          updatedAt: now
        };

        if (existing) {
          const index = db.sites.findIndex((entry) => entry.slug === previousSlug);
          db.sites[index] = nextSite;
        } else {
          db.sites.push(nextSite);
        }

        return nextSite;
      });

      const db = await readDb();
      sendJson(res, 200, { site: serializeSite(site, db, req) });
      return true;
    }
  }

  const adminSiteMatch = pathname.match(/^\/api\/admin\/sites\/([a-z0-9-]+)$/);
  if (adminSiteMatch && req.method === 'DELETE') {
    if (!isAuthenticated(req)) {
      throw createHttpError(401, 'Authentication required.');
    }

    const slug = adminSiteMatch[1];
    await updateDb(async (db) => {
      const existing = db.sites.find((entry) => entry.slug === slug);
      if (!existing) {
        throw createHttpError(404, 'Gallery not found.');
      }
      db.sites = db.sites.filter((entry) => entry.slug !== slug);
      db.uploads = db.uploads.filter((entry) => entry.siteSlug !== slug);
      await fs.rm(siteDirectory(slug), { recursive: true, force: true });
    });

    sendJson(res, 200, { deleted: true });
    return true;
  }

  if (pathname === '/favicon.ico') {
    await serveFile(req, res, path.join(ROOT_DIR, 'assets', 'favicon.ico'));
    return true;
  }

  if (pathname === '/index.html') {
    redirect(res, '/');
    return true;
  }

  if (pathname === '/form.html') {
    redirect(res, '/form');
    return true;
  }

  if (pathname === '/404' || pathname === '/404.html') {
    await serve404(req, res);
    return true;
  }

  if (pathname === '/') {
    await serveFile(req, res, path.join(ROOT_DIR, 'index.html'));
    return true;
  }

  if (pathname === '/form') {
    await serveFile(req, res, path.join(ROOT_DIR, 'form.html'));
    return true;
  }

  if (pathname.startsWith('/media/')) {
    const relativePath = pathname.slice('/media/'.length);
    const filePath = safeJoin(UPLOADS_DIR, relativePath);
    await serveFile(req, res, filePath, 200, { 'Cache-Control': 'public, max-age=300' });
    return true;
  }

  if (
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/icons/') ||
    pathname.startsWith('/scripts/') ||
    pathname.startsWith('/styles/') ||
    pathname === '/manifest.json'
  ) {
    const filePath = safeJoin(ROOT_DIR, pathname.slice(1));
    await serveFile(req, res, filePath, 200, { 'Cache-Control': 'public, max-age=300' });
    return true;
  }

  if (/^\/[a-z0-9-]+$/.test(pathname)) {
    await serveFile(req, res, path.join(ROOT_DIR, 'home.html'));
    return true;
  }

  return false;
}

async function handleError(req, res, error) {
  const status = Number(error.status || 500);
  if (status >= 500) {
    console.error(error);
  }
  if (res.headersSent) {
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }
  if ((req.url || '').startsWith('/api/')) {
    sendJson(res, status, { error: error.message || 'Request failed.' });
    return;
  }
  if (status === 404) {
    await serve404(req, res);
    return;
  }
  const message = error.message || 'Internal server error.';
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shared Lens Error</title><style>body{font-family:system-ui,sans-serif;background:#f6f6f6;color:#111;display:grid;place-items:center;min-height:100vh;margin:0;padding:1rem}main{background:#fff;border:2px solid #111;border-radius:16px;box-shadow:0 10px 0 #111;padding:1.5rem;max-width:38rem}a{color:inherit}</style></head><body><main><h1>Something went wrong</h1><p>${message}</p><p><a href="/">Return home</a></p></main></body></html>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

async function start() {
  await ensureStorage();

  if (ADMIN_PASSWORD === 'change-me') {
    console.warn('Shared Lens is using the default ADMIN_PASSWORD. Set a real password before exposing it publicly.');
  }
  if (COOKIE_SECRET === 'change-me-too') {
    console.warn('Shared Lens is using the default COOKIE_SECRET. Set a random secret before exposing it publicly.');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const handled = await routeRequest(req, res);
      if (!handled && !res.writableEnded) {
        await serve404(req, res);
      }
    } catch (error) {
      await handleError(req, res, error);
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`Shared Lens listening on http://${HOST}:${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
