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
const DATA=path.join(__dirname,'../data');
const PUBLIC=path.join(__dirname,'../public');
[UPLOADS,MODELS,DATA].forEach(d=>fs.mkdirSync(d,{recursive:true}));

const db=low(new FileSync(path.join(DATA,'db.json')));
db.defaults({properties:[]}).write();

app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC));
// Serve GLB models
app.use('/models',express.static(MODELS));

const storage=multer.diskStorage({
  destination:UPLOADS,
  filename:(req,file,cb)=>cb(null,`${uuidv4()}${path.extname(file.originalname)}`)
});
const upload=multer({storage,limits:{fileSize:50*1024*1024},
  fileFilter:(req,file,cb)=>cb(null,['.pdf','.png','.jpg','.jpeg','.gltf','.glb'].includes(path.extname(file.originalname).toLowerCase()))
});

function defaultRooms(){
  return [
    {name:'Obývacia izba',label:'R1',x:-0.105,z:-0.07, w:0.245,d:0.21, area:28},
    {name:'Kuchyňa',      label:'R2',x:0.1575,z:-0.07, w:0.14, d:0.21, area:14},
    {name:'Spálňa',       label:'R3',x:-0.105,z:0.1925,w:0.21, d:0.175,area:16},
    {name:'Detská izba',  label:'R4',x:0.14,  z:0.1925,w:0.175,d:0.175,area:12},
    {name:'Kúpeľňa',      label:'R5',x:0.07,  z:0.105, w:0.105,d:0.105,area:7 },
  ];
}

// Convert PDF to PNG for OpenCV processing
function pdfToPng(pdfPath){
  return new Promise(resolve=>{
    const outBase=pdfPath+'_cvt';
    execFile('pdftoppm',['-png','-r','150','-f','1','-l','1',pdfPath,outBase],
      {timeout:20000},(err)=>{
        if(err){resolve(null);return;}
        // Find generated file
        const dir=path.dirname(outBase),base=path.basename(outBase);
        try{
          const files=fs.readdirSync(dir).filter(f=>f.startsWith(base)&&f.endsWith('.png'));
          resolve(files.length?path.join(dir,files[0]):null);
        }catch{resolve(null);}
      });
  });
}

// Run Python parser
function runParser(imagePath){
  return new Promise(resolve=>{
    const script=path.join(__dirname,'../parser/parse.py');
    const py=process.platform==='win32'?'python':'python3';
    execFile(py,[script,imagePath],{timeout:30000},(err,stdout,stderr)=>{
      if(err){console.error('Parser error:',err.message);resolve(null);return;}
      try{
        const r=JSON.parse(stdout.trim());
        console.log(`Parser: source=${r.source}, rooms=${r.roomCount}, walls=${r.wallCount}`);
        resolve(r);
      }catch(e){console.error('Parser JSON error:',e.message);resolve(null);}
    });
  });
}

