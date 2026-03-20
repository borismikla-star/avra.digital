#!/usr/bin/env python3
"""
AVRA — PDF Floor Plan Parser
Accepts a PDF path, returns JSON array of rooms with 3D coordinates.
Usage: python3 parse_floorplan.py <path_to_pdf>
"""
import sys
import json
import math

def parse_pdf(pdf_path):
    try:
        import pdfplumber
        from PIL import Image
        import numpy as np
    except ImportError as e:
        return {"error": f"Missing dependency: {e}. Run: pip3 install pdfplumber Pillow numpy"}

    try:
        with pdfplumber.open(pdf_path) as pdf:
            page = pdf.pages[0]
            objects = page.objects

            # Check if it's a raster image PDF
            if 'image' in objects and len(objects.get('image', [])) > 0:
                return parse_raster_pdf(pdf_path)
            else:
                return parse_vector_pdf(page)
    except Exception as e:
        return {"error": str(e)}


def parse_raster_pdf(pdf_path):
    """Parse raster/scanned floor plan using image analysis."""
    try:
        from pdf2image import convert_from_path
        from PIL import Image
        import numpy as np
    except ImportError:
        try:
            import pdfplumber
            with pdfplumber.open(pdf_path) as pdf:
                page = pdf.pages[0]
                img_data = page.objects['image'][0]
                stream = img_data.get('stream')
                if stream:
                    from PIL import Image
                    import io
                    img = Image.open(io.BytesIO(stream.get_data())).convert('L')
                else:
                    return {"error": "Cannot extract image from PDF"}
        except Exception as e:
            return {"error": f"Image extraction failed: {e}"}
    else:
        images = convert_from_path(pdf_path, dpi=150)
        img = images[0].convert('L')

    return segment_image(img)


def segment_image(img):
    """Segment floor plan image into room bounding boxes."""
    from PIL import Image
    import numpy as np

    SIZE = 256
    img_resized = img.resize((SIZE, SIZE), Image.LANCZOS)
    arr = np.array(img_resized)

    # Threshold: dark pixels = walls, light = rooms
    threshold = 160
    wall_mask = arr < threshold

    visited = np.zeros((SIZE, SIZE), dtype=bool)
    rooms = []

    ROOM_NAMES = [
        'Obývacia izba', 'Kuchyňa', 'Spálňa', 'Detská izba',
        'Kúpeľňa', 'Chodba', 'Pracovňa', 'Jedáleň',
        'WC', 'Šatník', 'Terasa', 'Balkón'
    ]
    name_idx = 0

    def flood_fill(sx, sy):
        stack = [(sx, sy)]
        pixels = []
        min_x, max_x = sx, sx
        min_y, max_y = sy, sy
        while stack:
            cx, cy = stack.pop()
            if cx < 0 or cy < 0 or cx >= SIZE or cy >= SIZE:
                continue
            if visited[cy, cx] or wall_mask[cy, cx]:
                continue
            visited[cy, cx] = True
            pixels.append((cx, cy))
            if cx < min_x: min_x = cx
            if cx > max_x: max_x = cx
            if cy < min_y: min_y = cy
            if cy > max_y: max_y = cy
            stack.extend([(cx+1,cy),(cx-1,cy),(cx,cy+1),(cx,cy-1)])
        return pixels, min_x, max_x, min_y, max_y

    # Building scale: assume floor plan covers ~20m x ~20m
    REAL_SIZE_M = 20.0
    SCALE_M = REAL_SIZE_M / SIZE
    AR_SCALE = 0.035  # 1m real = 0.035 AR units

    MIN_PIXELS = SIZE * SIZE * 0.003  # at least 0.3% of image

    for y in range(SIZE):
        for x in range(SIZE):
            if not visited[y, x] and not wall_mask[y, x]:
                pixels, min_x, max_x, min_y, max_y = flood_fill(x, y)
                if len(pixels) >= MIN_PIXELS:
                    cx = (min_x + max_x) / 2
                    cy = (min_y + max_y) / 2
                    w = max(2, max_x - min_x)
                    d = max(2, max_y - min_y)

                    # Convert to centered 3D AR coordinates
                    room_x = (cx / SIZE - 0.5) * REAL_SIZE_M * AR_SCALE
                    room_z = (cy / SIZE - 0.5) * REAL_SIZE_M * AR_SCALE
                    room_w = w / SIZE * REAL_SIZE_M * AR_SCALE
                    room_d = d / SIZE * REAL_SIZE_M * AR_SCALE
                    area = round((w * SCALE_M) * (d * SCALE_M), 1)

                    rooms.append({
                        "name": ROOM_NAMES[name_idx % len(ROOM_NAMES)],
                        "label": f"R{name_idx+1}",
                        "x": round(room_x, 4),
                        "z": round(room_z, 4),
                        "w": round(room_w, 4),
                        "d": round(room_d, 4),
                        "area": area
                    })
                    name_idx += 1

    # Sort by position (top-left to bottom-right)
    rooms.sort(key=lambda r: (round(r['z'], 1), round(r['x'], 1)))

    return {"rooms": rooms[:12], "source": "raster", "count": len(rooms[:12])}


def parse_vector_pdf(page):
    """Parse vector PDF with extractable text labels."""
    import re

    words = page.extract_words()
    room_labels = [w for w in words if re.match(r'^\d+\.\d+(\.\d+)?$', w['text'])]

    if not room_labels:
        return {"error": "No room labels found. Try uploading a cleaner floor plan image."}

    W, H = page.width, page.height
    REAL_W, REAL_H = 20.0, 20.0
    AR_SCALE = 0.035

    ROOM_TYPE_MAP = {
        'obývac': 'Obývacia izba', 'kuchyn': 'Kuchyňa', 'spálň': 'Spálňa',
        'kúpeľ': 'Kúpeľňa', 'chodb': 'Chodba', 'detsk': 'Detská izba',
        'pracoň': 'Pracovňa', 'jedál': 'Jedáleň', 'wc': 'WC',
        'šatník': 'Šatník', 'terasa': 'Terasa', 'balkón': 'Balkón'
    }

    rooms = []
    for label in room_labels:
        cx = (label['x0'] + label['x1']) / 2
        cy = (label['top'] + label['bottom']) / 2
        room_x = (cx / W - 0.5) * REAL_W * AR_SCALE
        room_z = (cy / H - 0.5) * REAL_H * AR_SCALE

        rooms.append({
            "name": "Miestnosť",
            "label": label['text'],
            "x": round(room_x, 4),
            "z": round(room_z, 4),
            "w": round(0.12, 4),
            "d": round(0.10, 4),
            "area": 12.0
        })

    return {"rooms": rooms, "source": "vector", "count": len(rooms)}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python3 parse_floorplan.py <pdf_path>"}))
        sys.exit(1)

    result = parse_pdf(sys.argv[1])
    print(json.dumps(result, ensure_ascii=False))
