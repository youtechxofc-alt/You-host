const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs-extra');
const mime = require('mime-types');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

function detectBaseURL(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  if (process.env.HEROKU_APP_NAME) return `https://${process.env.HEROKU_APP_NAME}.herokuapp.com`;
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  if (process.env.RENDER_SERVICE_NAME) return `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.FLY_APP_NAME) return `https://${process.env.FLY_APP_NAME}.fly.dev`;
  if (process.env.KOYEB_PUBLIC_DOMAIN) return `https://${process.env.KOYEB_PUBLIC_DOMAIN}`;
  if (process.env.CYCLIC_URL) return process.env.CYCLIC_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function detectPlatform() {
  if (process.env.HEROKU_APP_NAME) return { name: 'Heroku', icon: '🟣' };
  if (process.env.RENDER_EXTERNAL_URL || process.env.RENDER_SERVICE_NAME) return { name: 'Render', icon: '🟢' };
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return { name: 'Railway', icon: '🚂' };
  if (process.env.FLY_APP_NAME) return { name: 'Fly.io', icon: '✈️' };
  if (process.env.KOYEB_PUBLIC_DOMAIN) return { name: 'Koyeb', icon: '⚡' };
  if (process.env.CYCLIC_URL) return { name: 'Cyclic', icon: '🔄' };
  if (process.env.VERCEL_URL) return { name: 'Vercel', icon: '▲' };
  return { name: 'Local / Custom', icon: '🖥️' };
}

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
fs.ensureDirSync(UPLOADS_DIR);

const MAX_IMAGE_SIZE = parseInt(process.env.MAX_IMAGE_SIZE) || 50 * 1024 * 1024;
const MAX_VIDEO_SIZE = parseInt(process.env.MAX_VIDEO_SIZE) || 500 * 1024 * 1024;
const MAX_FILE_SIZE = Math.max(MAX_IMAGE_SIZE, MAX_VIDEO_SIZE);

const ALLOWED_TYPES = {
  image: ['image/jpeg','image/jpg','image/png','image/gif','image/webp','image/svg+xml','image/bmp','image/tiff'],
  video: ['video/mp4','video/webm','video/ogg','video/quicktime','video/x-msvideo','video/x-matroska','video/mpeg','video/3gpp'],
  other: ['application/pdf','audio/mpeg','audio/wav','audio/ogg','audio/webm']
};

const ALL_ALLOWED = [...ALLOWED_TYPES.image, ...ALLOWED_TYPES.video, ...ALLOWED_TYPES.other];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.' + (mime.extension(file.mimetype) || 'bin');
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALL_ALLOWED.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${file.mimetype}`));
  }
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT) || 30,
  message: { error: 'Too many uploads, please slow down.' }
});

const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 100 });

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/f', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(UPLOADS_DIR));

const fileRegistry = new Map();

app.get('/health', (req, res) => {
  const platform = detectPlatform();
  res.json({ status: 'ok', platform: platform.name, uptime: process.uptime(), files: fileRegistry.size, timestamp: new Date().toISOString() });
});

app.get('/api/info', apiLimiter, (req, res) => {
  const platform = detectPlatform();
  const baseURL = detectBaseURL(req);
  res.json({ platform: platform.name, platformIcon: platform.icon, baseURL, maxImageSize: MAX_IMAGE_SIZE, maxVideoSize: MAX_VIDEO_SIZE, allowedTypes: ALLOWED_TYPES, totalFiles: fileRegistry.size });
});

app.post('/api/upload', uploadLimiter, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const baseURL = detectBaseURL(req);
    const fileType = ALLOWED_TYPES.image.includes(req.file.mimetype) ? 'image'
      : ALLOWED_TYPES.video.includes(req.file.mimetype) ? 'video' : 'file';
    const fileData = {
      id: path.parse(req.file.filename).name,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      type: fileType,
      uploadedAt: new Date().toISOString(),
      url: `${baseURL}/f/${req.file.filename}`,
      deleteKey: uuidv4()
    };
    fileRegistry.set(fileData.id, fileData);
    res.json({ success: true, url: fileData.url, id: fileData.id, filename: req.file.filename, originalName: fileData.originalName, mimeType: fileData.mimeType, size: fileData.size, type: fileData.type, uploadedAt: fileData.uploadedAt, deleteKey: fileData.deleteKey, deleteUrl: `${baseURL}/api/delete/${fileData.id}?key=${fileData.deleteKey}` });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Upload failed.' });
  }
});

app.post('/api/upload/multi', uploadLimiter, upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded.' });
    const baseURL = detectBaseURL(req);
    const results = req.files.map(file => {
      const fileType = ALLOWED_TYPES.image.includes(file.mimetype) ? 'image'
        : ALLOWED_TYPES.video.includes(file.mimetype) ? 'video' : 'file';
      const fileData = { id: path.parse(file.filename).name, filename: file.filename, originalName: file.originalname, mimeType: file.mimetype, size: file.size, type: fileType, uploadedAt: new Date().toISOString(), url: `${baseURL}/f/${file.filename}`, deleteKey: uuidv4() };
      fileRegistry.set(fileData.id, fileData);
      return { url: fileData.url, id: fileData.id, originalName: fileData.originalName, size: fileData.size, type: fileData.type, deleteKey: fileData.deleteKey };
    });
    res.json({ success: true, files: results, count: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/file/:id', apiLimiter, (req, res) => {
  const file = fileRegistry.get(req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found.' });
  const { deleteKey, ...publicData } = file;
  res.json(publicData);
});

app.delete('/api/delete/:id', apiLimiter, async (req, res) => {
  const { id } = req.params;
  const { key } = req.query;
  const file = fileRegistry.get(id);
  if (!file) return res.status(404).json({ error: 'File not found.' });
  if (file.deleteKey !== key) return res.status(403).json({ error: 'Invalid delete key.' });
  try {
    await fs.remove(path.join(UPLOADS_DIR, file.filename));
    fileRegistry.delete(id);
    res.json({ success: true, message: 'File deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete file.' });
  }
});

app.get('/api/recent', apiLimiter, (req, res) => {
  const files = Array.from(fileRegistry.values())
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
    .slice(0, 20)
    .map(({ deleteKey, ...f }) => f);
  res.json({ files, total: fileRegistry.size });
});

app.get('/api/stats', apiLimiter, (req, res) => {
  const files = Array.from(fileRegistry.values());
  res.json({ totalFiles: files.length, totalSize: files.reduce((acc, f) => acc + f.size, 0), images: files.filter(f => f.type === 'image').length, videos: files.filter(f => f.type === 'video').length, others: files.filter(f => f.type === 'file').length, platform: detectPlatform() });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File too large. Max size: ${MAX_FILE_SIZE / 1024 / 1024}MB` });
    return res.status(400).json({ error: err.message });
  }
  if (err) return res.status(400).json({ error: err.message });
  next();
});

app.listen(PORT, () => {
  const platform = detectPlatform();
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║         YOU.HOST IS LIVE            ║`);
  console.log(`╚══════════════════════════════════════╝`);
  console.log(`  Platform : ${platform.icon}  ${platform.name}`);
  console.log(`  Port     : ${PORT}`);
  console.log(`  Uploads  : ${UPLOADS_DIR}`);
  console.log(`  Max Size : ${MAX_FILE_SIZE / 1024 / 1024}MB\n`);
});

module.exports = app;
