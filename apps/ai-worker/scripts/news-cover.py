"""Compose three photo-based editorial cards with deterministic Korean typography."""
import base64
import io
import json
import os
import sys
from PIL import Image, ImageDraw, ImageFont, ImageOps

payload = json.load(sys.stdin)
image = ImageOps.exif_transpose(Image.open(io.BytesIO(base64.b64decode(payload['image'])))).convert('RGB')
crop = payload.get('crop')
if payload.get('index', 0) != 0 and crop is not None:
    left, top, right, bottom = crop
    if not (0 <= left < right <= 1 and 0 <= top < bottom <= 1
            and right - left >= 0.5 and bottom - top >= 0.5):
        raise ValueError('Invalid crop region')
    image = image.crop((round(left * image.width), round(top * image.height),
                        round(right * image.width), round(bottom * image.height)))

canvas = ImageOps.fit(image, (1080, 1350), Image.Resampling.LANCZOS, centering=(0.5, 0.5))
is_cover = payload.get('index', 0) == 0
shade = Image.new('RGBA', canvas.size)
shade_draw = ImageDraw.Draw(shade)
for y in range(1350):
    progress = max(0, min(1, (y - (470 if is_cover else 180)) / (880 if is_cover else 850)))
    alpha = round((235 if is_cover else 245) * progress)
    shade_draw.line((0, y, 1080, y), fill=(0, 0, 0, alpha))
canvas = Image.alpha_composite(canvas.convert('RGBA'), shade).convert('RGB')
font_path = os.environ.get('COVER_FONT_PATH', '/System/Library/Fonts/AppleSDGothicNeo.ttc')

def font(size, bold=False):
    return ImageFont.truetype(font_path, size, index=6 if bold and font_path.endswith('AppleSDGothicNeo.ttc') else 0)

def wrap(text, face, max_width):
    lines = []
    for paragraph in text.split('\n'):
        line = ''
        for char in paragraph:
            if face.getlength(line + char) > max_width:
                lines.append(line.rstrip())
                line = char.lstrip()
            else:
                line += char
        if line:
            lines.append(line)
    return lines

draw = ImageDraw.Draw(canvas)
headline_font = font(88 if is_cover else 74, True)
headline = wrap(payload['headline'], headline_font, 936)
if len(headline) > 4:
    raise ValueError('Headline exceeds safe title area')
line_height = 108 if is_cover else 92
body_text = ' '.join(payload.get('body', '').split())
for size in range(43, 32, -2):
    body_font = font(size)
    body = wrap(body_text, body_font, 936)
    body_line_height = round(size * 1.53)
    body_height = len(body) * body_line_height
    height = len(headline) * line_height + (46 + body_height if body else 0)
    if height <= 740:
        break
y = max(430, 1170 - height)
for line in headline:
    draw.text((64, y), line, font=headline_font, fill='white', stroke_width=1)
    y += line_height
if body:
    y += 46
    for line in body:
        draw.text((64, y), line, font=body_font, fill='#f0eeea')
        y += body_line_height
if y > 1210:
    raise ValueError('Card copy exceeds safe area')
small = font(25, True)
brand = 'THE OVERHEARD | PAPARAZZI'
draw.text(((1080 - small.getlength(brand)) / 2, 1266), brand, font=small, fill='white')
draw.text((942, 60), f"{payload.get('index', 0) + 1:02d} / {payload.get('total', 3):02d}", font=font(24), fill='white', stroke_width=1, stroke_fill='#333333')
canvas.save(sys.stdout.buffer, 'JPEG', quality=93)
