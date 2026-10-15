#!/usr/bin/env python3
"""Gera TC de crânio sintética (fantoma) em DICOM para testes do Deface CT.

Coordenadas LPS (mm): x direita->esquerda, y anterior->posterior, z inferior->superior.
A face tem olhos (globos, cristalino, gordura orbitária), nariz com ossos nasais e
via aérea, lábios, dentes, mandíbula e mento. Parâmetros de "identidade" variam com a seed.
"""
import argparse, os, zipfile, io
import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import (ExplicitVRLittleEndian, ImplicitVRLittleEndian, RLELossless,
                         JPEG2000Lossless, JPEGLSLossless, generate_uid, CTImageStorage)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def build(args):
    rng = np.random.default_rng(args.seed)
    idn = np.random.default_rng(args.face_seed)
    # traços de identidade
    nose_len = idn.uniform(30, 42); nose_prot = idn.uniform(14, 22); nose_w = idn.uniform(5, 8)
    eye_sep = idn.uniform(30, 36); eye_z = 15.0
    lip_prot = idn.uniform(4, 9); chin_prot = idn.uniform(3, 10); brow = idn.uniform(2, 6)
    face_w = idn.uniform(68, 78); head_ap = idn.uniform(90, 100)

    n = args.matrix; ps = args.fov / n
    xs = (np.arange(n) - n / 2 + 0.5) * ps
    ys = (np.arange(n) - n / 2 + 0.5) * ps - 8
    nz = int(round((args.ztop - args.zbot) / args.dz)) + 1
    zs = args.zbot + np.arange(nz) * args.dz
    X, Y = np.meshgrid(xs, ys)  # [row=y, col=x]
    slices = []
    for z in zs:
        hu = np.full((n, n), -1000.0)
        # contorno lateral/posterior do crânio (elipse em x,y que varia com z)
        zc = (z - 25) / 115.0
        k = np.sqrt(max(0.0, 1 - zc * zc))
        ax = face_w * k + 4; ay = head_ap * k
        # pescoço
        if z < -70:
            ax = 52; ay = 50
        yc = 12
        inside_lat = (X / max(ax, 1e-3)) ** 2 + ((Y - yc) / max(ay, 1e-3)) ** 2 <= 1
        # superfície anterior da face (profundidade y_front(x))
        base_front = yc - ay * np.sqrt(np.clip(1 - (X / max(ax, 1e-3)) ** 2, 0, 1))
        feat = np.zeros_like(X)
        # nariz
        zr, zt = eye_z - 5, eye_z - 5 - nose_len
        if zt - 9 < z < zr:
            if z >= zt:
                prof = nose_prot * ((zr - z) / (zr - zt)) ** 1.2
            else:
                prof = nose_prot * (1 - (zt - z) / 9.0)
            wid = nose_w + 0.35 * prof
            feat -= prof * np.exp(-0.5 * (X / wid) ** 2)
        # órbitas (recesso) e sobrancelhas
        for sx in (-1, 1):
            feat += 6 * np.exp(-0.5 * (((X - sx * eye_sep) / 13) ** 2 + ((z - eye_z) / 9) ** 2))
        feat -= brow * np.exp(-0.5 * ((z - (eye_z + 15)) / 5) ** 2) * np.exp(-0.5 * (X / 40) ** 2)
        # lábios, fenda labial, mento
        zl = eye_z - nose_len - 30
        feat -= lip_prot * np.exp(-0.5 * ((z - zl) / 7) ** 2) * np.exp(-0.5 * (X / 18) ** 2)
        feat += 2.5 * np.exp(-0.5 * ((z - (zl - 2)) / 1.2) ** 2) * np.exp(-0.5 * (X / 22) ** 2)
        feat -= chin_prot * np.exp(-0.5 * ((z - (zl - 32)) / 9) ** 2) * np.exp(-0.5 * (X / 20) ** 2)
        frontal = np.exp(-0.5 * (X / (ax * 0.55)) ** 2)  # traços só na região frontal
        y_front = base_front + feat * frontal * (1 if z > -95 else 0)
        head = (np.abs(X) < ax) & (Y >= y_front) & ((Y <= yc) | inside_lat)
        # orelhas (laterais, não são face)
        if abs(z - 10) < 25 and z > -60:
            for sx in (-1, 1):
                ear = ((X - sx * (ax + 6)) / 8) ** 2 + ((Y - 15) / 14) ** 2 + ((z - 10) / 25) ** 2 <= 1
                head |= ear
        d_front = Y - y_front  # profundidade a partir da pele anterior
        r_lat = np.sqrt((X / max(ax, 1e-3)) ** 2 + ((Y - yc) / max(ay, 1e-3)) ** 2)
        d_lat = (1 - r_lat) * min(ax, ay)  # distância aproximada da pele lateral/posterior
        depth = np.where(head, np.minimum(np.where(Y >= y_front, d_front, 0), np.maximum(d_lat, 0)), 0)
        soft = np.full((n, n), 40.0)
        soft = np.where(depth < 2.5, 55.0, soft)
        soft = np.where((depth >= 2.5) & (depth < 7), -95.0, soft)
        hu = np.where(head, soft, hu)
        cranial = z > eye_z + 2
        # calota
        if z > -20:
            sk = (depth > 7) & (depth < 14) & head & (z > eye_z - 10)
            hu = np.where(sk, 1250.0, hu)
            brain = head & (depth >= 14) & (z > eye_z - 25)
            hu = np.where(brain, 34.0, hu)
            vent = brain & ((X / 10) ** 2 + ((Y - 15) / 25) ** 2 < 1) & (z > 40) & (z < 75)
            hu = np.where(vent, 6.0, hu)
        # olhos
        for sx in (-1, 1):
            cx, cy = sx * eye_sep, base_front[np.argmin(abs(ys - 0)), np.argmin(abs(xs - sx * eye_sep))] + 18
            dz = z - eye_z
            r2 = (X - cx) ** 2 + (Y - cy) ** 2 + dz * dz
            fat = head & (r2 < 19 ** 2) & (Y > cy - 12)
            hu = np.where(fat, -85.0, hu)
            rim = head & (r2 >= 19 ** 2) & (r2 < 23 ** 2) & (Y > cy - 6)
            hu = np.where(rim, 1100.0, hu)
            glob = r2 < 11.5 ** 2
            hu = np.where(glob, 12.0, hu)
            lens = ((X - cx) / 4.5) ** 2 + ((Y - (cy - 8)) / 2) ** 2 + (dz / 4.5) ** 2 < 1
            hu = np.where(lens, 95.0, hu)
        # ossos da face: maxila/zigoma, ossos nasais, mandíbula, dentes
        if -60 < z < eye_z - 12:
            fb = head & (d_front > 11) & (d_front < 17) & (np.abs(X) > 12) & (np.abs(X) < ax * 0.8)
            hu = np.where(fb, 1000.0, hu)
        if eye_z - 20 < z < eye_z - 2:
            nb = head & (np.abs(X) < 6) & (d_front > 3) & (d_front < 6)
            hu = np.where(nb, 900.0, hu)
        if zl - 45 < z < zl - 8:
            md = head & (d_front > 9) & (d_front < 16) & (np.abs(X) < ax * 0.85)
            hu = np.where(md, 1300.0, hu)
        if zl - 8 <= z <= zl + 8:
            th = head & (d_front > 10) & (d_front < 17) & (np.abs(X) < 25)
            hu = np.where(th, 2400.0, hu)
        # via aérea nasal
        if zt - 2 < z < eye_z - 3:
            aw = head & (np.abs(X) < 9) & (d_front > 8 if z > zt + 6 else d_front > 3) & (Y < y_front.min() + 60)
            hu = np.where(aw & (hu < 300), -1000.0, hu)
        # mesa (componente separado, posterior)
        tb = (Y > 104) & (Y < 111) & (np.abs(X) < 110)
        hu = np.where(tb, 150.0, hu)
        if args.contrast:
            vess = head & cranial & ((((X - 20) ** 2 + (Y - 30) ** 2) < 16) | (((X + 20) ** 2 + (Y - 30) ** 2) < 16))
            hu = np.where(vess, 280.0, hu)
            hu = np.where(head & (hu > 20) & (hu < 60), hu + 8, hu)
        noise = rng.normal(0, 10 if args.kernel_soft else 22, size=(n, n))
        hu = hu + np.where(hu < -900, noise * 0.6, noise)
        slices.append(np.clip(np.round(hu), -1024, 3071).astype(np.int16))
    return zs, slices, ps


