#!/usr/bin/env python3
"""Valida a saída do Deface CT: reabre todos os DICOM, compara pixels com a série original
e verifica cabeçalhos. Uso: validate.py entrada.zip saida.zip SERIE_DESC [--anon]"""
import sys, io, zipfile, json
import numpy as np
import pydicom


def load(zf, pred=None):
    out = []
    z = zipfile.ZipFile(zf)
    for n in z.namelist():
        if n.endswith('/'):
            continue
        ds = pydicom.dcmread(io.BytesIO(z.read(n)))
        if pred and not pred(ds):
            continue
        out.append(ds)
    return out


def main():
    inp, outp, desc = sys.argv[1:4]
    anon = '--anon' in sys.argv
    src = load(inp, lambda d: str(d.get('SeriesDescription', '')) == desc)
    dst = load(outp)
    res = {'n_src': len(src), 'n_out': len(dst)}
    assert len(src) == len(dst), 'número de cortes diferente'
    key = lambda d: float(d.ImagePositionPatient[2])
    src.sort(key=key); dst.sort(key=key)
    a = np.stack([d.pixel_array.astype(np.int32) * float(d.RescaleSlope) + float(d.RescaleIntercept) for d in src])
    b = np.stack([d.pixel_array.astype(np.int32) * float(d.RescaleSlope) + float(d.RescaleIntercept) for d in dst])
    ch = a != b
    res['changed'] = int(ch.sum())
    res['bone_changed'] = int((ch & (a > 250)).sum())
    zs = np.array([key(d) for d in src])
    res['z_range_changed_mm'] = [float(zs[np.where(ch.any((1, 2)))[0].min()]), float(zs[np.where(ch.any((1, 2)))[0].max()])] if ch.any() else None
    # metade posterior intacta (linhas posteriores ao centro)
    ny = a.shape[1]
    iop = [float(x) for x in src[0].ImageOrientationPatient]
    post = slice(ny // 2, ny) if iop[4] > 0 else slice(0, ny // 2)
    res['posterior_changed'] = int(ch[:, post, :].sum())
    # cabeçalhos
    uids_src = {d.SOPInstanceUID for d in src}
    res['sop_reused'] = len(uids_src & {d.SOPInstanceUID for d in dst})
    res['series_uids_out'] = len({d.SeriesInstanceUID for d in dst})
    d0 = dst[0]
    res['ts'] = str(d0.file_meta.TransferSyntaxUID)
    res['desc'] = str(d0.SeriesDescription)
    res['patient'] = str(d0.PatientName)
    res['pid'] = str(d0.PatientID)
    res['birth'] = str(d0.get('PatientBirthDate', '<removido>'))
    res['institution'] = str(d0.get('InstitutionName', '<removido>'))
    res['study_uid_same'] = d0.StudyInstanceUID == src[0].StudyInstanceUID
    res['identity_removed'] = str(d0.get('PatientIdentityRemoved', ''))
    res['dims_ok'] = all(d.Rows == s.Rows and d.Columns == s.Columns for d, s in zip(dst, src))
    if anon:
        assert res['birth'] == '<removido>' and res['institution'] == '<removido>' and not res['study_uid_same']
        assert 'SILVA' not in res['patient'] and res['identity_removed'] == 'YES'
    assert res['bone_changed'] == 0, 'osso alterado'
    assert res['posterior_changed'] == 0, 'metade posterior alterada'
    assert res['sop_reused'] == 0
    assert res['series_uids_out'] == 1
    assert res['dims_ok']
    print(json.dumps(res))


if __name__ == '__main__':
    main()
