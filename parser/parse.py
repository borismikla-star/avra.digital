#!/usr/bin/env python3
import sys, json, math
import numpy as np

ROOM_NAMES = ['Obývacia izba','Kuchyna','Spalna','Detska izba','Kupelna','Chodba','Pracovna','Jedalnen','WC','Satnik','Terasa','Balkon']

def parse(path):
    try:
        import cv2
        img = cv2.imread(path)
        if img is None: return fallback(path)
        H,W = img.shape[:2]
        sc = min(1000/W, 1000/H, 1.0)
        if sc < 1.0: img = cv2.resize(img,(int(W*sc),int(H*sc))); H,W=img.shape[:2]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        gray = cv2.normalize(gray,None,0,255,cv2.NORM_MINMAX)
        _,binary = cv2.threshold(gray,128,255,cv2.THRESH_BINARY_INV)
        k=np.ones((3,3),np.uint8)
        binary=cv2.morphologyEx(binary,cv2.MORPH_CLOSE,k,iterations=2)
        binary=cv2.morphologyEx(binary,cv2.MORPH_OPEN,k,iterations=1)
        edges=cv2.Canny(gray,50,150,apertureSize=3)
        lines_raw=cv2.HoughLinesP(edges,1,np.pi/180,60,minLineLength=int(min(W,H)*0.05),maxLineGap=15)
        walls=[]
        if lines_raw is not None:
            for l in lines_raw:
                x1,y1,x2,y2=l[0]
                length=math.hypot(x2-x1,y2-y1)
                angle=math.degrees(math.atan2(y2-y1,x2-x1))%180
                is_h=angle<12 or angle>168; is_v=78<angle<102
                if not(is_h or is_v) or length<min(W,H)*0.04: continue
                walls.append({"x1":round(x1/W,4),"y1":round(y1/H,4),"x2":round(x2/W,4),"y2":round(y2/H,4),"length":round(length/max(W,H),4),"type":"horizontal" if is_h else "vertical"})
        room_mask=cv2.bitwise_not(binary)
        contours,_=cv2.findContours(room_mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        valid=sorted([(cv2.contourArea(c),c) for c in contours if W*H*0.005<cv2.contourArea(c)<W*H*0.8],key=lambda x:-x[0])
        SCALE,AR=20.0,0.035
        rooms=[]
        for i,(area,cnt) in enumerate(valid[:12]):
            x,y,w,h=cv2.boundingRect(cnt)
            rooms.append({"name":ROOM_NAMES[i%len(ROOM_NAMES)],"label":f"R{i+1}","x":round((x+w/2)/W*SCALE*AR-SCALE*AR/2,4),"z":round((y+h/2)/H*SCALE*AR-SCALE*AR/2,4),"w":round(w/W*SCALE*AR,4),"d":round(h/H*SCALE*AR,4),"area":round(w/W*SCALE*h/H*SCALE,1)})
        return {"walls":walls,"rooms":rooms,"source":"opencv","wallCount":len(walls),"roomCount":len(rooms)}
    except Exception as e:
        return fallback(path)

def fallback(path):
    try:
        from PIL import Image
        img=Image.open(path).convert('L').resize((256,256))
        arr=np.array(img)
        visited=np.zeros((256,256),bool); wall=arr<140; rooms=[]
        MIN=256*256*0.004; SCALE,AR=20.0,0.035
        def flood(sx,sy):
            stack=[(sx,sy)];mx=Mx=sx;my=My=sy;n=0
            while stack:
                x,y=stack.pop()
                if x<0 or y<0 or x>=256 or y>=256: continue
                if visited[y,x] or wall[y,x]: continue
                visited[y,x]=True;n+=1
                mx=min(mx,x);Mx=max(Mx,x);my=min(my,y);My=max(My,y)
                stack+=[(x+1,y),(x-1,y),(x,y+1),(x,y-1)]
            return n,mx,Mx,my,My
        idx=0
        for y in range(256):
            for x in range(256):
                if not visited[y,x] and not wall[y,x]:
                    n,x0,x1,y0,y1=flood(x,y)
                    if n>=MIN:
                        cx=(x0+x1)/2;cy=(y0+y1)/2;w=x1-x0;h=y1-y0
                        rooms.append({"name":ROOM_NAMES[idx%len(ROOM_NAMES)],"label":f"R{idx+1}","x":round((cx/256-0.5)*SCALE*AR,4),"z":round((cy/256-0.5)*SCALE*AR,4),"w":round(w/256*SCALE*AR,4),"d":round(h/256*SCALE*AR,4),"area":round(w/256*SCALE*h/256*SCALE,1)})
                        idx+=1
        return {"walls":[],"rooms":rooms[:10],"source":"fallback","wallCount":0,"roomCount":len(rooms[:10])}
    except Exception as e:
        return {"error":str(e),"walls":[],"rooms":[]}

if __name__=="__main__":
    if len(sys.argv)<2: print(json.dumps({"error":"Usage: parse.py <image>"})); sys.exit(1)
    print(json.dumps(parse(sys.argv[1]),ensure_ascii=False))
