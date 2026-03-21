#!/usr/bin/env python3
"""AVRA v3.1 — Floor Plan Parser (OpenCV + Pillow fallback)"""
import sys, json, math
import numpy as np

ROOM_NAMES = [
    'Obývacia izba','Kuchyňa','Spálňa','Detská izba',
    'Kúpeľňa','Chodba','Pracovňa','Jedáleň','WC','Šatník','Terasa','Balkón'
]

def parse(path):
    try:
        import cv2
        return parse_opencv(path, cv2)
    except ImportError:
        return parse_pillow(path)
    except Exception as e:
        return {"error": str(e), "rooms": [], "walls": [], "source": "error"}

def parse_opencv(path, cv2):
    img = cv2.imread(path)
    if img is None:
        return parse_pillow(path)  # fallback if imread fails (e.g. PDF)

    H, W = img.shape[:2]
    # Resize to max 1200px for consistent processing
    scale = min(1200/W, 1200/H, 1.0)
    if scale < 1.0:
        img = cv2.resize(img, (int(W*scale), int(H*scale)), interpolation=cv2.INTER_AREA)
        H, W = img.shape[:2]

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Adaptive threshold works better than global for varying scan quality
    # Try adaptive first, fall back to Otsu
    binary_adaptive = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 25, 8
    )
    _, binary_otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Use whichever gives more structure
    def count_wall_pixels(b): return np.sum(b > 0)
    binary = binary_adaptive if count_wall_pixels(binary_adaptive) > count_wall_pixels(binary_otsu)*0.5 else binary_otsu

    # Morphological cleanup
    k3 = np.ones((3,3), np.uint8)
    k5 = np.ones((5,5), np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, k3, iterations=2)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN,  k3, iterations=1)
    # Dilate walls slightly to close gaps
    binary = cv2.dilate(binary, k3, iterations=1)

    # Hough lines for wall detection
    edges = cv2.Canny(gray, 30, 100, apertureSize=3)
    lines = cv2.HoughLinesP(edges, 1, np.pi/180, 50,
        minLineLength=int(min(W,H)*0.04), maxLineGap=20)

    walls = []
    if lines is not None:
        for l in lines:
            x1,y1,x2,y2 = l[0]
            length = math.hypot(x2-x1, y2-y1)
            angle = math.degrees(math.atan2(y2-y1, x2-x1)) % 180
            is_h = angle < 15 or angle > 165
            is_v = 75 < angle < 105
            if not (is_h or is_v): continue
            walls.append({
                "x1":round(x1/W,4),"y1":round(y1/H,4),
                "x2":round(x2/W,4),"y2":round(y2/H,4),
                "type":"horizontal" if is_h else "vertical"
            })

    # Room detection via contours on inverted binary (rooms = light areas)
    room_mask = cv2.bitwise_not(binary)
    # Fill small holes in room mask
    room_mask = cv2.morphologyEx(room_mask, cv2.MORPH_CLOSE, k5, iterations=2)

    contours, hierarchy = cv2.findContours(room_mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)

    MIN_A = W * H * 0.004   # min 0.4% of image
    MAX_A = W * H * 0.75    # max 75% (exclude whole image)

    candidates = []
    for i, cnt in enumerate(contours):
        area = cv2.contourArea(cnt)
        if MIN_A < area < MAX_A:
            # Prefer non-child contours (outer rooms)
            is_child = hierarchy[0][i][3] >= 0 if hierarchy is not None else False
            if not is_child:
                candidates.append((area, cnt))

    candidates.sort(key=lambda x: -x[0])

    # AR world scale
    REAL_M = 20.0   # assume building is ~20m wide
    AR_SCALE = 0.035

    rooms = []
    for i, (area, cnt) in enumerate(candidates[:12]):
        bx, by, bw, bh = cv2.boundingRect(cnt)
        cx = (bx + bw/2) / W
        cy = (by + bh/2) / H

        # Convert to centered AR coordinates
        room_x = (cx - 0.5) * REAL_M * AR_SCALE
        room_z = (cy - 0.5) * REAL_M * AR_SCALE
        room_w = max(0.02, bw/W * REAL_M * AR_SCALE)
        room_d = max(0.02, bh/H * REAL_M * AR_SCALE)
        room_area = round((bw/W * REAL_M) * (bh/H * REAL_M), 1)

        rooms.append({
            "name":  ROOM_NAMES[i % len(ROOM_NAMES)],
            "label": f"R{i+1}",
            "x":     round(room_x, 4),
            "z":     round(room_z, 4),
            "w":     round(room_w, 4),
            "d":     round(room_d, 4),
            "area":  room_area
        })

    if not rooms:
        return {"rooms": [], "walls": walls, "source": "opencv",
                "roomCount": 0, "wallCount": len(walls),
                "message": "Žiadne miestnosti neboli detekované. Skúste čiernobiely pôdorys s tmavými stenami."}

    return {"rooms": rooms, "walls": walls, "source": "opencv",
            "roomCount": len(rooms), "wallCount": len(walls)}


