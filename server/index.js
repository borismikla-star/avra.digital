const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const QRCode   = require('qrcode');
const cors     = require('cors');
const low      = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app      = express();
const PORT     = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const UPLOADS_DIR = path.join(__dirname, '../uploads');
const DATA_DIR    = path.join(__dirname, '../data');
const PUBLIC_DIR  = path.join(__dirname, '../public');
[UPLOADS_DIR, DATA_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const adapter = new FileSync(path.join(DATA_DIR, 'db.json'));
const db = low(adapter);
db.defaults({ properties: [] }).write();

app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf','.png','.jpg','.jpeg','.gltf','.glb','.obj'];
    cb(null, ok.includes(path.extname(file.originalname).toLowerCase()));
  }
});

function parsePDF(filePath) {
  return new Promise(resolve => {
    const script = path.join(__dirname, '../scripts/parse_floorplan.py');
    const py = process.platform === 'win32' ? 'python' : 'python3';
    execFile(py, [script, filePath], { timeout: 30000 }, (err, stdout) => {
      try {
        const r = JSON.parse(stdout.trim());
        resolve(r.rooms?.length ? r : { rooms: defaultRooms(), source: 'demo' });
      } catch { resolve({ rooms: defaultRooms(), source: 'demo' }); }
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

app.post('/api/properties', upload.fields([
  { name: 'floor_plan', maxCount: 1 },
  { name: 'model_3d',   maxCount: 1 }
]), async (req, res) => {
  try {
    const { name, area, price, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Názov je povinný' });
    const id = uuidv4();
    const viewerUrl = `${BASE_URL}/view/${id}`;
    let rooms = defaultRooms(), modelType = 'demo', pdfPath = null, modelPath = null;
    if (req.files?.floor_plan?.[0]) {
      pdfPath = req.files.floor_plan[0].path;
      const parsed = await parsePDF(pdfPath);
      rooms = parsed.rooms; modelType = 'floor';
    }
    if (req.files?.model_3d?.[0]) { modelPath = req.files.model_3d[0].path; modelType = 'gltf'; }
    const qrCode = await QRCode.toDataURL(viewerUrl, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
    const property = { id, name, area: area||null, price: price||null, description: description||null, rooms, modelType, pdfPath, modelPath, viewerUrl, createdAt: Date.now() };
    db.get('properties').push(property).write();
    res.json({ id, name, viewerUrl, qrCode, rooms: rooms.length, modelType, message: 'Nehnuteľnosť vytvorená' });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/properties', (req, res) => {
  const list = db.get('properties').map(p => ({ id:p.id, name:p.name, area:p.area, price:p.price, model_type:p.modelType, qr_url:p.viewerUrl, created_at:p.createdAt })).orderBy(['createdAt'],['desc']).value();
  res.json(list);
});

app.get('/api/properties/:id', (req, res) => {
  const p = db.get('properties').find({ id: req.params.id }).value();
  if (!p) return res.status(404).json({ error: 'Nenájdené' });
  res.json({ ...p, model_type: p.modelType });
});

app.put('/api/properties/:id', (req, res) => {
  const { name, area, price, description } = req.body;
  db.get('properties').find({ id: req.params.id }).assign({ name, area, price, description }).write();
  res.json({ message: 'Aktualizované' });
});

app.delete('/api/properties/:id', (req, res) => {
  const p = db.get('properties').find({ id: req.params.id }).value();
  if (p) { if (p.pdfPath && fs.existsSync(p.pdfPath)) fs.unlinkSync(p.pdfPath); if (p.modelPath && fs.existsSync(p.modelPath)) fs.unlinkSync(p.modelPath); }
  db.get('properties').remove({ id: req.params.id }).write();
  res.json({ message: 'Zmazané' });
});

app.get('/api/properties/:id/qr', async (req, res) => {
  const p = db.get('properties').find({ id: req.params.id }).value();
  if (!p) return res.status(404).json({ error: 'Nenájdené' });
  const url = `${BASE_URL}/view/${p.id}`;
  const qrCode = await QRCode.toDataURL(url, { width: 400, margin: 2 });
  res.json({ qrCode, url });
});

app.get('/view/:id', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'viewer/index.html')));

app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0', product: 'AVRA Digital', properties: db.get('properties').size().value() }));

app.listen(PORT, () => { console.log(`AVRA Digital running on port ${PORT}\nAdmin: ${BASE_URL}/admin`); });
