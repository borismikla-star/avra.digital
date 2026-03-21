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
const storage=multer.diskStorage({destination:UPLOADS,filename:(req,file,cb)=>cb(null,`${uuidv4()}${path.extname(file.originalname)}`)});
const upload=multer({storage,limits:{fileSize:50*1024*1024}});
function defaultRooms(){return[{name:'Obývacia izba',label:'R1',x:-0.105,z:-0.07,w:0.245,d:0.21,area:28},{name:'Kuchyňa',label:'R2',x:0.1575,z:-0.07,w:0.14,d:0.21,area:14},{name:'Spálňa',label:'R3',x:-0.105,z:0.1925,w:0.21,d:0.175,area:16},{name:'Detská izba',label:'R4',x:0.14,z:0.1925,w:0.175,d:0.175,area:12},{name:'Kúpeľňa',label:'R5',x:0.07,z:0.105,w:0.105,d:0.105,area:7}];}
function runParser(p){return new Promise(r=>{execFile('python3',[path.join(__dirname,'../parser/parse.py'),p],{timeout:30000},(e,out)=>{try{const d=JSON.parse(out.trim());r(d.rooms?.length>=2?d:null);}catch{r(null);}});});}
async function buildGLB(id,rooms){try{const buf=generateGLB(rooms);const p=path.join(MODELS,`${id}.glb`);fs.writeFileSync(p,buf);return `${BASE_URL}/models/${id}.glb`;}catch(e){return null;}}

app.post('/api/properties',upload.fields([{name:'floor_plan',maxCount:1},{name:'image',maxCount:1}]),async(req,res)=>{
  try{
    const{name,area,price,description,source}=req.body;
    if(!name)return res.status(400).json({error:'Názov je povinný'});
    const id=uuidv4(),viewerUrl=`${BASE_URL}/view/${id}`;
    let rooms=defaultRooms(),modelType='demo';
    if(req.body.rooms){try{const p=typeof req.body.rooms==='string'?JSON.parse(req.body.rooms):req.body.rooms;if(Array.isArray(p)&&p.length>=1){rooms=p;modelType=source||'trace';}}catch{}}
    const imgFile=req.files?.floor_plan?.[0]||req.files?.image?.[0];
    if(imgFile&&modelType==='demo'){const d=await runParser(imgFile.path);if(d?.rooms?.length>=2){rooms=d.rooms;modelType='opencv';}}
    const glbUrl=await buildGLB(id,rooms);
    const qrCode=await QRCode.toDataURL(viewerUrl,{width:300,margin:2,color:{dark:'#000000',light:'#ffffff'}});
    const prop={id,name,area:area||null,price:price||null,description:description||null,rooms,modelType,glbUrl,viewerUrl,createdAt:Date.now()};
    db.get('properties').push(prop).write();
    console.log(`Saved: ${name} | rooms:${rooms.length} | type:${modelType}`);
    res.json({id,name,viewerUrl,qrCode,rooms:rooms.length,modelType,glbUrl,message:'Nehnuteľnosť vytvorená'});
  }catch(err){console.error(err);res.status(500).json({error:err.message});}
});

app.put('/api/properties/:id',async(req,res)=>{
  const{name,area,price,description,rooms,source}=req.body;
  const changes={name,area,price,description};
  if(rooms&&Array.isArray(rooms)&&rooms.length>=1){changes.rooms=rooms;changes.modelType=source||'trace';const g=await buildGLB(req.params.id,rooms);if(g)changes.glbUrl=g;}
  db.get('properties').find({id:req.params.id}).assign(changes).write();
  const p=db.get('properties').find({id:req.params.id}).value();
  const qrCode=await QRCode.toDataURL(p.viewerUrl,{width:300,margin:2});
  res.json({message:'Aktualizované',qrCode,glbUrl:p.glbUrl,viewerUrl:p.viewerUrl});
});

app.post('/api/parse-floorplan',upload.single('image'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'No image'});
  const d=await runParser(req.file.path);
  res.json(d||{rooms:[],walls:[],error:'Detection failed'});
});

app.get('/api/properties',(req,res)=>res.json(db.get('properties').map(p=>({id:p.id,name:p.name,area:p.area,price:p.price,model_type:p.modelType,qr_url:p.viewerUrl,glb_url:p.glbUrl,created_at:p.createdAt})).orderBy(['createdAt'],['desc']).value()));
app.get('/api/properties/:id',(req,res)=>{const p=db.get('properties').find({id:req.params.id}).value();if(!p)return res.status(404).json({error:'Nenájdené'});res.json({...p,model_type:p.modelType,glb_url:p.glbUrl});});
app.put('/api/properties/:id',(req,res)=>{});
app.delete('/api/properties/:id',(req,res)=>{const p=db.get('properties').find({id:req.params.id}).value();if(p)try{fs.unlinkSync(path.join(MODELS,`${p.id}.glb`));}catch{}db.get('properties').remove({id:req.params.id}).write();res.json({message:'Zmazané'});});
app.get('/api/properties/:id/qr',async(req,res)=>{const p=db.get('properties').find({id:req.params.id}).value();if(!p)return res.status(404).json({error:'Nenájdené'});res.json({qrCode:await QRCode.toDataURL(p.viewerUrl,{width:400,margin:2}),url:p.viewerUrl});});
app.get('/view/:id',(req,res)=>res.sendFile(path.join(PUBLIC,'viewer/index.html')));
app.get('/editor',(req,res)=>res.sendFile(path.join(PUBLIC,'editor/index.html')));
app.get('/editor/:id',(req,res)=>res.sendFile(path.join(PUBLIC,'editor/index.html')));
app.get('/health',(req,res)=>res.json({status:'ok',version:'3.0.0',product:'AVRA Digital',properties:db.get('properties').size().value()}));
app.listen(PORT,()=>console.log(`AVRA v3 on port ${PORT}\n${BASE_URL}/editor`));