def parse_pillow(path):
    """Pure numpy/Pillow fallback — no OpenCV needed"""
    try:
        from PIL import Image
        SIZE = 256
        img = Image.open(path).convert('L')
        img = img.resize((SIZE, SIZE), Image.LANCZOS)
        arr = np.array(img, dtype=np.float32)

        # Auto-detect threshold using Otsu's method in numpy
        hist, bins = np.histogram(arr.flatten(), 256, range=(0,256))
        total = arr.size
        best_thresh, best_var = 128, 0
        for t in range(1, 255):
            w0 = np.sum(hist[:t]) / total
            w1 = 1 - w0
            if w0 == 0 or w1 == 0: continue
            mu0 = np.sum(np.arange(t) * hist[:t]) / (w0*total + 1e-10)
            mu1 = np.sum(np.arange(t,256) * hist[t:]) / (w1*total + 1e-10)
            var = w0 * w1 * (mu0 - mu1)**2
            if var > best_var: best_var=var; best_thresh=t

        wall_mask = arr < best_thresh
        visited = np.zeros((SIZE, SIZE), dtype=bool)
        rooms = []
        MIN_PX = SIZE * SIZE * 0.004

        def flood(sx, sy):
            stack = [(sx, sy)]
            mn_x=mx_x=sx; mn_y=mx_y=sy; n=0
            while stack:
                x, y = stack.pop()
                if x<0 or y<0 or x>=SIZE or y>=SIZE: continue
                if visited[y,x] or wall_mask[y,x]: continue
                visited[y,x]=True; n+=1
                mn_x=min(mn_x,x); mx_x=max(mx_x,x)
                mn_y=min(mn_y,y); mx_y=max(mx_y,y)
                stack += [(x+1,y),(x-1,y),(x,y+1),(x,y-1)]
            return n, mn_x, mx_x, mn_y, mx_y

        REAL_M, AR = 20.0, 0.035
        idx = 0
        for y in range(SIZE):
            for x in range(SIZE):
                if not visited[y,x] and not wall_mask[y,x]:
                    n, x0, x1, y0, y1 = flood(x, y)
                    if n >= MIN_PX:
                        cx=(x0+x1)/2; cy=(y0+y1)/2
                        w=x1-x0; h=y1-y0
                        rooms.append({
                            "name": ROOM_NAMES[idx % len(ROOM_NAMES)],
                            "label": f"R{idx+1}",
                            "x": round((cx/SIZE-0.5)*REAL_M*AR, 4),
                            "z": round((cy/SIZE-0.5)*REAL_M*AR, 4),
                            "w": round(max(0.02, w/SIZE*REAL_M*AR), 4),
                            "d": round(max(0.02, h/SIZE*REAL_M*AR), 4),
                            "area": round(w/SIZE*REAL_M * h/SIZE*REAL_M, 1)
                        })
                        idx += 1

        rooms.sort(key=lambda r: -r['area'])
        rooms = rooms[:12]
        return {"rooms": rooms, "walls": [], "source": "pillow",
                "roomCount": len(rooms), "wallCount": 0}

    except Exception as e:
        return {"error": str(e), "rooms": [], "walls": [],
                "source": "error", "roomCount": 0, "wallCount": 0}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: parse.py <image_path>"}))
        sys.exit(1)
    result = parse(sys.argv[1])
    print(json.dumps(result, ensure_ascii=False))
