#!/usr/bin/env python3
"""Generate PWA icons for PDF Canvas using only Python built-in libraries."""

import struct
import zlib
import os


def make_png(width, height, pixels):
    """Create a PNG file from raw RGBA pixel data."""

    def chunk(chunk_type, data):
        c = chunk_type + data
        crc = struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
        return struct.pack(">I", len(data)) + c + crc

    # Signature
    sig = b"\x89PNG\r\n\x1a\n"

    # IHDR
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    ihdr = chunk(b"IHDR", ihdr_data)

    # IDAT - build raw image data with filter bytes
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter: None
        row_start = y * width * 4
        raw.extend(pixels[row_start : row_start + width * 4])

    compressed = zlib.compress(bytes(raw), 9)
    idat = chunk(b"IDAT", compressed)

    # IEND
    iend = chunk(b"IEND", b"")

    return sig + ihdr + idat + iend


def blend(bg, fg, alpha):
    """Alpha-blend fg over bg."""
    a = alpha / 255.0
    return int(bg * (1 - a) + fg * a)


def set_pixel(pixels, width, x, y, r, g, b, a=255):
    """Set a pixel with alpha blending."""
    if 0 <= x < width and 0 <= y < width:
        idx = (y * width + x) * 4
        if a < 255:
            old_r, old_g, old_b = pixels[idx], pixels[idx + 1], pixels[idx + 2]
            r = blend(old_r, r, a)
            g = blend(old_g, g, a)
            b = blend(old_b, b, a)
            a = 255
        pixels[idx] = r
        pixels[idx + 1] = g
        pixels[idx + 2] = b
        pixels[idx + 3] = a


def fill_rect(pixels, size, x1, y1, x2, y2, r, g, b, a=255):
    """Fill a rectangle."""
    for y in range(max(0, int(y1)), min(size, int(y2))):
        for x in range(max(0, int(x1)), min(size, int(x2))):
            set_pixel(pixels, size, x, y, r, g, b, a)


def fill_rounded_rect(pixels, size, x1, y1, x2, y2, radius, r, g, b, a=255):
    """Fill a rounded rectangle."""
    for y in range(max(0, int(y1)), min(size, int(y2))):
        for x in range(max(0, int(x1)), min(size, int(x2))):
            # Check corners
            draw = True
            corners = [
                (x1 + radius, y1 + radius),  # top-left
                (x2 - radius, y1 + radius),  # top-right
                (x1 + radius, y2 - radius),  # bottom-left
                (x2 - radius, y2 - radius),  # bottom-right
            ]
            for cx, cy in corners:
                # Determine if point is in corner region
                in_corner = False
                if x < x1 + radius and y < y1 + radius and cx == corners[0][0]:
                    in_corner = True
                elif x >= x2 - radius and y < y1 + radius and cx == corners[1][0]:
                    in_corner = True
                elif x < x1 + radius and y >= y2 - radius and cx == corners[2][0]:
                    in_corner = True
                elif x >= x2 - radius and y >= y2 - radius and cx == corners[3][0]:
                    in_corner = True

                if in_corner:
                    dx = x - cx
                    dy = y - cy
                    dist = (dx * dx + dy * dy) ** 0.5
                    if dist > radius:
                        draw = False
                        break
                    elif dist > radius - 1.5:
                        # Anti-alias the edge
                        edge_a = max(0, min(255, int((radius - dist) * 170)))
                        set_pixel(pixels, size, x, y, r, g, b, min(a, edge_a))
                        draw = False
                        break

            if draw:
                set_pixel(pixels, size, x, y, r, g, b, a)


