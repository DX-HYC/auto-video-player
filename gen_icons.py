import zlib, struct, os

BG = (47, 129, 247)   # 蓝色
FG = (255, 255, 255)  # 白色

def write_png(path, size):
    # 顶点：A 上, B 下, C 右
    x0, x1 = 0.30 * size, 0.76 * size
    y0, y1, ym = 0.26 * size, 0.74 * size, 0.50 * size
    ax, ay = x0, y0
    bx, by = x0, y1
    cx, cy = x1, ym

    def side(px, py, qx, qy, rx, ry):
        return (qx - px) * (ry - py) - (qy - py) * (rx - px)

    rows = []
    for y in range(size):
        row = bytearray([0])  # filter type 0
        for x in range(size):
            d1 = side(ax, ay, bx, by, x, y)
            d2 = side(bx, by, cx, cy, x, y)
            d3 = side(cx, cy, ax, ay, x, y)
            neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
            pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
            inside = not (neg and pos)
            r, g, b = FG if inside else BG
            row += bytes((r, g, b, 255))
        rows.append(bytes(row))

    raw = b''.join(rows)

    def chunk(typ, data):
        c = struct.pack('>I', len(data)) + typ + data
        c += struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff)
        return c

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', ihdr)
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)

os.makedirs('icons', exist_ok=True)
for s in (16, 48, 128):
    write_png(os.path.join('icons', 'icon%d.png' % s), s)
print('icons generated')
