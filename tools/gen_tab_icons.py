# -*- coding: utf-8 -*-
# 纯 Python 生成 tabBar 图标（无第三方依赖），输出到 assets/tabs/
# 用法: python tools/gen_tab_icons.py
import os
import zlib
import struct

W = H = 81
NORMAL = (154, 149, 140, 255)   # #9a958c
ACTIVE = (58, 56, 53, 255)      # #3a3835
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'assets', 'tabs')


def new_img():
    return [[(0, 0, 0, 0)] * W for _ in range(H)]


def dot(img, cx, cy, r, color):
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy <= r * r:
                x, y = cx + dx, cy + dy
                if 0 <= x < W and 0 <= y < H:
                    img[y][x] = color


def line(img, x1, y1, x2, y2, color, r=3):
    steps = int(max(abs(x2 - x1), abs(y2 - y1))) * 2 + 1
    for i in range(steps + 1):
        t = i / steps
        dot(img, round(x1 + (x2 - x1) * t), round(y1 + (y2 - y1) * t), r, color)


def polyline(img, points, color, r=3, close=False):
    pts = list(points) + ([points[0]] if close else [])
    for i in range(len(pts) - 1):
        line(img, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], color, r)


def rect(img, x1, y1, x2, y2, color):
    for y in range(y1, y2 + 1):
        for x in range(x1, x2 + 1):
            img[y][x] = color


def draw_wardrobe(color):
    """T 恤轮廓"""
    img = new_img()
    polyline(img, [
        (12, 24), (30, 12), (40, 17), (51, 12), (69, 24),
        (60, 38), (52, 32), (52, 68), (29, 68), (29, 32), (21, 38)
    ], color, close=True)
    return img


def draw_outfits(color):
    """衣架"""
    img = new_img()
    polyline(img, [(38, 10), (43, 9), (46, 13), (44, 17), (40, 21)], color)  # 挂钩
    polyline(img, [(40, 21), (13, 52), (68, 52)], color, close=True)          # 三角架
    line(img, 22, 45, 59, 45, color)                                          # 下横杆
    return img


def draw_stats(color):
    """柱状图"""
    img = new_img()
    line(img, 10, 66, 71, 66, color)  # 基线
    rect(img, 18, 44, 28, 63, color)
    rect(img, 36, 32, 46, 63, color)
    rect(img, 54, 20, 64, 63, color)
    return img


def draw_profile(color):
    """用户头像"""
    img = new_img()
    dot(img, 40, 25, 11, color)
    polyline(img, [(17, 68), (19, 57), (27, 48), (40, 44),
                   (53, 48), (61, 57), (63, 68)], color)
    line(img, 17, 68, 63, 68, color)
    return img


def draw_assistant(color):
    """对话气泡 + 三点"""
    img = new_img()
    polyline(img, [
        (20, 22), (61, 22), (67, 28), (67, 52), (61, 58),
        (30, 58), (24, 66), (26, 58), (14, 58), (14, 28), (20, 22)
    ], color, close=True)
    for cx in (31, 40, 49):
        dot(img, cx, 38, 3, color)
    return img


def write_png(path, img):
    raw = b''.join(
        b'\x00' + b''.join(struct.pack('4B', *px) for px in row) for row in img
    )

    def chunk(typ, data):
        return (struct.pack('>I', len(data)) + typ + data +
                struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff))

    png = (b'\x89PNG\r\n\x1a\n' +
           chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0)) +
           chunk(b'IDAT', zlib.compress(raw)) +
           chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    icons = {
        'wardrobe': draw_wardrobe,
        'assistant': draw_assistant,
        'outfits': draw_outfits,
        'stats': draw_stats,
        'profile': draw_profile
    }
    for name, draw in icons.items():
        write_png(os.path.join(OUT_DIR, name + '.png'), draw(NORMAL))
        write_png(os.path.join(OUT_DIR, name + '-active.png'), draw(ACTIVE))
        print('generated', name)


if __name__ == '__main__':
    main()
