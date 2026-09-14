# -*- coding: utf-8 -*-
"""生成周笺的应用图标（纯标准库，无第三方依赖）。
输出：assets/icon.png (256)、assets/tray.png (32)、assets/icon.ico
"""
import os
import math
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")
OUT = os.path.abspath(OUT)

SS = 4  # 超采样倍率


# ───────────────────────── 几何工具 ─────────────────────────

def rrect(x, y, x0, y0, x1, y1, r):
    """圆角矩形覆盖（点到圆角矩形的距离判定）"""
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return math.hypot(x - cx, y - cy) <= r


def seg_dist(x, y, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = x - ax, y - ay
    L2 = vx * vx + vy * vy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L2))
    return math.hypot(wx - t * vx, wy - t * vy)


def mix(c1, c2, t):
    return tuple(c1[i] + (c2[i] - c1[i]) * t for i in range(3))


def over(dst, src, a):
    """src 以 alpha=a 覆盖到 dst（均为 (r,g,b,a)）"""
    sa = src[3] * a
    if sa <= 0:
        return dst
    da = dst[3]
    oa = sa + da * (1 - sa)
    if oa <= 0:
        return (0, 0, 0, 0)
    return tuple(
        (src[i] * sa + dst[i] * da * (1 - sa)) / oa for i in range(3)
    ) + (oa,)


# ───────────────────────── 图形 ─────────────────────────

AMBER_HI = (243, 193, 100)
AMBER_LO = (211, 145, 36)
WHITE = (255, 255, 255)
INK = (150, 100, 20)
GREEN = (34, 160, 107)


def sample(x, y, full=True):
    """在 0..256 坐标系采样一点的颜色，返回 (r,g,b,a) 各 0..1"""
    px = (0.0, 0.0, 0.0, 0.0)

    # 外层圆角方块 + 竖向渐变
    if rrect(x, y, 12, 12, 244, 244, 52):
        t = (y - 12) / 232.0
        t = max(0.0, min(1.0, t))
        c = mix(AMBER_HI, AMBER_LO, t)
        px = (c[0] / 255, c[1] / 255, c[2] / 255, 1.0)

    # 白色便签卡
    if rrect(x, y, 62, 78, 194, 200, 16):
        px = over(px, (1.0, 1.0, 1.0, 1.0), 0.97)

    # 卡片上的三条横线
    bar = (178 / 255, 118 / 255, 26 / 255, 1.0)
    for by, bx1 in ((106, 176), (134, 176), (162, 146)):
        if rrect(x, y, 80, by, bx1, by + 14, 7):
            px = over(px, bar, 0.85)

    if full:
        # 右下角绿色对勾
        # 先在卡片外沿画一个圆形底
        if math.hypot(x - 196, y - 196) <= 34:
            px = over(px, (1.0, 1.0, 1.0, 1.0), 0.98)
        if math.hypot(x - 196, y - 196) <= 28:
            g = (GREEN[0] / 255, GREEN[1] / 255, GREEN[2] / 255, 1.0)
            px = over(px, g, 1.0)
        # 对勾笔画
        for a, b in (((182, 196), (192, 207)), ((192, 207), (212, 184))):
            if seg_dist(x, y, a[0], a[1], b[0], b[1]) <= 4.6:
                px = over(px, (1.0, 1.0, 1.0, 1.0), 1.0)

    return px


def render(size, full=True):
    """返回 RGBA bytes，尺寸 size x size"""
    scale = 256.0 / size
    buf = bytearray(size * size * 4)
    step = 1.0 / SS
    wsum = 1.0 / (SS * SS)
    for py in range(size):
        for pxx in range(size):
            r = g = b = a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    x = (pxx + (sx + 0.5) * step) * scale
                    y = (py + (sy + 0.5) * step) * scale
                    c = sample(x, y, full)
                    r += c[0] * c[3]
                    g += c[1] * c[3]
                    b += c[2] * c[3]
                    a += c[3]
            i = (py * size + pxx) * 4
            if a > 1e-6:
                buf[i] = int(max(0, min(255, round(r / a * 255))))
                buf[i + 1] = int(max(0, min(255, round(g / a * 255))))
                buf[i + 2] = int(max(0, min(255, round(b / a * 255))))
                buf[i + 3] = int(max(0, min(255, round(a * wsum * 255))))
            else:
                buf[i + 3] = 0
    return bytes(buf)


def png(size, rgba):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))


def ico(entries):
    """entries: [(size, png_bytes), ...]；PNG 压缩的 ICO"""
    n = len(entries)
    header = struct.pack("<HHH", 0, 1, n)
    offset = 6 + 16 * n
    dirs = b""
    data = b""
    for size, blob in entries:
        w = 0 if size >= 256 else size
        h = 0 if size >= 256 else size
        dirs += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
        data += blob
    return header + dirs + data


def main():
    os.makedirs(OUT, exist_ok=True)

    print("渲染 256 …")
    png256 = png(256, render(256, full=True))
    with open(os.path.join(OUT, "icon.png"), "wb") as f:
        f.write(png256)

    print("渲染 32 托盘图标 …")
    png32 = png(32, render(32, full=False))
    with open(os.path.join(OUT, "tray.png"), "wb") as f:
        f.write(png32)

    print("渲染多尺寸 ico …")
    entries = [(256, png256)]
    for s in (128, 64, 48, 32, 16):
        entries.append((s, png(s, render(s, full=s >= 48))))
    with open(os.path.join(OUT, "icon.ico"), "wb") as f:
        f.write(ico(entries))

    for fn in ("icon.png", "tray.png", "icon.ico"):
        p = os.path.join(OUT, fn)
        print("  %-12s %8d bytes" % (fn, os.path.getsize(p)))


if __name__ == "__main__":
    main()
