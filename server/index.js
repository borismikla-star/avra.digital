const express=require('express'),multer=require('multer'),path=require('path'),fs=require('fs');
const {v4:uuidv4}=require('uuid'),QRCode=require('qrcode'),cors=require('cors');
const low=require('lowdb'),FileSync=require('lowdb/adapters/FileSync');
const {execFile,execSync}=require('child_process');
const {generateGLB}=require('./glb');
const {parseFloorPlan}=require('./parser');

const app=express();
const PORT=process.env.PORT||3000;
const BASE_URL=(process.env.BASE_URL||`http://localhost:${PORT}`).replace(/\/$/,'');
const UPLOADS=path.join(__dirname,'../uploads');
const MODELS=path.join(__dirname,'../models');
const PUBLIC=path.join(__dirname,'../public');
[UPLOADS,MODELS,path.join(__dirname,'../data')].forEach(d=>fs.mkdirSync(d,{recursive:true}));
const db=low(new FileSync(path.join(__dirname,'../data/db.json')));
db.defaults({properties:[]}).write();

app.use(cors());
app.use(express.json({limit:'10mb'}));
app.use(express.static(PUBLIC));
app.use('/models',express.static(MODELS,{
  setHeaders:(res,p)=>{
    if(p.endsWith('.glb')) res.setHeader('Content-Type','model/gltf-binary');
  }
}));

const upload=multer({
  storage:multer.diskStorage({
    destination:UPLOADS,
    filename:(req,file,cb)=>cb(null,`${uuidv4()}${path.extname(file.originalname)}`)
  }),
  limits:{fileSize:50*1024*1024}
});

// ── Detect Python (optional — JS parser is primary) ──────────────────────────
let PYTHON=null;
for(const py of ['python3.11','python3','python','/usr/bin/python3.11','/usr/bin/python3']){
  try{execSync(`${py} -c "import sys;print(sys.version)"`,{stdio:'pipe'});PYTHON=py;break;}catch{}
}
console.log('Python:',PYTHON||'not found (using JS parser)');

// ── Helpers ───────────────────────────────────────────────────────────────────
function defaultRooms(){return[
  {name:'Obývacia izba',label:'R1',x:-0.105,z:-0.07,w:0.245,d:0.21,area:28},
  {name:'Kuchyňa',label:'R2',x:0.1575,z:-0.07,w:0.14,d:0.21,area:14},
  {name:'Spálňa',label:'R3',x:-0.105,z:0.1925,w:0.21,d:0.175,area:16},
  {name:'Detská izba',label:'R4',x:0.14,z:0.1925,w:0.175,d:0.175,area:12},
  {name:'Kúpeľňa',label:'R5',x:0.07,z:0.105,w:0.105,d:0.105,area:7},
];}

function validateRooms(r){
  if(!Array.isArray(r)||!r.length)return null;
  const v=r.filter(room=>
    typeof room.x==='number'&&typeof room.z==='number'&&
    typeof room.w==='number'&&typeof room.d==='number'&&
    room.w>0&&room.d>0
  );
  return v.length?v:null;
}

async function runParser(imgPath){
  try{
    const result = await parseFloorPlan(imgPath, PYTHON);
    return result;
  }catch(e){
    console.error('runParser error:',e.message);
    return null;
  }
}

async function buildAndSaveGLB(id,rooms){
  try{
    const buf=generateGLB(rooms);
    const p=path.join(MODELS,`${id}.glb`);
    fs.writeFileSync(p,buf);
    console.log(`GLB: ${p} (${buf.length}b)`);
    return `${BASE_URL}/models/${id}.glb`;
  }catch(e){console.error('GLB error:',e.message);return null;}
}

function propPublic(p){
  return{id:p.id,name:p.name,area:p.area,price:p.price,
    rooms:p.rooms,model_type:p.modelType,
    glb_url:p.glbUrl,viewer_url:p.viewerUrl,created_at:p.createdAt};
}

// ── POST /api/properties ──────────────────────────────────────────────────────
app.post('/api/properties',
  upload.fields([{name:'floor_plan',maxCount:1},{name:'image',maxCount:1}]),
  async(req,res)=>{
  try{
    const name=(req.body.name||'').trim();
    if(!name)return res.status(400).json({error:'Názov je povinný'});
    const id=uuidv4(),viewerUrl=`${BASE_URL}/view/${id}`;
    let rooms=null,modelType='demo',parseMsg=null;

    // Priority 1: rooms from body (editor trace)
    if(req.body.rooms){
      try{
        const raw=typeof req.body.rooms==='string'?JSON.parse(req.body.rooms):req.body.rooms;
        const v=validateRooms(raw);
        if(v){rooms=v;modelType='trace';console.log(`Trace rooms: ${rooms.length}`);}
      }catch(e){console.error('rooms parse:',e.message);}
    }

    // Priority 2: image upload → parser
    const f=req.files?.floor_plan?.[0]||req.files?.image?.[0];
    if(f&&!rooms){
      const parsed=await runParser(f.path);
      if(parsed?.rooms?.length>=2){rooms=parsed.rooms;modelType='opencv';}
      else parseMsg='Parser nenašiel miestnosti — použite manuálny editor';
    }

    // Fallback
    if(!rooms){rooms=defaultRooms();modelType='demo';}

    const glbUrl=await buildAndSaveGLB(id,rooms);
    const qrCode=await QRCode.toDataURL(viewerUrl,{width:300,margin:2,color:{dark:'#000',light:'#fff'}});
    const prop={id,name,area:req.body.area||null,price:req.body.price||null,
      description:req.body.description||null,rooms,modelType,glbUrl,viewerUrl,createdAt:Date.now()};
    db.get('properties').push(prop).write();
    console.log(`✓ Created "${name}" id:${id} rooms:${rooms.length} type:${modelType} glb:${!!glbUrl}`);
    res.json({id,name,viewerUrl,qrCode,rooms:rooms.length,modelType,glbUrl,parseMsg,
      message:'Nehnuteľnosť vytvorená'});
  }catch(e){console.error('POST error:',e);res.status(500).json({error:e.message});}
});

