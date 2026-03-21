/**
 * AVRA v2 — Pure Node.js GLB Generator
 * Converts room data to binary .glb file for @google/model-viewer
 */
const GLTF_FLOAT=5126,GLTF_USHORT=5123,GLTF_ARRAY_BUFFER=34962,GLTF_ELEMENT_ARRAY=34963;
const FLOOR_COLORS=[[0.72,0.80,0.88],[0.69,0.83,0.74],[0.87,0.78,0.60],[0.78,0.72,0.85],[0.75,0.85,0.88]];
const WALL_COLORS=[[0.16,0.23,0.36],[0.16,0.29,0.22],[0.29,0.23,0.10],[0.23,0.16,0.29],[0.10,0.19,0.25]];

function box(cx,cy,cz,sx,sy,sz){
  const hx=sx/2,hy=sy/2,hz=sz/2;
  const v=[
    cx-hx,cy-hy,cz+hz, cx+hx,cy-hy,cz+hz, cx+hx,cy+hy,cz+hz, cx-hx,cy+hy,cz+hz,
    cx+hx,cy-hy,cz-hz, cx-hx,cy-hy,cz-hz, cx-hx,cy+hy,cz-hz, cx+hx,cy+hy,cz-hz,
    cx-hx,cy-hy,cz-hz, cx-hx,cy-hy,cz+hz, cx-hx,cy+hy,cz+hz, cx-hx,cy+hy,cz-hz,
    cx+hx,cy-hy,cz+hz, cx+hx,cy-hy,cz-hz, cx+hx,cy+hy,cz-hz, cx+hx,cy+hy,cz+hz,
    cx-hx,cy+hy,cz+hz, cx+hx,cy+hy,cz+hz, cx+hx,cy+hy,cz-hz, cx-hx,cy+hy,cz-hz,
    cx-hx,cy-hy,cz-hz, cx+hx,cy-hy,cz-hz, cx+hx,cy-hy,cz+hz, cx-hx,cy-hy,cz+hz,
  ];
  const idx=[];
  for(let f=0;f<6;f++){const b=f*4;idx.push(b,b+1,b+2,b,b+2,b+3);}
  return {v,idx};
}

function generateGLB(rooms){
  const meshes=[],materials=[],accessors=[],bufferViews=[];
  let byteOffset=0;
  const chunks=[];

  function addMesh(verts,indices,color){
    const mi=materials.length;
    materials.push({pbrMetallicRoughness:{baseColorFactor:[...color,1.0],metallicFactor:0,roughnessFactor:0.85},doubleSided:true});
    const vBuf=Buffer.allocUnsafe(verts.length*4);
    verts.forEach((v,i)=>vBuf.writeFloatLE(v,i*4));
    const iRaw=Buffer.allocUnsafe(indices.length*2);
    indices.forEach((v,i)=>iRaw.writeUInt16LE(v,i*2));
    const iPad=iRaw.length%4===0?0:4-iRaw.length%4;
    const iBuf=Buffer.concat([iRaw,Buffer.alloc(iPad)]);
    const vBV=bufferViews.length;
    bufferViews.push({buffer:0,byteOffset,byteLength:vBuf.length,target:GLTF_ARRAY_BUFFER});
    byteOffset+=vBuf.length; chunks.push(vBuf);
    const iBV=bufferViews.length;
    bufferViews.push({buffer:0,byteOffset,byteLength:iBuf.length,target:GLTF_ELEMENT_ARRAY});
    byteOffset+=iBuf.length; chunks.push(iBuf);
    const xs=[],ys=[],zs=[];
    for(let i=0;i<verts.length;i+=3){xs.push(verts[i]);ys.push(verts[i+1]);zs.push(verts[i+2]);}
    const vA=accessors.length;
    accessors.push({bufferView:vBV,byteOffset:0,componentType:GLTF_FLOAT,count:verts.length/3,type:"VEC3",min:[Math.min(...xs),Math.min(...ys),Math.min(...zs)],max:[Math.max(...xs),Math.max(...ys),Math.max(...zs)]});
    const iA=accessors.length;
    accessors.push({bufferView:iBV,byteOffset:0,componentType:GLTF_USHORT,count:indices.length,type:"SCALAR"});
    const mI=meshes.length;
    meshes.push({primitives:[{attributes:{POSITION:vA},indices:iA,material:mi,mode:4}]});
    return mI;
  }

  const nodes=[];
  const WH=0.09,WT=0.006,FT=0.004;

  rooms.forEach((r,i)=>{
    const ci=i%5,{x,z,w,d}=r;
    const f=box(x,0,z,w,FT,d);
    nodes.push({mesh:addMesh(f.v,f.idx,FLOOR_COLORS[ci]),name:`floor_${r.label||i}`});
    const wc=WALL_COLORS[ci];
    [[x,WH/2,z-d/2,w,WH,WT],[x,WH/2,z+d/2,w,WH,WT],[x-w/2,WH/2,z,WT,WH,d],[x+w/2,WH/2,z,WT,WH,d]].forEach(args=>{
      const g=box(...args); nodes.push({mesh:addMesh(g.v,g.idx,wc)});
    });
  });

  const gltf={
    asset:{version:"2.0",generator:"AVRA Digital v2"},
    scene:0,scenes:[{nodes:nodes.map((_,i)=>i)}],
    nodes,meshes,materials,accessors,bufferViews,
    buffers:[{byteLength:byteOffset}]
  };

  const js=JSON.stringify(gltf);
  const jp=js.length%4===0?0:4-js.length%4;
  const jb=Buffer.concat([Buffer.from(js,'utf8'),Buffer.alloc(jp,0x20)]);
  const bb=Buffer.concat(chunks);
  const bp=bb.length%4===0?0:4-bb.length%4;
  const bpad=Buffer.concat([bb,Buffer.alloc(bp,0)]);
  const total=12+8+jb.length+8+bpad.length;
  const hdr=Buffer.allocUnsafe(12);
  hdr.writeUInt32LE(0x46546C67,0);hdr.writeUInt32LE(2,4);hdr.writeUInt32LE(total,8);
  const jh=Buffer.allocUnsafe(8);jh.writeUInt32LE(jb.length,0);jh.writeUInt32LE(0x4E4F534A,4);
  const bh=Buffer.allocUnsafe(8);bh.writeUInt32LE(bpad.length,0);bh.writeUInt32LE(0x004E4942,4);
  return Buffer.concat([hdr,jh,jb,bh,bpad]);
}

module.exports={generateGLB};
