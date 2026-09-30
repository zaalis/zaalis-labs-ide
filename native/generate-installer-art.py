"""Génère les trois visuels de l'installateur Zaalis avec Pillow.

Palette sobre : un noir presque neutre, des gris, et une seule touche de violet
retenue. Le logo est celui de l'application (app.ico), pas un Z redessiné.
"""

from math import exp
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent
APP_ICON = ROOT / "app.ico"
FONT_REGULAR = r"C:\Windows\Fonts\segoeui.ttf"
FONT_BOLD = r"C:\Windows\Fonts\segoeuib.ttf"


def font(size, bold=False):
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REGULAR, size)


def background(width, height, glows):
    image = Image.new("RGB", (width, height))
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            color = [9, 9, 11]
            for cx, cy, radius, tint, opacity in glows:
                distance = ((x - cx) / radius) ** 2 + ((y - cy) / radius) ** 2
                strength = opacity * exp(-distance * 1.7)
                for channel in range(3):
                    color[channel] += int(tint[channel] * strength)
            pixels[x, y] = tuple(min(255, value) for value in color)
    return image


def dotted_edges(image, spacing, size):
    width, height = image.size
    draw = ImageDraw.Draw(image)
    for x in range(spacing // 2, width, spacing):
        for y in range(spacing // 2, height, spacing):
            edge = max(0, 1 - min(x, width - x) / (width * 0.3))
            vertical = 0.45 + 0.55 * abs(y - height / 2) / (height / 2)
            strength = edge * vertical
            if strength < 0.15:
                continue
            radius = size * (0.4 + 0.6 * strength)
            color = (int(34 + 26 * strength), int(34 + 26 * strength), int(40 + 34 * strength))
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)


def app_logo(size):
    """The application's own icon (its largest frame), resized with its alpha."""
    icon = Image.open(APP_ICON)
    icon.size = max(icon.info.get("sizes", [icon.size]))
    return icon.convert("RGBA").resize((size, size), Image.LANCZOS)


def draw_logo(image, left, top, size):
    logo = app_logo(size)
    image.paste(logo, (left, top), logo)


def make_background():
    image = background(1192, 864, [
        (1050, 160, 460, (34, 30, 58), 0.55),
    ])
    dotted_edges(image, 34, 2.1)
    draw = ImageDraw.Draw(image)
    draw.line((34, 0, 34, 864), fill=(32, 32, 38), width=2)
    draw.line((1158, 0, 1158, 864), fill=(32, 32, 38), width=2)
    image.save(ROOT / "wizard-background.png", optimize=True)


def make_welcome():
    image = background(492, 942, [
        (300, 440, 380, (36, 32, 64), 0.6),
    ])
    dotted_edges(image, 29, 2.1)
    draw = ImageDraw.Draw(image)
    draw.line((491, 0, 491, 942), fill=(36, 36, 44), width=2)
    draw.rounded_rectangle((150, 170, 342, 211), radius=20, outline=(62, 62, 74), fill=(18, 18, 22), width=2)
    draw.ellipse((168, 184, 178, 194), fill=(156, 148, 214))
    draw.text((258, 190), "ZAALIS  /  IDE", anchor="mm", font=font(21, True), fill=(214, 214, 222))
    draw.text((246, 414), "Créez. Codez.", anchor="mm", font=font(43, True), fill=(244, 244, 247))
    draw.text((246, 474), "Allez plus loin.", anchor="mm", font=font(40, True), fill=(170, 170, 184))
    draw.line((215, 566, 277, 566), fill=(120, 114, 170), width=3)
    draw.text((246, 600), "VOTRE ESPACE DE TRAVAIL IA", anchor="mm", font=font(19, True), fill=(128, 128, 142))
    image.save(ROOT / "wizard-image.png", optimize=True)


def make_small():
    image = background(256, 256, [])
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((18, 18, 238, 238), radius=48, fill=(20, 20, 24), outline=(56, 56, 66), width=3)
    draw_logo(image, 48, 48, 160)
    image.save(ROOT / "wizard-small.png", optimize=True)


if __name__ == "__main__":
    make_background()
    make_welcome()
    make_small()