def fill_triangle(pixels, size, x1, y1, x2, y2, x3, y3, r, g, b, a=255):
    """Fill a triangle using scanline."""
    min_y = max(0, int(min(y1, y2, y3)))
    max_y = min(size - 1, int(max(y1, y2, y3)))

    for y in range(min_y, max_y + 1):
        # Find intersections with triangle edges
        xs = []
        edges = [(x1, y1, x2, y2), (x2, y2, x3, y3), (x3, y3, x1, y1)]
        for ex1, ey1, ex2, ey2 in edges:
            if ey1 == ey2:
                continue
            if min(ey1, ey2) <= y <= max(ey1, ey2):
                t = (y - ey1) / (ey2 - ey1)
                ix = ex1 + t * (ex2 - ex1)
                xs.append(ix)
        if len(xs) >= 2:
            xs.sort()
            for x in range(max(0, int(xs[0])), min(size, int(xs[-1]) + 1)):
                set_pixel(pixels, size, x, y, r, g, b, a)


def draw_line(pixels, size, x1, y1, x2, y2, r, g, b, thickness=1, a=255):
    """Draw a line with given thickness."""
    dx = x2 - x1
    dy = y2 - y1
    length = max(1, (dx * dx + dy * dy) ** 0.5)
    steps = int(length * 2)

    half_t = thickness / 2.0
    for i in range(steps + 1):
        t = i / max(1, steps)
        cx = x1 + t * dx
        cy = y1 + t * dy
        for oy in range(int(-half_t - 1), int(half_t + 2)):
            for ox in range(int(-half_t - 1), int(half_t + 2)):
                dist = (ox * ox + oy * oy) ** 0.5
                if dist <= half_t:
                    px, py = int(cx + ox), int(cy + oy)
                    if dist > half_t - 1:
                        ea = int((half_t - dist) * 255)
                        set_pixel(pixels, size, px, py, r, g, b, min(a, max(0, ea)))
                    else:
                        set_pixel(pixels, size, px, py, r, g, b, a)


