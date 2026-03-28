const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const archiver = require('archiver');
const express = require('express');
const exifr = require('exifr');
const multer = require('multer');
const QRCode = require('qrcode');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
const DATABASE_FILE = path.join(DATA_DIR, 'db.json');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const TMP_DIR = path.join(DATA_DIR, 'tmp');

const HOST = String(process.env.HOST || '0.0.0.0');
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || 'change-this-password');
const SESSION_SECRET = String(process.env.SESSION_SECRET || process.env.COOKIE_SECRET || 'change-this-session-secret');
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

const ADMIN_COOKIE = 'sharedlens_admin';
const UPLOADER_COOKIE = 'sharedlens_uploader';
const ADMIN_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const UPLOADER_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 2;

const DEFAULT_PRIMARY_COLOR = 'hsl(96 23.7% 54%)';
const DEFAULT_FONT_FAMILY = 'serif';
const TITLE_RE = /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/;
const VALID_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_SLUGS = new Set([
  'api',
  'assets',
  'icons',
  'js',
  'form',
  'home',
  '404'
]);

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

class DataStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { sites: [], uploads: [] };
    this.writeChain = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        sites: Array.isArray(parsed.sites) ? parsed.sites : [],
        uploads: Array.isArray(parsed.uploads) ? parsed.uploads : []
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = { sites: [], uploads: [] };
    }

    let mutated = false;
    if (!this.data.sites.some((site) => site.slug === 'demo')) {
      this.data.sites.push({
        id: crypto.randomUUID(),
        slug: 'demo',
        title: 'Wedding Photos',
        primaryColor: DEFAULT_PRIMARY_COLOR,
        fontFamily: DEFAULT_FONT_FAMILY,
        storageDir: 'demo',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        system: true
      });
      mutated = true;
    }

    if (mutated) {
      await this.persist();
    }
  }

  async persist() {
    const tempFile = `${this.filePath}.tmp`;
    const body = JSON.stringify(this.data, null, 2);
    await fs.writeFile(tempFile, `${body}\n`, 'utf8');
    await fs.rename(tempFile, this.filePath);
  }

  mutate(mutator) {
    const run = async () => {
      const result = await mutator(this.data);
      await this.persist();
      return result;
    };

    const operation = this.writeChain.then(run, run);
    this.writeChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  getSiteBySlug(slug) {
    return this.data.sites.find((site) => site.slug === slug) || null;
  }

  getLatestEditableSite() {
    return this.data.sites
      .filter((site) => !site.system)
      .slice()
      .sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt))[0] || null;
  }

  getUploadsForSite(siteId) {
    return this.data.uploads
      .filter((upload) => upload.siteId === siteId)
      .slice()
      .sort((left, right) => {
        const leftDate = new Date(left.takenAt || left.createdAt).getTime();
        const rightDate = new Date(right.takenAt || right.createdAt).getTime();
        return rightDate - leftDate;
      });
  }

  getUploadById(uploadId) {
    return this.data.uploads.find((upload) => upload.id === uploadId) || null;
  }
}

