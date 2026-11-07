#!/usr/bin/env python3
"""生成 Glance IDE 应用图标源图（1024x1024 RGBA PNG）。

输出 src-tauri/icons/app-icon.png，随后用 `npm run tauri -- icon` 生成全平台尺寸。
图标设计：深色圆角底 + 天蓝色终端提示符 ">" 与下划线（呼应终端/开发主题）。
"""

import struct
import sys
import zlib
from pathlib import Path

SIZE = 1024

BG = (24, 24, 27, 255)          # zinc-900 圆角底
BG_OUT = (0, 0, 0, 0)           # 圆角外透明
ACCENT = (56, 189, 248, 255)    # sky-400
BAR = (163, 163, 177, 255)      # zinc-400 下划线


def rounded_rect_mask(x: float, y: float, radius: float) -> bool:
    """SIZE x SIZE 画布上 radius 圆角矩形内部判定（留 8px 边距）。"""
    m = 8.0
    r = radius
    x0, y0, x1, y1 = m, m, SIZE - m, SIZE - m
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    # 四个圆角
    for cx, cy in ((x0 + r, y0 + r), (x1 - r, y0 + r), (x0 + r, y1 - r), (x1 - r, y1 - r)):
        in_corner_x = (x < x0 + r and cx == x0 + r) or (x > x1 - r and cx == x1 - r)
        in_corner_y = (y < y0 + r and cy == y0 + r) or (y > y1 - r and cy == y1 - r)
        if in_corner_x and in_corner_y:
            if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
                return False
    return True


def dist_to_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    t = max(0.0, min(1.0, (vx * wx + vy * wy) / (vx * vx + vy * vy)))
    dx, dy = px - (ax + t * vx), py - (ay + t * vy)
    return (dx * dx + dy * dy) ** 0.5


def render() -> bytes:
    half = SIZE / 2
    thickness = 56.0
    # 提示符 ">"：两段折线 (300,320) -> (520,512) -> (300,704)
    seg_a = (300, 320, 520, 512)
    seg_b = (520, 512, 300, 704)
    # 下划线：(580,704) -> (740,704)
    seg_c = (580, 704, 740, 704)

    rows = []
    for y in range(SIZE):
        row = bytearray([0])  # PNG filter: None
        for x in range(SIZE):
            inside = rounded_rect_mask(x + 0.5, y + 0.5, 220.0)
            if not inside:
                row += bytes(BG_OUT)
                continue
            color = BG
            d1 = dist_to_segment(x + 0.5, y + 0.5, *seg_a)
            d2 = dist_to_segment(x + 0.5, y + 0.5, *seg_b)
            d3 = dist_to_segment(x + 0.5, y + 0.5, *seg_c)
            if min(d1, d2, d3) <= thickness / 2:
                color = ACCENT if (x + 0.5) < half + 40 else BAR
            row += bytes(color)
        rows.append(bytes(row))
    return b"".join(rows)


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: Path) -> None:
    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(render(), 9))
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)
    print(f"已生成 {path} ({path.stat().st_size} 字节)")


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("src-tauri/icons/app-icon.png")
    write_png(out)