// ── POST /api/properties ──────────────────────────────────────────────────────
app.post('/api/properties',upload.fields([
  {name:'floor_plan',maxCount:1},
  {name:'model_3d',maxCount:1}
]),async(req,res)=>{
  try{
    const{name,area,price,description}=req.body;
    if(!name)return res.status(400).json({error:'Názov je povinný'});

    const id=uuidv4();
    const viewerUrl=`${BASE_URL}/view/${id}`;
    let rooms=defaultRooms(),modelType='demo';
    let pdfPath=null,modelPath=null,glbPath=null;

    if(req.files?.floor_plan?.[0]){
      pdfPath=req.files.floor_plan[0].path;
      const ext=path.extname(pdfPath).toLowerCase();
      let imagePath=pdfPath;

      // Convert PDF to PNG first
      if(ext==='.pdf'){
        console.log('Converting PDF to PNG...');
        const png=await pdfToPng(pdfPath);
        if(png){imagePath=png;console.log('PDF converted:',png);}
        else console.log('PDF conversion failed, trying direct parse');
      }

      // Run OpenCV parser
      const parsed=await runParser(imagePath);
      if(parsed&&parsed.rooms&&parsed.rooms.length>=2){
        rooms=parsed.rooms;
        modelType='floor';
      }else{
        console.log('Using default rooms (parser failed or too few rooms)');
        modelType='floor';
      }

      // Generate GLB from rooms
      try{
        const glbBuf=generateGLB(rooms);
        glbPath=path.join(MODELS,`${id}.glb`);
        fs.writeFileSync(glbPath,glbBuf);
        console.log(`GLB generated: ${glbPath} (${glbBuf.length} bytes)`);
        modelType='glb';
      }catch(e){
        console.error('GLB generation error:',e.message);
      }
    }

    if(req.files?.model_3d?.[0]){
      modelPath=req.files.model_3d[0].path;
      modelType='gltf';
    }

    const qrCode=await QRCode.toDataURL(viewerUrl,{width:300,margin:2,color:{dark:'#000000',light:'#ffffff'}});

    const property={id,name,area:area||null,price:price||null,description:description||null,
      rooms,modelType,pdfPath,modelPath,
      glbUrl: glbPath?`${BASE_URL}/models/${id}.glb`:null,
      viewerUrl,createdAt:Date.now()};

    db.get('properties').push(property).write();
    console.log('Saved:',id,name,'modelType:',modelType,'rooms:',rooms.length);

    res.json({id,name,viewerUrl,qrCode,rooms:rooms.length,modelType,
      glbUrl:property.glbUrl,message:'Nehnuteľnosť vytvorená'});
  }catch(err){
    console.error('POST error:',err);
    res.status(500).json({error:err.message});
  }
});

app.get('/api/properties',(req,res)=>{
  const list=db.get('properties').map(p=>({id:p.id,name:p.name,area:p.area,price:p.price,
    model_type:p.modelType,qr_url:p.viewerUrl,glb_url:p.glbUrl,created_at:p.createdAt})).orderBy(['createdAt'],['desc']).value();
  res.json(list);
});

app.get('/api/properties/:id',(req,res)=>{
  const p=db.get('properties').find({id:req.params.id}).value();
  if(!p)return res.status(404).json({error:'Nenájdené'});
  res.json({...p,model_type:p.modelType,glb_url:p.glbUrl});
});

app.put('/api/properties/:id',(req,res)=>{
  const{name,area,price,description}=req.body;
  db.get('properties').find({id:req.params.id}).assign({name,area,price,description}).write();
  res.json({message:'Aktualizované'});
});

app.delete('/api/properties/:id',(req,res)=>{
  const p=db.get('properties').find({id:req.params.id}).value();
  if(p){
    [p.pdfPath,p.modelPath,p.glbUrl&&path.join(MODELS,`${p.id}.glb`)].forEach(f=>{
      if(f&&fs.existsSync(f))try{fs.unlinkSync(f);}catch{}
    });
  }
  db.get('properties').remove({id:req.params.id}).write();
  res.json({message:'Zmazané'});
});

app.get('/api/properties/:id/qr',async(req,res)=>{
  const p=db.get('properties').find({id:req.params.id}).value();
  if(!p)return res.status(404).json({error:'Nenájdené'});
  const url=`${BASE_URL}/view/${p.id}`;
  const qrCode=await QRCode.toDataURL(url,{width:400,margin:2});
  res.json({qrCode,url});
});

app.get('/view/:id',(req,res)=>res.sendFile(path.join(PUBLIC,'viewer/index.html')));
app.get('/health',(req,res)=>res.json({status:'ok',version:'2.0.0',product:'AVRA Digital',
  properties:db.get('properties').size().value()}));

app.listen(PORT,()=>{
  console.log(`\nAVRA Digital v2.0 — port ${PORT}`);
  console.log(`Admin:  ${BASE_URL}/admin`);
  console.log(`Health: ${BASE_URL}/health\n`);
});
