"""Temporary: crop the left half at 2.5x to identify the layout."""
from PIL import Image

SRC = r"C:\Users\dingj\.dsh\attachments\v1\objects\e7\e7b360e5efa34237cd074307019e27f0b379acbd6b2c7147e55bb4b96ca4bdc6"
OUT = r"E:\Project\DeepseekPlugin\dsh-hud-acl-recovery"
rgb = Image.open(SRC).convert("RGB")

for name, box, scale in [
    ("zoom-left-upper.png", (0, 38, 500, 300), 2),
    ("zoom-left-edge.png", (0, 80, 120, 300), 5),
]:
    part = rgb.crop(box)
    part = part.resize((part.width * scale, part.height * scale), Image.LANCZOS)
    part.save(f"{OUT}\\{name}")
    print("wrote", name, part.size, "box", box)

# Locate bright-text rows in the strip x 20..66 (left of the popup) and x 430..485 (right edge area)
def text_rows(x0, x1, y0, y1, thresh=150):
    rows = []
    for y in range(y0, y1):
        n = sum(1 for x in range(x0, x1) if max(rgb.getpixel((x, y))) > thresh)
        if n:
            rows.append((y, n))
    # collapse into bands
    bands = []
    for y, n in rows:
        if bands and y - bands[-1][1] <= 2:
            bands[-1][1] = y
            bands[-1][2] += n
        else:
            bands.append([y, y, n])
    return bands


print("bright rows x20-66 :", text_rows(20, 66, 80, 589))
print("bright rows x430-485:", text_rows(430, 485, 80, 420))
print("bright rows x70-490 (popup area):", text_rows(70, 490, 80, 300, thresh=190))