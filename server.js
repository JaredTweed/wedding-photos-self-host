const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

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
const SESSION_SECRET = String(process.env.SESSION_SECRET || process.env.COOKIE_SECRET || 'change-this-session-secret');
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
const RUNNING_IN_CONTAINER = fsSync.existsSync('/.dockerenv');

const SESSION_COOKIE = 'sharedlens_session';
const LEGACY_ADMIN_COOKIE = 'sharedlens_admin';
const UPLOADER_COOKIE = 'sharedlens_uploader';
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const UPLOADER_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 2;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 200;
const USERNAME_MAX_LENGTH = 32;
const SCRYPT_KEYLEN = 64;
const MEDIA_CACHE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const ASSET_CACHE_MAX_AGE_SECONDS = 60 * 60;
const MAX_QR_CACHE_ENTRIES = 128;

const DEFAULT_PRIMARY_COLOR = 'hsl(96 23.7% 54%)';
const DEFAULT_FONT_FAMILY = 'serif';
const TITLE_RE = /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/;
const VALID_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const USERNAME_RE = /^[A-Za-z0-9._-]+$/;
const RESERVED_SLUGS = new Set([
  'api',
  'assets',
  'icons',
  'js',
  'form',
  'home',
  'users',
  '404'
]);

const scryptAsync = promisify(crypto.scrypt);

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
    this.data = { users: [], sites: [], uploads: [] };
    this.writeChain = Promise.resolve();
    this.siteById = new Map();
    this.siteBySlug = new Map();
    this.userById = new Map();
    this.userByUsernameKey = new Map();
    this.uploadById = new Map();
    this.uploadsBySiteId = new Map();
    this.uploadsBySiteUploaderKey = new Map();
    this.latestEditableSiteByOwner = new Map();
    this.storageUsageByUserId = new Map();
    this.totalAppBytesUsed = 0;
    this.unassignedBytesUsed = 0;
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        sites: Array.isArray(parsed.sites) ? parsed.sites : [],
        uploads: Array.isArray(parsed.uploads) ? parsed.uploads : []
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = { users: [], sites: [], uploads: [] };
    }

    let mutated = false;
    for (const user of this.data.users) {
      if (!user.usernameKey && user.username) {
        user.usernameKey = String(user.username).toLowerCase();
        mutated = true;
      }
      if (!user.createdAt) {
        user.createdAt = new Date().toISOString();
        mutated = true;
      }
    }

    for (const site of this.data.sites) {
      if (!Object.prototype.hasOwnProperty.call(site, 'ownerUserId')) {
        site.ownerUserId = null;
        mutated = true;
      }
    }

    for (const upload of this.data.uploads) {
      if (typeof upload.size !== 'number') {
        upload.size = Number(upload.size || 0);
        mutated = true;
      }
    }

    const legacyDemoSites = this.data.sites.filter((site) => site.slug === 'demo');
    if (legacyDemoSites.length) {
      const legacyDemoIds = new Set(legacyDemoSites.map((site) => site.id));
      const legacyDemoStorageDirs = legacyDemoSites
        .map((site) => site.storageDir)
        .filter(Boolean);
      this.data.sites = this.data.sites.filter((site) => site.slug !== 'demo');
      this.data.uploads = this.data.uploads.filter((upload) => !legacyDemoIds.has(upload.siteId));
      await Promise.allSettled(
        legacyDemoStorageDirs.map((storageDir) => (
          fs.rm(path.join(MEDIA_DIR, storageDir), { recursive: true, force: true })
        ))
      );
      mutated = true;
    }

    this.rebuildIndexes();

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
      this.rebuildIndexes();
      await this.persist();
      return result;
    };

    const operation = this.writeChain.then(run, run);
    this.writeChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  rebuildIndexes() {
    this.siteById.clear();
    this.siteBySlug.clear();
    this.userById.clear();
    this.userByUsernameKey.clear();
    this.uploadById.clear();
    this.uploadsBySiteId.clear();
    this.uploadsBySiteUploaderKey.clear();
    this.latestEditableSiteByOwner.clear();
    this.storageUsageByUserId.clear();
    this.totalAppBytesUsed = 0;
    this.unassignedBytesUsed = 0;

    for (const user of this.data.users) {
      this.userById.set(user.id, user);
      this.userByUsernameKey.set(user.usernameKey, user);
      this.storageUsageByUserId.set(user.id, {
        id: user.id,
        username: user.username,
        bytesUsed: 0,
        uploadCount: 0,
        siteCount: 0
      });
    }

    for (const site of this.data.sites) {
      this.siteById.set(site.id, site);
      this.siteBySlug.set(site.slug, site);

      if (!site.system && site.ownerUserId) {
        const storageRow = this.storageUsageByUserId.get(site.ownerUserId);
        if (storageRow) {
          storageRow.siteCount += 1;
        }

        const previousLatest = this.latestEditableSiteByOwner.get(site.ownerUserId);
        if (!previousLatest || new Date(site.updatedAt).getTime() > new Date(previousLatest.updatedAt).getTime()) {
          this.latestEditableSiteByOwner.set(site.ownerUserId, site);
        }
      }
    }

    for (const upload of this.data.uploads) {
      this.uploadById.set(upload.id, upload);

      const uploadsForSite = this.uploadsBySiteId.get(upload.siteId) || [];
      uploadsForSite.push(upload);
      this.uploadsBySiteId.set(upload.siteId, uploadsForSite);

      const uploaderKey = siteUploaderKey(upload.siteId, upload.uploaderId);
      const uploadsForUploader = this.uploadsBySiteUploaderKey.get(uploaderKey) || [];
      uploadsForUploader.push(upload);
      this.uploadsBySiteUploaderKey.set(uploaderKey, uploadsForUploader);

      const size = Number(upload.size || 0);
      this.totalAppBytesUsed += size;

      const ownerUserId = this.siteById.get(upload.siteId)?.ownerUserId;
      const storageRow = ownerUserId ? this.storageUsageByUserId.get(ownerUserId) : null;
      if (!storageRow) {
        this.unassignedBytesUsed += size;
        continue;
      }

      storageRow.bytesUsed += size;
      storageRow.uploadCount += 1;
    }

    for (const uploads of this.uploadsBySiteId.values()) {
      uploads.sort((left, right) => uploadSortTime(right) - uploadSortTime(left));
    }
    for (const uploads of this.uploadsBySiteUploaderKey.values()) {
      uploads.sort((left, right) => uploadSortTime(right) - uploadSortTime(left));
    }
  }

  getSiteBySlug(slug) {
    return this.siteBySlug.get(slug) || null;
  }

  getSiteById(siteId) {
    return this.siteById.get(siteId) || null;
  }

  getLatestEditableSite(ownerUserId) {
    return this.latestEditableSiteByOwner.get(ownerUserId) || null;
  }

  getOwnedSiteBySlug(ownerUserId, slug) {
    const site = this.siteBySlug.get(slug) || null;
    if (!site || site.system || site.ownerUserId !== ownerUserId) return null;
    return site;
  }

  getUserById(userId) {
    return this.userById.get(userId) || null;
  }

  getUserByUsernameKey(usernameKey) {
    return this.userByUsernameKey.get(usernameKey) || null;
  }

  getUploadsForSite(siteId) {
    return (this.uploadsBySiteId.get(siteId) || []).slice();
  }

  getUploadsForSiteAndUploader(siteId, uploaderId) {
    return (this.uploadsBySiteUploaderKey.get(siteUploaderKey(siteId, uploaderId)) || []).slice();
  }

  getUploadById(uploadId) {
    return this.uploadById.get(uploadId) || null;
  }

  getStorageUsageRows() {
    return Array.from(this.storageUsageByUserId.values())
      .map((entry) => ({ ...entry }))
      .sort((left, right) => (
        right.bytesUsed - left.bytesUsed
        || left.username.localeCompare(right.username, undefined, { sensitivity: 'base' })
      ));
  }
}

