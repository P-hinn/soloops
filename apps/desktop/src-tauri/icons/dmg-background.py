#!/usr/bin/env python3
"""The background of the install window.

What somebody sees first is a Finder window with two icons in it. Left the
app, right the Applications folder, and by default nothing else — no name, no
instruction, no indication that dragging is what is wanted.

This draws the rest of that window in the app's own colours: paper, ink, a
hairline, and the acid dot the interface uses as its mark. The two icon slots
stay empty, because the Finder draws into them; everything here sits around
them.

    python3 apps/desktop/src-tauri/icons/dmg-background.py

Writes `dmg-background.png` next to this file. Twice the size at 144 dpi, so
the Finder renders 660x400 points with a Retina display's pixels — the same
trick an @2x asset uses, expressed through the file's resolution because a
DMG background has no place for a second file.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# The window Tauri asks for, in points. Mirrored in tauri.conf.json — the two
# have to agree or the picture sits crooked behind the icons.
WIDTH, HEIGHT = 660, 400
SCALE = 2

# Where the Finder puts the two icons (tauri.conf.json again).
APP_X, APP_Y = 180, 170
FOLDER_X, FOLDER_Y = 480, 170
ICON = 128  # the icon size a DMG window uses

# `raised` rather than `paper`: what lies on top of the work surface — a
# card, a dialog, and an install window is one of those. It is also the
# closest the palette gets to the white the app icon carries as its own
# background, so the icon does not sit on the sheet as a bright patch.
RAISED = (251, 250, 247)
INK = (23, 23, 20)
SOFT = (87, 87, 80)
MUTED = (108, 107, 100)
ACID = (216, 255, 85)
LINE = (214, 211, 201)
ARROW = (176, 172, 158)

HELVETICA = '/System/Library/Fonts/HelveticaNeue.ttc'


def font(size: int, index: int = 0) -> ImageFont.FreeTypeFont:
    """Helvetica Neue, the interface's own sans. Index 0 is regular, 1 bold."""
    return ImageFont.truetype(HELVETICA, size * SCALE, index=index)


def centred(draw: ImageDraw.ImageDraw, text: str, y: int, f, fill) -> None:
    width = draw.textlength(text, font=f)
    draw.text(((WIDTH * SCALE - width) / 2, y * SCALE), text, font=f, fill=fill)


def arrow(draw: ImageDraw.ImageDraw) -> None:
    """From the app towards the folder, in the gap between the two icons."""
    y = APP_Y * SCALE
    start = (APP_X + ICON // 2 + 26) * SCALE
    end = (FOLDER_X - ICON // 2 - 26) * SCALE
    head = 9 * SCALE

    draw.line([(start, y), (end - head, y)], fill=ARROW, width=2 * SCALE)
    draw.polygon(
        [(end, y), (end - head, y - head * 0.6), (end - head, y + head * 0.6)],
        fill=ARROW,
    )


def main() -> None:
    image = Image.new('RGB', (WIDTH * SCALE, HEIGHT * SCALE), RAISED)
    draw = ImageDraw.Draw(image)

    # The word mark, with the dot the sidebar carries next to it.
    title = 'soloops'
    title_font = font(30, index=1)
    title_width = draw.textlength(title, font=title_font)
    left = (WIDTH * SCALE - title_width) / 2
    draw.text((left, 40 * SCALE), title, font=title_font, fill=INK)
    dot = 5 * SCALE
    draw.ellipse(
        [
            (left + title_width + 7 * SCALE, 46 * SCALE),
            (left + title_width + 7 * SCALE + dot, 46 * SCALE + dot),
        ],
        fill=ACID,
    )

    centred(draw, 'Das Betriebssystem für die Solo-Selbstständigkeit', 82, font(12), MUTED)

    arrow(draw)

    # Under the icons, where the Finder leaves room below the file names.
    centred(draw, 'In den Programme-Ordner ziehen', 276, font(13, index=1), INK)
    centred(
        draw,
        'Beim ersten Start: Rechtsklick auf soloops, dann Öffnen.',
        320,
        font(11),
        SOFT,
    )
    centred(
        draw,
        'Die App ist ad-hoc signiert, deshalb fragt macOS einmal nach.',
        338,
        font(11),
        MUTED,
    )

    target = Path(__file__).with_name('dmg-background.png')
    # 144 dpi: the Finder reads the resolution and lays the image out at half
    # its pixel size, which is what makes it sharp on a Retina display.
    image.save(target, dpi=(72 * SCALE, 72 * SCALE))
    print(f'{target} — {image.width}x{image.height} px, {WIDTH}x{HEIGHT} pt')


if __name__ == '__main__':
    main()