function asyncHandler(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function sanitizeFileName(fileName) {
  const baseName = path.basename(fileName || 'upload');
  const clean = baseName.replace(/[^\w.\- ]+/g, '_').trim();
  return clean || 'upload';
}

function normalizeCreditName(value) {
  return String(value || '').trim().slice(0, 80);
}

function normalizeFontFamily(value) {
  return value === 'sans' ? 'sans' : DEFAULT_FONT_FAMILY;
}

function normalizePrimaryColor(value) {
  const raw = String(value || '').trim();
  return /^hsl\(\s*[\d.]+\s+[\d.]+%\s+[\d.]+%\s*\)$/i.test(raw)
    ? raw
    : DEFAULT_PRIMARY_COLOR;
}

function toSlug(title) {
  const cleanTitle = String(title || '').trim().replace(/\s+/g, ' ');
  if (!TITLE_RE.test(cleanTitle)) {
    throw new HttpError(400, 'Title may only contain letters, numbers, and single spaces between words.');
  }
  const slug = cleanTitle.toLowerCase().replace(/ /g, '-');
  if (RESERVED_SLUGS.has(slug)) {
    throw new HttpError(400, 'That title is reserved. Please choose a different site name.');
  }
  return slug;
}

function hmac(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function createSignedToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${hmac(encoded)}`;
}

function verifySignedToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  const expected = hmac(encoded);
  const signatureBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (
    signatureBuffer.length !== expectedBuffer.length
    || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (payload.exp && Number(payload.exp) < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(request) {
  const header = request.headers.cookie || '';
  const cookies = {};
  for (const pair of header.split(';')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function serializeCookie(name, value, { maxAgeSeconds, httpOnly = true } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `SameSite=Lax`
  ];
  if (typeof maxAgeSeconds === 'number') {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  }
  if (httpOnly) parts.push('HttpOnly');
  if (COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie(response, name) {
  response.append('Set-Cookie', serializeCookie(name, '', { maxAgeSeconds: 0 }));
}

function parseDateValue(rawValue) {
  if (!rawValue) return null;
  const parsed = new Date(rawValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function extractTakenAt(filePath, mimeType, candidateTakenAt) {
  const fallbackDate = parseDateValue(candidateTakenAt) || new Date();
  if (!String(mimeType || '').startsWith('image/')) return fallbackDate;

  try {
    const exifData = await exifr.parse(filePath, [
      'DateTimeOriginal',
      'CreateDate',
      'ModifyDate',
      'GPSTimeStamp'
    ]) || {};
    const values = [
      exifData.DateTimeOriginal,
      exifData.CreateDate,
      exifData.ModifyDate,
      exifData.GPSTimeStamp
    ]
      .filter((value) => value instanceof Date)
      .map((value) => value.getTime());
    if (!values.length) return fallbackDate;
    return new Date(Math.min(...values));
  } catch {
    return fallbackDate;
  }
}

function siteStorageDirectory(site) {
  return path.join(MEDIA_DIR, site.storageDir);
}

function originalDirectory(site) {
  return path.join(siteStorageDirectory(site), 'originals');
}

function thumbnailDirectory(site) {
  return path.join(siteStorageDirectory(site), 'thumbs');
}

function originalPath(site, upload) {
  return path.join(originalDirectory(site), upload.storedName);
}

function thumbnailPath(site, upload) {
  if (!upload.thumbStoredName) return originalPath(site, upload);
  return path.join(thumbnailDirectory(site), upload.thumbStoredName);
}

function createArchiveName(createdAt, originalName) {
  const stamp = String(createdAt || new Date().toISOString()).replace(/[:.]/g, '-');
  return `${stamp}-${sanitizeFileName(originalName)}`;
}

function comparePassword(input) {
  const left = Buffer.from(String(input || ''), 'utf8');
  const right = Buffer.from(ADMIN_PASSWORD, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function siteUrlForRequest(request, slug) {
  return `${request.protocol}://${request.get('host')}/${slug}`;
}

function serializeSite(site, request) {
  return {
    slug: site.slug,
    title: site.title,
    primaryColor: site.primaryColor,
    fontFamily: site.fontFamily,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
    siteUrl: siteUrlForRequest(request, site.slug)
  };
}

function serializeUpload(site, upload, request) {
  return {
    id: upload.id,
    originalName: upload.originalName,
    creditName: upload.creditName || '',
    createdAt: upload.createdAt,
    takenAt: upload.takenAt,
    isVideo: String(upload.mimeType || '').startsWith('video/'),
    isMine: request.uploaderId === upload.uploaderId,
    mediaUrl: `/media/${upload.id}/original`,
    thumbnailUrl: `/media/${upload.id}/thumb`
  };
}

async function ensureDirectories() {
  await Promise.all([
    fs.mkdir(DATA_DIR, { recursive: true }),
    fs.mkdir(MEDIA_DIR, { recursive: true }),
    fs.mkdir(TMP_DIR, { recursive: true })
  ]);
}

async function cleanupFiles(fileList) {
  await Promise.allSettled(
    fileList
      .filter(Boolean)
      .map((filePath) => fs.rm(filePath, { force: true }))
  );
}

const store = new DataStore(DATABASE_FILE);

const uploadMiddleware = multer({
  storage: multer.diskStorage({
    destination(_request, _file, callback) {
      callback(null, TMP_DIR);
    },
    filename(_request, file, callback) {
      callback(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname || '')}`);
    }
  }),
  limits: {
    files: 2,
    fileSize: 1024 * 1024 * 1024
  }
}).fields([
  { name: 'file', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 }
]);

async function main() {
  await ensureDirectories();
  await store.init();

  const app = express();
  app.set('trust proxy', true);

  app.use(express.json({ limit: '2mb' }));
  app.use((request, _response, next) => {
    request.cookies = parseCookies(request);
    request.adminSession = verifySignedToken(request.cookies[ADMIN_COOKIE]);
    request.isAdmin = Boolean(request.adminSession && request.adminSession.role === 'admin');
    request.uploaderSession = verifySignedToken(request.cookies[UPLOADER_COOKIE]);
    request.uploaderId = request.uploaderSession?.uploaderId || null;
    next();
  });

  function ensureUploaderCookie(request, response, next) {
    if (!request.uploaderId) {
      request.uploaderId = crypto.randomUUID();
      response.append(
        'Set-Cookie',
        serializeCookie(
          UPLOADER_COOKIE,
          createSignedToken({ uploaderId: request.uploaderId }),
          { maxAgeSeconds: UPLOADER_COOKIE_MAX_AGE_SECONDS }
        )
      );
    }
    next();
  }

  function requireAdmin(request, _response, next) {
    if (!request.isAdmin) {
      next(new HttpError(401, 'Please sign in with the admin password first.'));
      return;
    }
    next();
  }

  app.post('/api/auth/login', asyncHandler(async (request, response) => {
    const password = String(request.body?.password || '');
    if (!comparePassword(password)) {
      throw new HttpError(401, 'The password was incorrect.');
    }

    const token = createSignedToken({
      role: 'admin',
      exp: Date.now() + (ADMIN_COOKIE_MAX_AGE_SECONDS * 1000)
    });
    response.append(
      'Set-Cookie',
      serializeCookie(ADMIN_COOKIE, token, { maxAgeSeconds: ADMIN_COOKIE_MAX_AGE_SECONDS })
    );
    response.json({ isAdmin: true });
  }));

  app.post('/api/auth/logout', asyncHandler(async (_request, response) => {
    clearCookie(response, ADMIN_COOKIE);
    response.status(204).end();
  }));

  app.get('/api/auth/session', asyncHandler(async (request, response) => {
    response.json({ isAdmin: request.isAdmin });
  }));

  app.get('/api/admin/sites/current', requireAdmin, asyncHandler(async (request, response) => {
    const slug = String(request.query.slug || '').trim().toLowerCase();
    if (slug) {
      const site = store.getSiteBySlug(slug);
      if (!site || site.system) {
        throw new HttpError(404, `No site named "${slug}" was found.`);
      }
      response.json({ site: serializeSite(site, request) });
      return;
    }

    const latest = store.getLatestEditableSite();
    response.json({ site: latest ? serializeSite(latest, request) : null });
  }));

  app.post('/api/admin/sites', requireAdmin, asyncHandler(async (request, response) => {
    const title = String(request.body?.title || '').trim().replace(/\s+/g, ' ');
    const primaryColor = normalizePrimaryColor(request.body?.primaryColor);
    const fontFamily = normalizeFontFamily(request.body?.fontFamily);
    const existingSlug = String(request.body?.existingSlug || '').trim().toLowerCase();
    const slug = toSlug(title);
    const now = new Date().toISOString();

    const site = await store.mutate(async (data) => {
      const current = existingSlug ? data.sites.find((entry) => entry.slug === existingSlug) : null;
      if (existingSlug && (!current || current.system)) {
        throw new HttpError(404, 'That site no longer exists.');
      }

      const conflict = data.sites.find((entry) => entry.slug === slug && entry.id !== current?.id);
      if (conflict) {
        throw new HttpError(409, 'That title is taken. Try another.');
      }

      if (current) {
        current.slug = slug;
        current.title = title;
        current.primaryColor = primaryColor;
        current.fontFamily = fontFamily;
        current.updatedAt = now;
        return current;
      }

      const created = {
        id: crypto.randomUUID(),
        slug,
        title,
        primaryColor,
        fontFamily,
        storageDir: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        system: false
      };
      data.sites.push(created);
      return created;
    });

    await Promise.all([
      fs.mkdir(originalDirectory(site), { recursive: true }),
      fs.mkdir(thumbnailDirectory(site), { recursive: true })
    ]);

    response.json({ site: serializeSite(site, request) });
  }));

  app.delete('/api/admin/sites/:slug', requireAdmin, asyncHandler(async (request, response) => {
    const slug = String(request.params.slug || '').trim().toLowerCase();
    const site = store.getSiteBySlug(slug);
    if (!site || site.system) {
      throw new HttpError(404, 'That site no longer exists.');
    }

    const uploads = store.getUploadsForSite(site.id);
    await store.mutate(async (data) => {
      data.sites = data.sites.filter((entry) => entry.id !== site.id);
      data.uploads = data.uploads.filter((upload) => upload.siteId !== site.id);
    });

    await fs.rm(siteStorageDirectory(site), { recursive: true, force: true });
    await cleanupFiles(
      uploads.flatMap((upload) => [
        originalPath(site, upload),
        upload.thumbStoredName ? thumbnailPath(site, upload) : null
      ])
    );

    response.status(204).end();
  }));

  app.get('/api/sites/:slug', ensureUploaderCookie, asyncHandler(async (request, response) => {
    const slug = String(request.params.slug || '').trim().toLowerCase();
    if (!VALID_SLUG_RE.test(slug)) {
      throw new HttpError(404, 'Site not found.');
    }
    const site = store.getSiteBySlug(slug);
    if (!site) {
      throw new HttpError(404, 'Site not found.');
    }
    response.json({ site: serializeSite(site, request) });
  }));

  app.get('/api/sites/:slug/uploads', ensureUploaderCookie, asyncHandler(async (request, response) => {
    const slug = String(request.params.slug || '').trim().toLowerCase();
    const site = store.getSiteBySlug(slug);
    if (!site) {
      throw new HttpError(404, 'Site not found.');
    }

    const uploads = store.getUploadsForSite(site.id).map((upload) => serializeUpload(site, upload, request));
    response.json({ uploads });
  }));

  app.post(
    '/api/sites/:slug/uploads',
    ensureUploaderCookie,
    (request, response, next) => uploadMiddleware(request, response, (error) => (error ? next(error) : next())),
    asyncHandler(async (request, response) => {
      const slug = String(request.params.slug || '').trim().toLowerCase();
      const site = store.getSiteBySlug(slug);
      if (!site) {
        throw new HttpError(404, 'Site not found.');
      }

      const originalUpload = request.files?.file?.[0];
      const thumbnailUpload = request.files?.thumbnail?.[0];
      if (!originalUpload) {
        throw new HttpError(400, 'A file upload is required.');
      }

      await Promise.all([
        fs.mkdir(originalDirectory(site), { recursive: true }),
        fs.mkdir(thumbnailDirectory(site), { recursive: true })
      ]);

      const uploadId = crypto.randomUUID();
      const originalExt = path.extname(originalUpload.originalname || '') || '';
      const originalStoredName = `${uploadId}${originalExt.toLowerCase()}`;
      const thumbStoredName = thumbnailUpload ? `${uploadId}.jpg` : null;
      const createdAt = new Date().toISOString();
      const takenAt = (await extractTakenAt(
        originalUpload.path,
        originalUpload.mimetype,
        request.body?.takenAt
      )).toISOString();

      const finalOriginalPath = path.join(originalDirectory(site), originalStoredName);
      const finalThumbPath = thumbStoredName ? path.join(thumbnailDirectory(site), thumbStoredName) : null;

      try {
        await fs.rename(originalUpload.path, finalOriginalPath);
        if (thumbnailUpload && finalThumbPath) {
          await fs.rename(thumbnailUpload.path, finalThumbPath);
        }

        const uploadRecord = await store.mutate(async (data) => {
          const record = {
            id: uploadId,
            siteId: site.id,
            originalName: sanitizeFileName(originalUpload.originalname),
            storedName: originalStoredName,
            thumbStoredName,
            mimeType: originalUpload.mimetype || 'application/octet-stream',
            size: originalUpload.size || 0,
            creditName: normalizeCreditName(request.body?.creditName),
            createdAt,
            takenAt,
            uploaderId: request.uploaderId,
            archiveName: createArchiveName(createdAt, originalUpload.originalname)
          };
          data.uploads.push(record);
          return record;
        });

        response.status(201).json({ upload: serializeUpload(site, uploadRecord, request) });
      } catch (error) {
        await cleanupFiles([
          originalUpload.path,
          thumbnailUpload?.path,
          finalOriginalPath,
          finalThumbPath
        ]);
        throw error;
      }
    })
  );

  app.post('/api/sites/:slug/credit', ensureUploaderCookie, asyncHandler(async (request, response) => {
    const slug = String(request.params.slug || '').trim().toLowerCase();
    const site = store.getSiteBySlug(slug);
    if (!site) {
      throw new HttpError(404, 'Site not found.');
    }

    const creditName = normalizeCreditName(request.body?.creditName);
    let updated = 0;
    await store.mutate(async (data) => {
      for (const upload of data.uploads) {
        if (upload.siteId === site.id && upload.uploaderId === request.uploaderId) {
          upload.creditName = creditName;
          updated += 1;
        }
      }
    });

    response.json({ updated, creditName });
  }));

  app.delete('/api/sites/:slug/uploads/:uploadId', ensureUploaderCookie, asyncHandler(async (request, response) => {
    const slug = String(request.params.slug || '').trim().toLowerCase();
    const uploadId = String(request.params.uploadId || '').trim();
    const site = store.getSiteBySlug(slug);
    if (!site) {
      throw new HttpError(404, 'Site not found.');
    }

    const upload = store.getUploadById(uploadId);
    if (!upload || upload.siteId !== site.id) {
      throw new HttpError(404, 'That upload no longer exists.');
    }
    if (upload.uploaderId !== request.uploaderId) {
      throw new HttpError(403, 'You can only delete files that were uploaded from this browser.');
    }

    await store.mutate(async (data) => {
      data.uploads = data.uploads.filter((entry) => entry.id !== upload.id);
    });

    await cleanupFiles([
      originalPath(site, upload),
      upload.thumbStoredName ? thumbnailPath(site, upload) : null
    ]);

    response.status(204).end();
  }));

  app.get('/api/sites/:slug/download', asyncHandler(async (request, response) => {
    const slug = String(request.params.slug || '').trim().toLowerCase();
    const site = store.getSiteBySlug(slug);
    if (!site) {
      throw new HttpError(404, 'Site not found.');
    }

    const uploads = store.getUploadsForSite(site.id);
    if (!uploads.length) {
      throw new HttpError(404, 'No photos or videos are available yet.');
    }

    const safeName = (site.slug || 'gallery').replace(/[^a-z0-9-]+/gi, '-');
    const filename = `${safeName}-originals-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;

    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 0 } });
    archive.on('error', (error) => {
      if (!response.headersSent) {
        response.status(500).json({ error: error.message });
        return;
      }
      response.destroy(error);
    });
    archive.pipe(response);

    for (const upload of uploads) {
      archive.file(originalPath(site, upload), { name: upload.archiveName || createArchiveName(upload.createdAt, upload.originalName) });
    }

    await archive.finalize();
  }));

  app.get('/api/sites/:slug/qr', asyncHandler(async (request, response) => {
    const slug = String(request.params.slug || '').trim().toLowerCase();
    const site = store.getSiteBySlug(slug);
    if (!site) {
      throw new HttpError(404, 'Site not found.');
    }

    const qrBuffer = await QRCode.toBuffer(siteUrlForRequest(request, site.slug), {
      type: 'png',
      width: 512,
      margin: 1
    });

    if (request.query.download === '1') {
      response.setHeader('Content-Disposition', `attachment; filename="${site.slug}-qr.png"`);
    }
    response.type('png').send(qrBuffer);
  }));

  app.get('/media/:uploadId/original', asyncHandler(async (request, response) => {
    const upload = store.getUploadById(String(request.params.uploadId || '').trim());
    if (!upload) {
      throw new HttpError(404, 'File not found.');
    }
    const site = store.data.sites.find((entry) => entry.id === upload.siteId);
    if (!site) {
      throw new HttpError(404, 'File not found.');
    }
    response.type(upload.mimeType || 'application/octet-stream');
    response.sendFile(originalPath(site, upload));
  }));

  app.get('/media/:uploadId/thumb', asyncHandler(async (request, response) => {
    const upload = store.getUploadById(String(request.params.uploadId || '').trim());
    if (!upload) {
      throw new HttpError(404, 'File not found.');
    }
    const site = store.data.sites.find((entry) => entry.id === upload.siteId);
    if (!site) {
      throw new HttpError(404, 'File not found.');
    }
    response.sendFile(thumbnailPath(site, upload));
  }));

  app.use(express.static(PUBLIC_DIR, { index: false }));

  app.get('/', (_request, response) => {
    response.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.get('/form', (_request, response) => {
    response.sendFile(path.join(PUBLIC_DIR, 'form.html'));
  });

  app.get('/home', (_request, response) => {
    response.sendFile(path.join(PUBLIC_DIR, 'home.html'));
  });

  app.get('/:slug', (request, response, next) => {
    const slug = String(request.params.slug || '').trim().toLowerCase();
    if (!VALID_SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) {
      next();
      return;
    }
    response.sendFile(path.join(PUBLIC_DIR, 'home.html'));
  });

  app.use((request, response) => {
    response.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
  });

  app.use((error, _request, response, _next) => {
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'That file is too large for this server.'
        : error.message;
      response.status(400).json({ error: message });
      return;
    }

    const statusCode = error.statusCode || 500;
    const message = statusCode >= 500 ? 'Internal server error.' : error.message;
    if (statusCode >= 500) {
      console.error(error);
    }
    response.status(statusCode).json({ error: message });
  });

  if (ADMIN_PASSWORD === 'change-this-password') {
    console.warn('ADMIN_PASSWORD is using the default placeholder. Set a real password before exposing this server.');
  }
  if (SESSION_SECRET === 'change-this-session-secret') {
    console.warn('SESSION_SECRET is using the default placeholder. Set a real secret before exposing this server.');
  }

  app.listen(PORT, HOST, () => {
    console.log(`Shared Lens listening on http://${HOST}:${PORT}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
