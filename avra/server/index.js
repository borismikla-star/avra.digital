const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const QRCode  = require('qrcode');
const cors    = require('cors');
const Database = require('better-sqlite3');

const app  = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── Dirs ──────────────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, '../uploads');
const DB_PATH     = path.join(__dirname, '../data/avra.db');
const PUBLIC_DIR  = path.join(__dirname, '../public');
[UPLOADS_DIR, path.dirname(DB_PATH)].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS properties (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    area        TEXT,
    price       TEXT,
    description TEXT,
    rooms_json  TEXT,
    model_type  TEXT DEFAULT 'floor',
    pdf_path    TEXT,
    model_path  TEXT,
    qr_url      TEXT,
    created_at  INTEGER DEFAULT (unixepoch())
  );
`);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// File upload config
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.png', '.jpg', '.jpeg', '.gltf', '.glb', '.obj'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// ── Python parser helper ──────────────────────────────────────────────────────
function parsePDF(filePath) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '../scripts/parse_floorplan.py');
    const python = process.platform === 'win32' ? 'python' : 'python3';
    execFile(python, [scriptPath, filePath], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: err.message, rooms: defaultRooms() });
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        if (result.error || !result.rooms?.length) {
          resolve({ rooms: defaultRooms(), source: 'demo' });
        } else {
          resolve(result);
        }
      } catch {
        resolve({ rooms: defaultRooms(), source: 'demo' });
      }
    });
  });
}

function defaultRooms() {
  return [
    { name:'Obývacia izba', label:'R1', x:-0.105, z:-0.07,  w:0.245, d:0.21,  area:28 },
    { name:'Kuchyňa',       label:'R2', x: 0.1575,z:-0.07,  w:0.14,  d:0.21,  area:14 },
    { name:'Spálňa',        label:'R3', x:-0.105, z: 0.1925,w:0.21,  d:0.175, area:16 },
    { name:'Detská izba',   label:'R4', x: 0.14,  z: 0.1925,w:0.175, d:0.175, area:12 },
    { name:'Kúpeľňa',       label:'R5', x: 0.07,  z: 0.105, w:0.105, d:0.105, area:7  },
  ];
}

// ── API: Upload + create property ─────────────────────────────────────────────
app.post('/api/properties', upload.fields([
  { name: 'floor_plan', maxCount: 1 },
  { name: 'model_3d',   maxCount: 1 }
]), async (req, res) => {
  try {
    const { name, area, price, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Názov je povinný' });

    const id = uuidv4();
    const viewerUrl = `${BASE_URL}/view/${id}`;

    let rooms = defaultRooms();
    let modelType = 'demo';
    let pdfPath = null;
    let modelPath = null;

    // Parse floor plan
    if (req.files?.floor_plan?.[0]) {
      pdfPath = req.files.floor_plan[0].path;
      const ext = path.extname(pdfPath).toLowerCase();
      if (ext === '.pdf' || ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
        const parsed = await parsePDF(pdfPath);
        rooms = parsed.rooms;
        modelType = 'floor';
      }
    }

    // 3D model uploaded
    if (req.files?.model_3d?.[0]) {
      modelPath = req.files.model_3d[0].path;
      modelType = 'gltf';
    }

    // Generate QR code as base64
    const qrDataUrl = await QRCode.toDataURL(viewerUrl, {
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });

    // Save to DB
    db.prepare(`
      INSERT INTO properties (id, name, area, price, description, rooms_json, model_type, pdf_path, model_path, qr_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, area || null, price || null, description || null,
           JSON.stringify(rooms), modelType, pdfPath, modelPath, viewerUrl);

    res.json({
      id,
      name,
      viewerUrl,
      qrCode: qrDataUrl,
      rooms: rooms.length,
      modelType,
      message: 'Nehnuteľnosť úspešne vytvorená'
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: List all properties ──────────────────────────────────────────────────
app.get('/api/properties', (req, res) => {
  const rows = db.prepare(
    'SELECT id, name, area, price, description, model_type, qr_url, created_at FROM properties ORDER BY created_at DESC'
  ).all();
  res.json(rows);
});

// ── API: Get single property ──────────────────────────────────────────────────
app.get('/api/properties/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nehnuteľnosť nenájdená' });
  row.rooms = JSON.parse(row.rooms_json || '[]');
  delete row.rooms_json;
  res.json(row);
});

// ── API: Update property ──────────────────────────────────────────────────────
app.put('/api/properties/:id', express.json(), (req, res) => {
  const { name, area, price, description } = req.body;
  db.prepare('UPDATE properties SET name=?, area=?, price=?, description=? WHERE id=?')
    .run(name, area, price, description, req.params.id);
  res.json({ message: 'Aktualizované' });
});

// ── API: Delete property ──────────────────────────────────────────────────────
app.delete('/api/properties/:id', (req, res) => {
  const row = db.prepare('SELECT pdf_path, model_path FROM properties WHERE id = ?').get(req.params.id);
  if (row) {
    if (row.pdf_path   && fs.existsSync(row.pdf_path))   fs.unlinkSync(row.pdf_path);
    if (row.model_path && fs.existsSync(row.model_path)) fs.unlinkSync(row.model_path);
  }
  db.prepare('DELETE FROM properties WHERE id = ?').run(req.params.id);
  res.json({ message: 'Zmazané' });
});

// ── API: Regenerate QR ────────────────────────────────────────────────────────
app.get('/api/properties/:id/qr', async (req, res) => {
  const row = db.prepare('SELECT id, name FROM properties WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nenájdené' });
  const url = `${BASE_URL}/view/${row.id}`;
  const qrDataUrl = await QRCode.toDataURL(url, { width: 400, margin: 2 });
  res.json({ qrCode: qrDataUrl, url });
});

// ── AR Viewer route ───────────────────────────────────────────────────────────
app.get('/view/:id', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'viewer/index.html'));
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', product: 'AVRA Digital' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🏠 AVRA Digital backend running`);
  console.log(`   Local:  http://localhost:${PORT}`);
  console.log(`   Admin:  http://localhost:${PORT}/admin`);
  console.log(`   API:    http://localhost:${PORT}/api/properties\n`);
});