def write_series(args, zs, slices, ps, out_files, study_uid, series_number, descr, kernel, contrast, ts, signed, flip_rows=False, localizer=False, thickness=None, patient=None):
    series_uid = generate_uid(); for_uid = generate_uid()
    patient = patient or {}
    for i, (z, img) in enumerate(zip(zs, slices)):
        ds = Dataset()
        fm = FileMetaDataset(); fm.MediaStorageSOPClassUID = CTImageStorage
        sop = generate_uid(); fm.MediaStorageSOPInstanceUID = sop; fm.TransferSyntaxUID = ExplicitVRLittleEndian
        ds.file_meta = fm
        ds.SOPClassUID = CTImageStorage; ds.SOPInstanceUID = sop
        ds.ImageType = ['ORIGINAL', 'PRIMARY', 'LOCALIZER' if localizer else 'AXIAL']
        ds.Modality = 'CT'; ds.PatientName = patient.get('name', 'SILVA^JOAO^TESTE'); ds.PatientID = patient.get('id', '123456')
        ds.PatientBirthDate = '19600101'; ds.PatientSex = 'M'; ds.AccessionNumber = patient.get('acc', 'ACC9988')
        ds.StudyDate = '20261001'; ds.StudyTime = '101010'; ds.InstitutionName = 'HOSPITAL FICTICIO'
        ds.ReferringPhysicianName = 'DR^FULANO'; ds.StudyInstanceUID = study_uid; ds.SeriesInstanceUID = series_uid
        ds.FrameOfReferenceUID = for_uid; ds.SeriesNumber = series_number; ds.InstanceNumber = i + 1
        ds.SeriesDescription = descr; ds.StudyDescription = 'TC CRANIO'
        if kernel: ds.ConvolutionKernel = kernel
        if contrast: ds.ContrastBolusAgent = 'IOPAMIDOL'
        ds.SliceThickness = thickness if thickness is not None else args.dz
        ds.ImagePositionPatient = [-args.fov / 2 + ps / 2, -args.fov / 2 + ps / 2 - 8 + (0 if not flip_rows else 0), float(z)]
        if flip_rows:
            # linhas de posterior para anterior (cosseno de coluna -y)
            ds.ImageOrientationPatient = [1, 0, 0, 0, -1, 0]
            ds.ImagePositionPatient = [-args.fov / 2 + ps / 2, args.fov / 2 - ps / 2 - 8, float(z)]
            img = img[::-1, :]
        else:
            ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.PixelSpacing = [ps, ps]
        ds.Rows, ds.Columns = img.shape
        ds.SamplesPerPixel = 1; ds.PhotometricInterpretation = 'MONOCHROME2'
        ds.BitsAllocated = 16; ds.BitsStored = 12 if not signed else 16; ds.HighBit = ds.BitsStored - 1
        ds.PixelRepresentation = 1 if signed else 0
        if signed:
            ds.RescaleIntercept = 0; ds.RescaleSlope = 1; arr = img.astype(np.int16)
        else:
            ds.RescaleIntercept = -1024; ds.RescaleSlope = 1; arr = (img.astype(np.int32) + 1024).clip(0, 4095).astype(np.uint16)
        ds.PixelData = arr.tobytes()
        if ts == 'implicit':
            ds.file_meta.TransferSyntaxUID = ImplicitVRLittleEndian
        elif ts == 'rle':
            ds.compress(RLELossless, arr)
        elif ts == 'j2k':
            ds.compress(JPEG2000Lossless, arr)
        elif ts == 'jls':
            ds.compress(JPEGLSLossless, arr)
        bio = io.BytesIO()
        ds.save_as(bio, enforce_file_format=True, implicit_vr=(ts == 'implicit'), little_endian=True)
        out_files.append((f'S{series_number:03d}/IM{i + 1:04d}.dcm', bio.getvalue()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--matrix', type=int, default=256)
    ap.add_argument('--fov', type=float, default=240)
    ap.add_argument('--dz', type=float, default=1.0)
    ap.add_argument('--zbot', type=float, default=-110)
    ap.add_argument('--ztop', type=float, default=130)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--face-seed', type=int, default=7)
    ap.add_argument('--ts', default='explicit')
    ap.add_argument('--signed', action='store_true')
    ap.add_argument('--flip', action='store_true')
    ap.add_argument('--multi', action='store_true', help='scout + 5mm + osso + contraste + partes moles')
    ap.add_argument('--contrast-only', action='store_true')
    ap.add_argument('--name', default='SILVA^JOAO^TESTE')
    ap.add_argument('--acc', default='ACC9988')
    args = ap.parse_args()
    args.contrast = False; args.kernel_soft = True
    study = generate_uid(); files = []
    pat = {'name': args.name, 'id': '9' + str(args.face_seed).zfill(5), 'acc': args.acc}
    if args.contrast_only:
        args.contrast = True
        zs, sl, ps = build(args)
        write_series(args, zs, sl, ps, files, study, 4, 'CRANIO C+ 1.0 J30s', 'J30s', True, args.ts, args.signed, args.flip, patient=pat)
    else:
        zs, sl, ps = build(args)
        write_series(args, zs, sl, ps, files, study, 2, 'CRANIO S/C 1.0 J30s', 'J30s', False, args.ts, args.signed, args.flip, patient=pat)
    if args.multi:
        # scout
        write_series(args, zs[:1], sl[:1], ps, files, study, 1, 'TOPOGRAMA', 'T20f', False, 'explicit', args.signed, localizer=True, patient=pat)
        # 5 mm não volumétrica
        idx = list(range(0, len(zs), 5))
        write_series(args, [zs[i] for i in idx], [sl[i] for i in idx], ps, files, study, 3, 'CRANIO S/C 5mm', 'J30s', False, 'explicit', args.signed, thickness=5.0, patient=pat)
        # janela óssea (kernel mais alto)
        args.kernel_soft = False
        zs2, sl2, _ = build(args)
        write_series(args, zs2, sl2, ps, files, study, 5, 'CRANIO S/C OSSO 1.0 H70h', 'H70h', False, args.ts, args.signed, patient=pat)
        # contraste com kernel baixo (não deve ser escolhida)
        args.kernel_soft = True; args.contrast = True
        zs3, sl3, _ = build(args)
        write_series(args, zs3, sl3, ps, files, study, 6, 'CRANIO C+ 1.0 J20s', 'J20s', True, args.ts, args.signed, patient=pat)
    with zipfile.ZipFile(args.out, 'w', zipfile.ZIP_DEFLATED, compresslevel=1) as z:
        for name, data in files:
            z.writestr(name, data)
    print(args.out, len(files), 'arquivos')


if __name__ == '__main__':
    main()