def generate_icon(size):
    """Generate the PDF Canvas icon at the given size."""
    pixels = bytearray(size * size * 4)

    # Scale factor relative to 512
    s = size / 512.0

    # Colors
    bg_r, bg_g, bg_b = 0x2D, 0x2D, 0x2D
    blue_r, blue_g, blue_b = 0x4A, 0x9E, 0xFF
    doc_r, doc_g, doc_b = 0xF0, 0xF0, 0xF0
    fold_r, fold_g, fold_b = 0xC8, 0xC8, 0xC8
    dark_r, dark_g, dark_b = 0x1A, 0x1A, 0x1A
    pencil_body_r, pencil_body_g, pencil_body_b = 0x4A, 0x9E, 0xFF
    pencil_tip_r, pencil_tip_g, pencil_tip_b = 0xFF, 0xCC, 0x44

    # Background rounded rectangle
    corner_r = int(80 * s)
    fill_rounded_rect(pixels, size, 0, 0, size, size, corner_r, bg_r, bg_g, bg_b)

    # Document body dimensions
    doc_left = int(110 * s)
    doc_top = int(70 * s)
    doc_right = int(340 * s)
    doc_bottom = int(430 * s)
    fold_size = int(55 * s)

    # Document body (white rectangle with folded corner cutout)
    # Draw the main document shape
    for y in range(int(doc_top), int(doc_bottom)):
        for x in range(int(doc_left), int(doc_right)):
            # Cut out the top-right corner for the fold
            if x >= doc_right - fold_size and y < doc_top + fold_size:
                # Check if we're in the triangle to cut
                fx = x - (doc_right - fold_size)
                fy = (doc_top + fold_size) - y
                if fx + fy > fold_size:
                    continue
            set_pixel(pixels, size, x, y, doc_r, doc_g, doc_b)

    # Folded corner triangle (darker shade)
    fold_x1 = doc_right - fold_size
    fold_y1 = doc_top
    fold_x2 = doc_right
    fold_y2 = doc_top + fold_size
    fill_triangle(
        pixels, size,
        fold_x1, fold_y2,
        fold_x1, fold_y1,
        fold_x2, fold_y2,
        fold_r, fold_g, fold_b,
    )

    # Shadow under fold
    fill_triangle(
        pixels, size,
        fold_x1, fold_y2,
        fold_x1 + int(3 * s), fold_y1 + int(3 * s),
        fold_x2 + int(3 * s), fold_y2,
        0x90, 0x90, 0x90, 80,
    )

    # Blue accent stripe across the document
    stripe_top = int(155 * s)
    stripe_bottom = int(200 * s)
    fill_rect(pixels, size, doc_left, stripe_top, doc_right - 1, stripe_bottom,
              blue_r, blue_g, blue_b)

    # "PDF" text on the blue stripe - drawn as simple block letters
    letter_h = int(30 * s)
    letter_w = int(18 * s)
    letter_gap = int(8 * s)
    letter_thick = max(int(5 * s), 2)
    text_start_x = int(doc_left + (doc_right - doc_left) / 2 - (letter_w * 3 + letter_gap * 2) / 2)
    text_y = int((stripe_top + stripe_bottom) / 2 - letter_h / 2)
    tr, tg, tb = 255, 255, 255  # white text

    # Letter P
    px = text_start_x
    py = text_y
    fill_rect(pixels, size, px, py, px + letter_thick, py + letter_h, tr, tg, tb)  # vertical
    fill_rect(pixels, size, px, py, px + letter_w, py + letter_thick, tr, tg, tb)  # top
    fill_rect(pixels, size, px + letter_w - letter_thick, py, px + letter_w, py + letter_h // 2 + letter_thick, tr, tg, tb)  # right
    fill_rect(pixels, size, px, py + letter_h // 2, px + letter_w, py + letter_h // 2 + letter_thick, tr, tg, tb)  # mid

    # Letter D
    dx = px + letter_w + letter_gap
    fill_rect(pixels, size, dx, py, dx + letter_thick, py + letter_h, tr, tg, tb)  # vertical
    fill_rect(pixels, size, dx, py, dx + letter_w - int(3 * s), py + letter_thick, tr, tg, tb)  # top
    fill_rect(pixels, size, dx, py + letter_h - letter_thick, dx + letter_w - int(3 * s), py + letter_h, tr, tg, tb)  # bottom
    fill_rect(pixels, size, dx + letter_w - letter_thick, py + int(3 * s), dx + letter_w, py + letter_h - int(3 * s), tr, tg, tb)  # right

    # Letter F
    fx = dx + letter_w + letter_gap
    fill_rect(pixels, size, fx, py, fx + letter_thick, py + letter_h, tr, tg, tb)  # vertical
    fill_rect(pixels, size, fx, py, fx + letter_w, py + letter_thick, tr, tg, tb)  # top
    fill_rect(pixels, size, fx, py + letter_h // 2, fx + letter_w - int(3 * s), py + letter_h // 2 + letter_thick, tr, tg, tb)  # mid

    # Content lines on the document (below the stripe)
    line_y_start = stripe_bottom + int(30 * s)
    line_height = int(18 * s)
    line_left = doc_left + int(20 * s)
    line_color = 0xAA

    for i in range(5):
        ly = line_y_start + i * (line_height + int(10 * s))
        if ly + int(6 * s) > doc_bottom - int(15 * s):
            break
        # Vary line lengths
        lengths = [0.85, 0.70, 0.90, 0.60, 0.75]
        lw = int((doc_right - doc_left - int(40 * s)) * lengths[i % len(lengths)])
        bar_h = max(int(5 * s), 2)
        fill_rounded_rect(
            pixels, size,
            line_left, ly, line_left + lw, ly + bar_h, max(int(2 * s), 1),
            line_color, line_color, line_color, 120,
        )

    # Pencil icon (bottom-right area, overlapping document corner)
    # The pencil is drawn at ~45 degrees
    pencil_cx = int(350 * s)
    pencil_cy = int(360 * s)
    pencil_len = int(130 * s)
    pencil_w = int(28 * s)

    # Pencil angle (45 degrees, pointing bottom-left to top-right)
    import math
    angle = math.radians(-45)
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)

    def rotate_point(px, py, cx, cy):
        dx = px - cx
        dy = py - cy
        return cx + dx * cos_a - dy * sin_a, cy + dx * sin_a + dy * cos_a

    # Pencil body (rotated rectangle)
    body_top = pencil_cy - pencil_len // 2
    body_bottom = pencil_cy + pencil_len // 2 - int(20 * s)
    body_left = pencil_cx - pencil_w // 2
    body_right = pencil_cx + pencil_w // 2

    # Draw rotated pencil by checking each pixel
    tip_start = body_bottom  # where the tip begins
    tip_end = pencil_cy + pencil_len // 2 + int(10 * s)
    eraser_end = body_top - int(5 * s)

    for y in range(max(0, int(pencil_cy - pencil_len * 0.8)), min(size, int(pencil_cy + pencil_len * 0.8))):
        for x in range(max(0, int(pencil_cx - pencil_len * 0.8)), min(size, int(pencil_cx + pencil_len * 0.8))):
            # Inverse rotate to pencil-local coords
            dx = x - pencil_cx
            dy = y - pencil_cy
            lx = dx * cos_a + dy * sin_a
            ly = -dx * sin_a + dy * cos_a

            hw = pencil_w / 2

            if abs(lx) <= hw:
                # Main body
                if -pencil_len / 2 <= ly <= pencil_len / 2 - int(20 * s):
                    # Pencil body - blue
                    set_pixel(pixels, size, x, y,
                              pencil_body_r, pencil_body_g, pencil_body_b)
                # Tip region (tapers to point)
                elif pencil_len / 2 - int(20 * s) < ly <= pencil_len / 2 + int(10 * s):
                    progress = (ly - (pencil_len / 2 - int(20 * s))) / (int(30 * s))
                    taper_hw = hw * (1 - progress)
                    if abs(lx) <= taper_hw:
                        if progress > 0.7:
                            # Pencil point
                            set_pixel(pixels, size, x, y,
                                      pencil_tip_r, pencil_tip_g, pencil_tip_b)
                        else:
                            # Wood/ferrule area
                            set_pixel(pixels, size, x, y, 0xDD, 0xAA, 0x66)
                # Eraser band
                elif -pencil_len / 2 - int(8 * s) <= ly < -pencil_len / 2:
                    set_pixel(pixels, size, x, y, 0xE0, 0x70, 0x70)

    # Pencil edge lines for definition
    edge_pts_left = []
    edge_pts_right = []
    for i in range(40):
        t = i / 39.0
        ly = -pencil_len / 2 + t * (pencil_len - int(20 * s))
        lx_l = -pencil_w / 2
        lx_r = pencil_w / 2
        wx_l, wy_l = rotate_point(pencil_cx + lx_l, pencil_cy + ly, pencil_cx, pencil_cy)
        wx_r, wy_r = rotate_point(pencil_cx + lx_r, pencil_cy + ly, pencil_cx, pencil_cy)
        edge_pts_left.append((wx_l, wy_l))
        edge_pts_right.append((wx_r, wy_r))

    for i in range(len(edge_pts_left) - 1):
        draw_line(pixels, size,
                  edge_pts_left[i][0], edge_pts_left[i][1],
                  edge_pts_left[i + 1][0], edge_pts_left[i + 1][1],
                  0x30, 0x70, 0xCC, max(int(2 * s), 1))
        draw_line(pixels, size,
                  edge_pts_right[i][0], edge_pts_right[i][1],
                  edge_pts_right[i + 1][0], edge_pts_right[i + 1][1],
                  0x30, 0x70, 0xCC, max(int(2 * s), 1))

    # Small shadow beneath the document for depth
    shadow_h = int(8 * s)
    for y in range(int(doc_bottom), int(doc_bottom + shadow_h)):
        alpha = int(60 * (1 - (y - doc_bottom) / shadow_h))
        for x in range(int(doc_left + 5 * s), int(doc_right + 3 * s)):
            set_pixel(pixels, size, x, y, 0, 0, 0, alpha)

    return make_png(size, size, bytes(pixels))


if __name__ == "__main__":
    script_dir = os.path.dirname(os.path.abspath(__file__))

    for sz in [192, 512]:
        data = generate_icon(sz)
        path = os.path.join(script_dir, f"icon-{sz}.png")
        with open(path, "wb") as f:
            f.write(data)
        print(f"Generated {path} ({len(data)} bytes)")