// ── PUT /api/properties/:id ───────────────────────────────────────────────────
app.put('/api/properties/:id',async(req,res)=>{
  try{
    const p=db.get('properties').find({id:req.params.id}).value();
    if(!p)return res.status(404).json({error:`Nenájdené: ${req.params.id}`});
    const{name,area,price,description,rooms,source}=req.body;
    const ch={};
    if(name)ch.name=name.trim();
    if(area!==undefined)ch.area=area;
    if(price!==undefined)ch.price=price;
    if(description!==undefined)ch.description=description;
    if(rooms!==undefined){
      const raw=Array.isArray(rooms)?rooms:(typeof rooms==='string'?JSON.parse(rooms):null);
      const v=validateRooms(raw);
      if(!v)return res.status(400).json({error:'Neplatné rooms dáta'});
      ch.rooms=v; ch.modelType=source||'trace';
      const g=await buildAndSaveGLB(req.params.id,v);
      if(g)ch.glbUrl=g;
      console.log(`✓ Updated "${p.name}" rooms:${v.length} glb:${!!g}`);
    }
    db.get('properties').find({id:req.params.id}).assign(ch).write();
    const updated=db.get('properties').find({id:req.params.id}).value();
    const qrCode=await QRCode.toDataURL(updated.viewerUrl,{width:300,margin:2});
    res.json({...propPublic(updated),qrCode,message:'Aktualizované'});
  }catch(e){console.error('PUT error:',e);res.status(500).json({error:e.message});}
});

// ── POST /api/parse-floorplan ─────────────────────────────────────────────────
app.post('/api/parse-floorplan',upload.single('image'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Súbor chýba'});
  if(!PYTHON)return res.json({rooms:[],walls:[],roomCount:0,
    message:'Python nie je dostupný na serveri. Nakreslite miestnosti manuálne.'});
  console.log('parse-floorplan:',req.file.originalname,req.file.size,'b');
  const r=await runParser(req.file.path);
  if(r?.rooms?.length>=1){
    res.json({...r,message:`Detekovaných ${r.rooms.length} miestností`});
  }else{
    res.json({rooms:[],walls:[],roomCount:0,
      message:'Miestnosti sa nepodarilo detekovať. Skúste čiernobiely pôdorys alebo nakreslite manuálne.'});
  }
});

// ── CRUD ──────────────────────────────────────────────────────────────────────
app.get('/api/properties',(req,res)=>{
  res.json(db.get('properties').map(p=>({
    id:p.id,name:p.name,area:p.area,price:p.price,
    model_type:p.modelType,glb_url:p.glbUrl,
    viewer_url:p.viewerUrl,created_at:p.createdAt
  })).orderBy(['createdAt'],['desc']).value());
});
app.get('/api/properties/:id',(req,res)=>{
  const p=db.get('properties').find({id:req.params.id}).value();
  if(!p)return res.status(404).json({error:`Nenájdené: ${req.params.id}`});
  res.json(propPublic(p));
});
app.delete('/api/properties/:id',(req,res)=>{
  const p=db.get('properties').find({id:req.params.id}).value();
  if(!p)return res.status(404).json({error:'Nenájdené'});
  try{fs.unlinkSync(path.join(MODELS,`${p.id}.glb`));}catch{}
  db.get('properties').remove({id:req.params.id}).write();
  res.json({message:'Zmazané'});
});
app.get('/api/properties/:id/qr',async(req,res)=>{
  const p=db.get('properties').find({id:req.params.id}).value();
  if(!p)return res.status(404).json({error:'Nenájdené'});
  res.json({qrCode:await QRCode.toDataURL(p.viewerUrl,{width:400,margin:2}),url:p.viewerUrl});
});

// ── Pages ─────────────────────────────────────────────────────────────────────
app.get('/view/:id',(req,res)=>res.sendFile(path.join(PUBLIC,'viewer/index.html')));
app.get('/editor',(req,res)=>res.sendFile(path.join(PUBLIC,'editor/index.html')));
app.get('/editor/:id',(req,res)=>res.sendFile(path.join(PUBLIC,'editor/index.html')));
app.get('/admin',(req,res)=>res.sendFile(path.join(PUBLIC,'admin/index.html')));
app.get('/health',(req,res)=>res.json({status:'ok',version:'3.3.0',
  python:PYTHON||null,parser:'js+python',properties:db.get('properties').size().value()}));

app.listen(PORT,()=>console.log(`\nAVRA v3.2 — port ${PORT}\nPython: ${PYTHON||'not found'}\n${BASE_URL}/admin\n`));