function uploadSortTime(upload) {
  return Date.parse(upload.takenAt || upload.createdAt || 0) || 0;
}

function siteUploaderKey(siteId, uploaderId) {
  return `${siteId}:${uploaderId || ''}`;
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

function normalizeUsername(value) {
  const username = String(value || '').trim();
  if (!username) {
    throw new HttpError(400, 'A username is required.');
  }
  if (username.length < 3 || username.length > USERNAME_MAX_LENGTH) {
    throw new HttpError(400, `Username must be between 3 and ${USERNAME_MAX_LENGTH} characters.`);
  }
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, 'Username may only contain letters, numbers, dots, underscores, and hyphens.');
  }
  return username;
}

function usernameKeyFor(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePassword(value) {
  const password = String(value || '');
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new HttpError(400, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new HttpError(400, `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  }
  return password;
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

function serializeUser(user) {
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt
  };
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

function setSessionCookie(response, userId) {
  const token = createSignedToken({
    userId,
    exp: Date.now() + (SESSION_COOKIE_MAX_AGE_SECONDS * 1000)
  });
  response.append(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds: SESSION_COOKIE_MAX_AGE_SECONDS })
  );
  clearCookie(response, LEGACY_ADMIN_COOKIE);
}

async function hashPassword(password) {
  const passwordSalt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, passwordSalt, SCRYPT_KEYLEN);
  return {
    passwordSalt,
    passwordHash: Buffer.from(derived).toString('hex')
  };
}

async function verifyPassword(password, user) {
  if (!user?.passwordSalt || !user?.passwordHash) return false;
  const derived = Buffer.from(await scryptAsync(String(password || ''), user.passwordSalt, SCRYPT_KEYLEN));
  const expected = Buffer.from(String(user.passwordHash), 'hex');
  if (!expected.length || expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(derived, expected);
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

function serializeSession(request) {
  return {
    isAuthenticated: Boolean(request.user),
    user: request.user ? serializeUser(request.user) : null
  };
}

async function readDiskTotals() {
  if (typeof fs.statfs !== 'function') {
    return {
      totalBytes: null,
      availableBytes: null
    };
  }

  try {
    const stats = await fs.statfs(DATA_DIR);
    return {
      totalBytes: Number(stats.blocks || 0) * Number(stats.bsize || 0),
      availableBytes: Number(stats.bavail || 0) * Number(stats.bsize || 0)
    };
  } catch {
    return {
      totalBytes: null,
      availableBytes: null
    };
  }
}

async function buildStorageUsageReport(store) {
  const users = store.getStorageUsageRows();
  const diskTotals = await readDiskTotals();
  const storageBytesRemaining = diskTotals.availableBytes;
  const storageBytesTotal = storageBytesRemaining == null
    ? null
    : store.totalAppBytesUsed + storageBytesRemaining;

  return {
    users,
    totals: {
      appBytesUsed: store.totalAppBytesUsed,
      storageBytesTotal,
      storageBytesRemaining,
      diskBytesTotal: diskTotals.totalBytes,
      diskBytesAvailable: diskTotals.availableBytes,
      unassignedBytesUsed: store.unassignedBytesUsed
    }
  };
}

let cachedPreferredLanAddress = null;

function isPrivateIpv4(address) {
  return /^10\./.test(address)
    || /^192\.168\./.test(address)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(address);
}

function isVirtualInterfaceName(name) {
  return /^(lo|docker\d*|br-|veth|cni|flannel|virbr|zt|tailscale|tun|tap)/i.test(name);
}

function isContainerOnlyInterfaceName(name) {
  return /^eth\d+$/i.test(name);
}

function preferredLanAddress() {
  if (cachedPreferredLanAddress !== null) return cachedPreferredLanAddress;

  const interfaces = os.networkInterfaces();
  let fallbackIpv4 = '';
  let fallbackIpv6 = '';

  for (const [name, entries] of Object.entries(interfaces)) {
    if (isVirtualInterfaceName(name)) continue;
    if (RUNNING_IN_CONTAINER && isContainerOnlyInterfaceName(name)) continue;

    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      if (entry.family === 'IPv4') {
        if (isPrivateIpv4(entry.address)) {
          cachedPreferredLanAddress = entry.address;
          return cachedPreferredLanAddress;
        }
        if (!fallbackIpv4) fallbackIpv4 = entry.address;
      } else if (entry.family === 'IPv6' && !fallbackIpv6) {
        fallbackIpv6 = entry.address;
      }
    }
  }

  if (RUNNING_IN_CONTAINER) {
    cachedPreferredLanAddress = '';
    return cachedPreferredLanAddress;
  }

  cachedPreferredLanAddress = fallbackIpv4 || fallbackIpv6 || '';
  return cachedPreferredLanAddress;
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '0.0.0.0';
}

function siteUrlForRequest(request, slug) {
  if (PUBLIC_BASE_URL) {
    return `${PUBLIC_BASE_URL}/${slug}`;
  }

  const baseUrl = new URL(`${request.protocol}://${request.get('host')}`);
  if (isLoopbackHostname(baseUrl.hostname)) {
    const lanAddress = preferredLanAddress();
    if (lanAddress) {
      baseUrl.hostname = lanAddress;
    }
  }

  return `${baseUrl.origin}/${slug}`;
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

const ensuredStorageDirs = new Set();
const qrCodeCache = new Map();

async function ensureSiteDirectories(site) {
  if (!site?.storageDir || ensuredStorageDirs.has(site.storageDir)) return;
  await Promise.all([
    fs.mkdir(originalDirectory(site), { recursive: true }),
    fs.mkdir(thumbnailDirectory(site), { recursive: true })
  ]);
  ensuredStorageDirs.add(site.storageDir);
}

function rememberQrCode(url, buffer) {
  if (qrCodeCache.has(url)) {
    qrCodeCache.delete(url);
  }
  qrCodeCache.set(url, buffer);
  if (qrCodeCache.size > MAX_QR_CACHE_ENTRIES) {
    const oldestKey = qrCodeCache.keys().next().value;
    if (oldestKey) {
      qrCodeCache.delete(oldestKey);
    }
  }
}

function getCachedQrCode(url) {
  const cached = qrCodeCache.get(url);
  if (!cached) return null;
  qrCodeCache.delete(url);
  qrCodeCache.set(url, cached);
  return cached;
}

function setImmutableCacheHeaders(response) {
  response.setHeader('Cache-Control', `public, max-age=${MEDIA_CACHE_MAX_AGE_SECONDS}, immutable`);
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
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '2mb' }));
  app.use((request, _response, next) => {
    request.cookies = parseCookies(request);
    request.userSession = verifySignedToken(request.cookies[SESSION_COOKIE]);
    request.user = store.getUserById(request.userSession?.userId || '');
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

  function requireUser(request, _response, next) {
    if (!request.user) {
      next(new HttpError(401, 'Please sign in first.'));
      return;
    }
    next();
  }

  app.post('/api/auth/login', asyncHandler(async (request, response) => {
    const username = normalizeUsername(request.body?.username);
    const password = String(request.body?.password || '');
    const user = store.getUserByUsernameKey(usernameKeyFor(username));
    if (!user || !(await verifyPassword(password, user))) {
      throw new HttpError(401, 'The username or password was incorrect.');
    }

    setSessionCookie(response, user.id);
    response.json({
      isAuthenticated: true,
      user: serializeUser(user)
    });
  }));

  app.post('/api/auth/register', asyncHandler(async (request, response) => {
    const username = normalizeUsername(request.body?.username);
    const password = normalizePassword(request.body?.password);
    const normalizedUsernameKey = usernameKeyFor(username);

    const user = await store.mutate(async (data) => {
      if (data.users.some((entry) => entry.usernameKey === normalizedUsernameKey)) {
        throw new HttpError(409, 'That username is already taken.');
      }

      const createdAt = new Date().toISOString();
      const created = {
        id: crypto.randomUUID(),
        username,
        usernameKey: normalizedUsernameKey,
        createdAt,
        ...(await hashPassword(password))
      };
      const shouldClaimLegacySites = data.users.length === 0;
      data.users.push(created);

      if (shouldClaimLegacySites) {
        for (const site of data.sites) {
          if (!site.system && !site.ownerUserId) {
            site.ownerUserId = created.id;
          }
        }
      }

      return created;
    });

    setSessionCookie(response, user.id);
    response.status(201).json({
      isAuthenticated: true,
      user: serializeUser(user)
    });
  }));

  app.post('/api/auth/logout', asyncHandler(async (_request, response) => {
    clearCookie(response, SESSION_COOKIE);
    clearCookie(response, LEGACY_ADMIN_COOKIE);
    response.status(204).end();
  }));

  app.delete('/api/auth/account', requireUser, asyncHandler(async (request, response) => {
    if (store.getLatestEditableSite(request.user.id)) {
      throw new HttpError(409, 'Delete your site before deleting your account.');
    }

    await store.mutate(async (data) => {
      data.users = data.users.filter((entry) => entry.id !== request.user.id);
    });

    clearCookie(response, SESSION_COOKIE);
    clearCookie(response, LEGACY_ADMIN_COOKIE);
    response.status(204).end();
  }));

  app.get('/api/auth/session', asyncHandler(async (request, response) => {
    response.json(serializeSession(request));
  }));

  app.get('/api/account/sites/current', requireUser, asyncHandler(async (request, response) => {
    const slug = String(request.query.slug || '').trim().toLowerCase();
    if (slug) {
      const site = store.getOwnedSiteBySlug(request.user.id, slug);
      if (!site) {
        throw new HttpError(404, `No site named "${slug}" was found.`);
      }
      response.json({ site: serializeSite(site, request) });
      return;
    }

    const latest = store.getLatestEditableSite(request.user.id);
    response.json({ site: latest ? serializeSite(latest, request) : null });
  }));

  app.post('/api/account/sites', requireUser, asyncHandler(async (request, response) => {
    const title = String(request.body?.title || '').trim().replace(/\s+/g, ' ');
    const primaryColor = normalizePrimaryColor(request.body?.primaryColor);
    const fontFamily = normalizeFontFamily(request.body?.fontFamily);
    const existingSlug = String(request.body?.existingSlug || '').trim().toLowerCase();
    const slug = toSlug(title);
    const now = new Date().toISOString();

    const site = await store.mutate(async (data) => {
      const current = existingSlug
        ? data.sites.find((entry) => (
          entry.slug === existingSlug
          && !entry.system
          && entry.ownerUserId === request.user.id
        ))
        : null;
      if (existingSlug && !current) {
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
        ownerUserId: request.user.id,
        system: false
      };
      data.sites.push(created);
      return created;
    });

    await ensureSiteDirectories(site);

    response.json({ site: serializeSite(site, request) });
  }));

  app.delete('/api/account/sites/:slug', requireUser, asyncHandler(async (request, response) => {
    const slug = String(request.params.slug || '').trim().toLowerCase();
    const site = store.getOwnedSiteBySlug(request.user.id, slug);
    if (!site) {
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
    ensuredStorageDirs.delete(site.storageDir);

    response.status(204).end();
  }));

  app.get('/api/users/storage', requireUser, asyncHandler(async (_request, response) => {
    response.json(await buildStorageUsageReport(store));
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

      await ensureSiteDirectories(site);

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
    await store.mutate(async () => {
      for (const upload of store.getUploadsForSiteAndUploader(site.id, request.uploaderId)) {
        upload.creditName = creditName;
        updated += 1;
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

    const siteUrl = siteUrlForRequest(request, site.slug);
    let qrBuffer = getCachedQrCode(siteUrl);
    if (!qrBuffer) {
      qrBuffer = await QRCode.toBuffer(siteUrl, {
        type: 'png',
        width: 512,
        margin: 1
      });
      rememberQrCode(siteUrl, qrBuffer);
    }

    if (request.query.download === '1') {
      response.setHeader('Content-Disposition', `attachment; filename="${site.slug}-qr.png"`);
    }
    response.setHeader('Cache-Control', 'no-store');
    response.type('png').send(qrBuffer);
  }));

  app.get('/media/:uploadId/original', asyncHandler(async (request, response) => {
    const upload = store.getUploadById(String(request.params.uploadId || '').trim());
    if (!upload) {
      throw new HttpError(404, 'File not found.');
    }
    const site = store.getSiteById(upload.siteId);
    if (!site) {
      throw new HttpError(404, 'File not found.');
    }
    response.type(upload.mimeType || 'application/octet-stream');
    setImmutableCacheHeaders(response);
    response.sendFile(originalPath(site, upload));
  }));

  app.get('/media/:uploadId/thumb', asyncHandler(async (request, response) => {
    const upload = store.getUploadById(String(request.params.uploadId || '').trim());
    if (!upload) {
      throw new HttpError(404, 'File not found.');
    }
    const site = store.getSiteById(upload.siteId);
    if (!site) {
      throw new HttpError(404, 'File not found.');
    }
    setImmutableCacheHeaders(response);
    response.sendFile(thumbnailPath(site, upload));
  }));

  app.use(express.static(PUBLIC_DIR, {
    index: false,
    etag: true,
    lastModified: true,
    setHeaders(response, filePath) {
      const relativePath = path.relative(PUBLIC_DIR, filePath);
      if (relativePath.startsWith(`assets${path.sep}`)) {
        response.setHeader('Cache-Control', `public, max-age=${MEDIA_CACHE_MAX_AGE_SECONDS}, immutable`);
        return;
      }
      if (path.extname(filePath) === '.js') {
        response.setHeader('Cache-Control', `public, max-age=${ASSET_CACHE_MAX_AGE_SECONDS}, must-revalidate`);
      }
    }
  }));

  app.get('/', (_request, response) => {
    response.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.get('/form', (_request, response) => {
    response.sendFile(path.join(PUBLIC_DIR, 'form.html'));
  });

  app.get('/users', (_request, response) => {
    response.sendFile(path.join(PUBLIC_DIR, 'users.html'));
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
