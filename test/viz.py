#!/usr/bin/env python3
"""Gera PNG comparativo (antes x depois) a partir dos arquivos de prévia do run.cjs."""
import sys, json, numpy as np
from PIL import Image


def shade(vol, nx, ny, nz, sx, sy, sz, yaw=0.0, thr=(-300 + 1024) / 8):
    # renderização por profundidade da isosuperfície vista de anterior, com rotação em z
    th = np.deg2rad(yaw)
    W = H = 360
    ext = max(nx * sx, ny * sy, nz * sz)
    us = np.linspace(-ext / 2, ext / 2, W)
    vs = np.linspace(ext / 2, -ext / 2, H)
    U, Vv = np.meshgrid(us, vs)
    cx, cy, cz = nx * sx / 2, ny * sy / 2, nz * sz / 2
    dirv = np.array([np.sin(th), np.cos(th), 0.0])  # raio de anterior para posterior
    right = np.array([np.cos(th), -np.sin(th), 0.0])
    depth = np.full(U.shape, np.nan)
    for t in np.arange(-ext / 2, ext / 2, 0.6):
        px = cx + U * right[0] + t * dirv[0]
        py = cy + U * right[1] + t * dirv[1]
        pz = cz + Vv
        ix = np.clip((px / sx).astype(int), 0, nx - 1); iy = np.clip((py / sy).astype(int), 0, ny - 1); iz = np.clip((pz / sz).astype(int), 0, nz - 1)
        inside = (px >= 0) & (px < nx * sx) & (py >= 0) & (py < ny * sy) & (pz >= 0) & (pz < nz * sz)
        v = vol[iz, iy, ix]
        hit = inside & (v >= thr) & np.isnan(depth)
        depth[hit] = t
    gy, gx = np.gradient(np.nan_to_num(depth, nan=ext), us[1] - us[0])
    n = np.stack([-gx, gy, -np.ones_like(gx)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    l = np.array([0.4, 0.5, -0.75]); l /= np.linalg.norm(l)
    c = np.clip((n * l).sum(-1), 0, 1) * 0.85 + 0.15
    img = (c * 235).astype(np.uint8)
    img[np.isnan(depth)] = 20
    return img


def main():
    d, code = sys.argv[1], sys.argv[2]
    meta = json.load(open(f'{d}/{code}_prev.json'))
    rows = []
    for yaw in (0, 35, 80):
        pair = []
        for k in ('before', 'after'):
            m = meta[k]
            vol = np.fromfile(f'{d}/{code}_{k}.u8', np.uint8).reshape(m['nz'], m['ny'], m['nx'])
            pair.append(shade(vol, m['nx'], m['ny'], m['nz'], m['sx'], m['sy'], m['sz'], yaw))
        rows.append(np.concatenate(pair, 1))
    Image.fromarray(np.concatenate(rows, 0)).save(f'{d}/{code}_cmp.png')
    print(f'{d}/{code}_cmp.png')


if __name__ == '__main__':
    main()
