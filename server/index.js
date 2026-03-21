const express=require('express'),multer=require('multer'),path=require('path'),fs=require('fs');
const {v4:uuidv4}=require('uuid'),QRCode=require('qrcode'),cors=require('cors');
const low=require('lowdb'),FileSync=require('lowdb/adapters/FileSync');
const {execFile}=require('child_process');
const {generateGLB}=require('./glb');

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
app.use('/models',express.static(MODELS));

const upload=multer({
  storage:multer.diskStorage({
    destination:UPLOADS,
    filename:(req,file,cb)=>cb(null,`${uuidv4()}${path.extname(file.originalname)}`)
  }),
  limits:{fileSize:50*1024*1024}
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function defaultRooms(){return[
  {name:'Obývacia izba',label:'R1',x:-0.105,z:-0.07,w:0.245,d:0.21,area:28},
  {name:'Kuchyňa',label:'R2',x:0.1575,z:-0.07,w:0.14,d:0.21,area:14},
  {name:'Spálňa',label:'R3',x:-0.105,z:0.1925,w:0.21,d:0.175,area:16},
  {name:'Detská izba',label:'R4',x:0.14,z:0.1925,w:0.175,d:0.175,area:12},
  {name:'Kúpeľňa',label:'R5',x:0.07,z:0.105,w:0.105,d:0.105,area:7},
];}

function validateRooms(rooms){
  if(!Array.isArray(rooms)||rooms.length===0)return null;
  return rooms.filter(r=>
    typeof r.x==='number'&&typeof r.z==='number'&&
    typeof r.w==='number'&&typeof r.d==='number'&&
    r.w>0&&r.d>0
  );
}

function runParser(imgPath){
  return new Promise(resolve=>{
    const script=path.join(__dirname,'../parser/parse.py');
    execFile('python3',[script,imgPath],{timeout:30000},(err,stdout,stderr)=>{
      if(err){console.error('Parser exec error:',err.message);resolve(null);return;}
      try{
        const r=JSON.parse(stdout.trim());
        if(r.error){console.error('Parser returned error:',r.error);resolve(null);return;}
        resolve(r.rooms?.length>=2?r:null);
      }catch(e){console.error('Parser JSON parse error:',e.message,'\nstdout:',stdout.slice(0,200));resolve(null);}
    });
  });
}

async function buildGLB(id,rooms){
  try{
    const buf=generateGLB(rooms);
    const p=path.join(MODELS,`${id}.glb`);
    fs.writeFileSync(p,buf);
    console.log(`GLB saved: ${p} (${buf.length} bytes)`);
    return `${BASE_URL}/models/${id}.glb`;
  }catch(e){console.error('GLB generation error:',e.message);return null;}
}

function propToPublic(p){
  return{
    id:p.id,name:p.name,area:p.area,price:p.price,
    description:p.description,
    rooms:p.rooms,
    model_type:p.modelType,
    glb_url:p.glbUrl,
    viewer_url:p.viewerUrl,
    created_at:p.createdAt
  };
}

// ── POST /api/properties ──────────────────────────────────────────────────────
app.post('/api/properties',
  upload.fields([{name:'floor_plan',maxCount:1},{name:'image',maxCount:1}]),
  async(req,res)=>{
  try{
    const name=(req.body.name||'').trim();
    if(!name)return res.status(400).json({error:'Názov je povinný'});

    const id=uuidv4();
    const viewerUrl=`${BASE_URL}/view/${id}`;
    let rooms=null,modelType='demo',parseError=null;

    // 1. Rooms from JSON/FormData (Trace editor)
    if(req.body.rooms){
      try{
        const raw=typeof req.body.rooms==='string'?JSON.parse(req.body.rooms):req.body.rooms;
        const valid=validateRooms(raw);
        if(valid&&valid.length>=1){rooms=valid;modelType=req.body.source||'trace';console.log(`Rooms from editor: ${rooms.length}`);}
        else console.warn('Invalid rooms in request body');
      }catch(e){console.error('Rooms parse error:',e.message);}
    }

    // 2. Image upload → OpenCV parser
    const imgFile=req.files?.floor_plan?.[0]||req.files?.image?.[0];
    if(imgFile&&!rooms){
      console.log('Running parser on:',imgFile.originalname);
      const parsed=await runParser(imgFile.path);
      if(parsed?.rooms?.length>=2){
        rooms=parsed.rooms;modelType='opencv';
        console.log(`Parser found ${rooms.length} rooms`);
      }else{
        parseError='Auto-detekcia nenašla miestnosti v nahranom pôdoryse.';
        console.warn('Parser returned no rooms');
      }
    }

    // 3. Fallback — only if nothing else worked
    if(!rooms){rooms=defaultRooms();modelType='demo';}

    const glbUrl=await buildGLB(id,rooms);
    const qrCode=await QRCode.toDataURL(viewerUrl,{width:300,margin:2,color:{dark:'#000000',light:'#ffffff'}});

    const prop={id,name,
      area:req.body.area||null,price:req.body.price||null,
      description:req.body.description||null,
      rooms,modelType,glbUrl,viewerUrl,createdAt:Date.now()
    };
    db.get('properties').push(prop).write();
    console.log(`✓ Created: "${name}" | id:${id} | rooms:${rooms.length} | type:${modelType} | glb:${!!glbUrl}`);

    res.json({
      id,name,viewerUrl,qrCode,
      rooms:rooms.length,modelType,glbUrl,
      parseError,
      message:`Nehnuteľnosť vytvorená${parseError?' ('+parseError+')':''}`
    });
  }catch(err){
    console.error('POST /api/properties error:',err);
    res.status(500).json({error:err.message});
  }
});

// ── PUT /api/properties/:id ───────────────────────────────────────────────────
app.put('/api/properties/:id',async(req,res)=>{
  try{
    const existing=db.get('properties').find({id:req.params.id}).value();
    if(!existing)return res.status(404).json({error:`Property ${req.params.id} nenájdená`});

    const{name,area,price,description,rooms,source}=req.body;
    const changes={};
    if(name!==undefined)changes.name=name.trim()||existing.name;
    if(area!==undefined)changes.area=area;
    if(price!==undefined)changes.price=price;
    if(description!==undefined)changes.description=description;

    if(rooms!==undefined){
      const valid=validateRooms(Array.isArray(rooms)?rooms:JSON.parse(rooms));
      if(valid&&valid.length>=1){
        changes.rooms=valid;
        changes.modelType=source||'trace';
        console.log(`Updating rooms for ${req.params.id}: ${valid.length} rooms`);
        const glbUrl=await buildGLB(req.params.id,valid);
        if(glbUrl)changes.glbUrl=glbUrl;
      }else{
        return res.status(400).json({error:'Neplatné room dáta'});
      }
    }

    db.get('properties').find({id:req.params.id}).assign(changes).write();
    const updated=db.get('properties').find({id:req.params.id}).value();
    const qrCode=await QRCode.toDataURL(updated.viewerUrl,{width:300,margin:2});
    console.log(`✓ Updated: "${updated.name}" | rooms:${updated.rooms?.length}`);
    res.json({message:'Aktualizované',qrCode,glbUrl:updated.glbUrl,viewerUrl:updated.viewerUrl,...propToPublic(updated)});
  }catch(err){
    console.error('PUT error:',err);
    res.status(500).json({error:err.message});
  }
});

// ── POST /api/parse-floorplan ─────────────────────────────────────────────────
app.post('/api/parse-floorplan',upload.single('image'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Súbor nebol nahraný'});
  console.log('parse-floorplan:',req.file.originalname,req.file.size,'bytes');
  const result=await runParser(req.file.path);
  if(result&&result.rooms?.length>=2){
    console.log(`parse-floorplan: found ${result.rooms.length} rooms`);
    res.json(result);
  }else{
    res.json({rooms:[],walls:[],roomCount:0,
      message:'Auto-detekcia nenašla miestnosti. Skúste nakresliť manuálne alebo upravte jas pôdorysu.'});
  }
});

// ── GET /api/properties ───────────────────────────────────────────────────────
app.get('/api/properties',(req,res)=>{
  const list=db.get('properties')
    .map(p=>({id:p.id,name:p.name,area:p.area,price:p.price,
              model_type:p.modelType,glb_url:p.glbUrl,
              viewer_url:p.viewerUrl,created_at:p.createdAt}))
    .orderBy(['createdAt'],['desc']).value();
  res.json(list);
});

// ── GET /api/properties/:id ───────────────────────────────────────────────────
app.get('/api/properties/:id',(req,res)=>{
  const p=db.get('properties').find({id:req.params.id}).value();
  if(!p)return res.status(404).json({error:`Property '${req.params.id}' nenájdená`});
  res.json(propToPublic(p));
});

// ── DELETE /api/properties/:id ────────────────────────────────────────────────
app.delete('/api/properties/:id',(req,res)=>{
  const p=db.get('properties').find({id:req.params.id}).value();
  if(!p)return res.status(404).json({error:'Nenájdená'});
  try{fs.unlinkSync(path.join(MODELS,`${p.id}.glb`));}catch{}
  db.get('properties').remove({id:req.params.id}).write();
  res.json({message:'Zmazané'});
});

// ── GET /api/properties/:id/qr ────────────────────────────────────────────────
app.get('/api/properties/:id/qr',async(req,res)=>{
  const p=db.get('properties').find({id:req.params.id}).value();
  if(!p)return res.status(404).json({error:'Nenájdená'});
  res.json({qrCode:await QRCode.toDataURL(p.viewerUrl,{width:400,margin:2}),url:p.viewerUrl});
});

// ── SPA routes — ID extracted from path by frontend ──────────────────────────
// IMPORTANT: Frontend reads ID from window.location.pathname, not query string
app.get('/view/:id',(req,res)=>res.sendFile(path.join(PUBLIC,'viewer/index.html')));
app.get('/editor',(req,res)=>res.sendFile(path.join(PUBLIC,'editor/index.html')));
app.get('/editor/:id',(req,res)=>res.sendFile(path.join(PUBLIC,'editor/index.html')));
app.get('/admin',(req,res)=>res.sendFile(path.join(PUBLIC,'admin/index.html')));
app.get('/health',(req,res)=>res.json({
  status:'ok',version:'3.1.0',product:'AVRA Digital',
  properties:db.get('properties').size().value(),
  routes:{admin:'/admin',editor:'/editor/:id',viewer:'/view/:id'}
}));

app.listen(PORT,()=>console.log(`\nAVRA Digital v3.1\n  ${BASE_URL}/admin\n  ${BASE_URL}/editor\n  ${BASE_URL}/health\n`));
