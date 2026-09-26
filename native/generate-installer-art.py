"""Génère les trois visuels de l'installateur Zaalis avec Pillow."""

from math import exp
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parent
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
            color = (int(42 + 48 * strength), int(43 + 46 * strength), int(67 + 92 * strength))
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)


def z_mask(width, height, left, top, size):
    points = [
        (0.08, 0.08), (0.94, 0.08), (0.94, 0.22),
        (0.30, 0.78), (0.94, 0.78), (0.94, 0.92),
        (0.07, 0.92), (0.07, 0.78), (0.70, 0.22), (0.08, 0.22),
    ]
    mask = Image.new("L", (width, height))
    ImageDraw.Draw(mask).polygon([(left + size * x, top + size * y) for x, y in points], fill=255)
    return mask


def draw_logo(image, left, top, size):
    mask = z_mask(*image.size, left, top, size)
    glow = Image.new("RGB", image.size, (99, 102, 241))
    image.paste(glow, (0, 0), mask.filter(ImageFilter.GaussianBlur(size * 0.16)).point(lambda p: p // 3))
    white = Image.new("RGB", image.size, (246, 247, 255))
    image.paste(white, (0, 0), mask)


def make_background():
    image = background(1192, 864, [
        (1050, 140, 430, (57, 44, 135), 1.0),
        (1070, 680, 410, (18, 55, 140), 0.72),
        (50, 760, 340, (43, 26, 86), 0.43),
    ])
    dotted_edges(image, 34, 2.1)
    draw = ImageDraw.Draw(image)
    draw.line((34, 0, 34, 864), fill=(39, 37, 66), width=2)
    draw.line((1158, 0, 1158, 864), fill=(31, 44, 83), width=2)
    image.save(ROOT / "wizard-background.png", optimize=True)


def make_welcome():
    image = background(492, 942, [
        (310, 460, 360, (70, 50, 168), 0.86),
        (120, 820, 330, (26, 73, 163), 0.55),
    ])
    dotted_edges(image, 29, 2.1)
    draw = ImageDraw.Draw(image)
    draw.line((491, 0, 491, 942), fill=(75, 70, 120), width=2)
    draw.rounded_rectangle((150, 170, 342, 211), radius=20, outline=(91, 88, 149), fill=(22, 22, 38), width=2)
    draw.ellipse((168, 184, 178, 194), fill=(129, 140, 248))
    draw.text((258, 190), "ZAALIS  /  IDE", anchor="mm", font=font(21, True), fill=(220, 221, 244))
    draw.text((246, 414), "Créez. Codez.", anchor="mm", font=font(43, True), fill=(250, 250, 252))
    draw.text((246, 474), "Allez plus loin.", anchor="mm", font=font(40, True), fill=(196, 198, 233))
    draw.line((207, 566, 285, 566), fill=(124, 128, 250), width=4)
    draw.text((246, 600), "VOTRE ESPACE DE TRAVAIL IA", anchor="mm", font=font(19, True), fill=(153, 157, 191))
    image.save(ROOT / "wizard-image.png", optimize=True)


def make_small():
    image = background(256, 256, [(128, 112, 160, (58, 47, 146), 0.78)])
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((18, 18, 238, 238), radius=48, fill=(22, 22, 33), outline=(72, 69, 116), width=3)
    draw_logo(image, 63, 63, 130)
    image.save(ROOT / "wizard-small.png", optimize=True)


if __name__ == "__main__":
    make_background()
    make_welcome()
    make_small()
