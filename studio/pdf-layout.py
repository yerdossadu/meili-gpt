import json
import re
import sys

import pdfplumber


def color_hex(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        value = (value, value, value)
    if not isinstance(value, (tuple, list)) or len(value) < 3:
        return None
    channels = []
    for channel in value[:3]:
        try:
            number = float(channel)
        except (TypeError, ValueError):
            return None
        if number <= 1:
            number *= 255
        channels.append(max(0, min(255, round(number))))
    return "#" + "".join(f"{channel:02x}" for channel in channels)


def normalized_box(obj, width, height):
    x0 = float(obj.get("x0", 0))
    x1 = float(obj.get("x1", x0))
    top = float(obj.get("top", 0))
    bottom = float(obj.get("bottom", top))
    return {
        "x": round(x0 / width, 6),
        "y": round(top / height, 6),
        "width": round(max(0, x1 - x0) / width, 6),
        "height": round(max(0, bottom - top) / height, 6),
    }


def mode(values):
    values = [value for value in values if value not in (None, "")]
    if not values:
        return None
    return max(set(values), key=values.count)


def extract(path, page_number):
    with pdfplumber.open(path) as pdf:
        if page_number < 1 or page_number > len(pdf.pages):
            raise ValueError(f"PDF has {len(pdf.pages)} pages; requested {page_number}")
        page = pdf.pages[page_number - 1]
        width, height = float(page.width), float(page.height)
        lines = []
        for index, line in enumerate(page.extract_text_lines(strip=True, return_chars=True)):
            text = str(line.get("text", "")).strip()
            chars = line.get("chars") or []
            if not text or not chars:
                continue
            names = [str(char.get("fontname", "")) for char in chars]
            sizes = [float(char["size"]) for char in chars if char.get("size") is not None]
            colors = [color_hex(char.get("non_stroking_color")) for char in chars]
            box = {
                "x": round(float(line["x0"]) / width, 6),
                "y": round(float(line["top"]) / height, 6),
                "width": round((float(line["x1"]) - float(line["x0"])) / width, 6),
                "height": round((float(line["bottom"]) - float(line["top"])) / height, 6),
            }
            lines.append({
                "id": index,
                "text": text,
                "position": box,
                "fontName": mode(names),
                "fontSizePt": round(sorted(sizes)[len(sizes) // 2], 3) if sizes else None,
                "fontColor": mode(colors),
                "bold": bool(re.search(r"bold|semibold|demi", " ".join(names), re.I)),
                "italic": bool(re.search(r"italic|oblique", " ".join(names), re.I)),
            })

        background_colors = []
        shapes = []
        for rect in page.rects:
            box = normalized_box(rect, width, height)
            area = box["width"] * box["height"]
            fill = color_hex(rect.get("non_stroking_color"))
            if area > 0.55 and fill:
                background_colors.append(fill)
            if area <= 0.00001 or area > 0.55:
                continue
            stroke = color_hex(rect.get("stroking_color"))
            if fill or stroke:
                shapes.append({
                    "type": "rect",
                    "position": box,
                    "fill": fill,
                    "stroke": stroke,
                    "lineWidth": round(float(rect.get("linewidth") or 0), 3),
                })

        images = []
        for item in page.images:
            box = normalized_box(item, width, height)
            if box["width"] * box["height"] > 0.0005:
                images.append({"position": box, "widthPx": item.get("width"), "heightPx": item.get("height")})

        return {
            "pageNumber": page_number,
            "widthPt": width,
            "heightPt": height,
            "rotation": int(page.rotation or 0),
            "hasTextLayer": bool(lines),
            "pageBackground": mode(background_colors),
            "lines": lines,
            "shapes": shapes,
            "images": images,
        }


if __name__ == "__main__":
    try:
        print(json.dumps(extract(sys.argv[1], int(sys.argv[2])), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
