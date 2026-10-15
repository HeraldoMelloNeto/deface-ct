// Agrupamento por estudo/série e escolha automática da série volumétrica:
// sem contraste > menor kernel > menor espaçamento > mais cortes.
import { TAG, getStr, getNum, getNums, getUS, findEl } from './dicom.js';

const CT_IMAGE = '1.2.840.10008.5.1.4.1.1.2';
const ENH_CT = '1.2.840.10008.5.1.4.1.1.2.1';

export function headerInfo(ds) {
  const it = getStr(ds, TAG.ImageType).toUpperCase();
  return {
    study: getStr(ds, TAG.StudyInstanceUID),
    series: getStr(ds, TAG.SeriesInstanceUID),
    sopClass: getStr(ds, TAG.SOPClassUID),
    modality: getStr(ds, TAG.Modality).toUpperCase(),
    imageType: it,
    frames: getNum(ds, TAG.NumberOfFrames, 1),
    rows: getUS(ds, TAG.Rows, 0), cols: getUS(ds, TAG.Columns, 0),
    ipp: getNums(ds, TAG.ImagePositionPatient),
    iop: getNums(ds, TAG.ImageOrientationPatient),
    ps: getNums(ds, TAG.PixelSpacing),
    thick: getNum(ds, TAG.SliceThickness, NaN),
    kernel: getStr(ds, TAG.ConvolutionKernel),
    contrastAgent: getStr(ds, TAG.ContrastBolusAgent),
    contrastRoute: getStr(ds, TAG.ContrastBolusRoute),
    contrastVolume: getNum(ds, TAG.ContrastBolusVolume, NaN),
    desc: getStr(ds, TAG.SeriesDescription),
    studyDesc: getStr(ds, TAG.StudyDescription),
    number: getNum(ds, TAG.SeriesNumber, NaN),
    instance: getNum(ds, TAG.InstanceNumber, NaN),
    accession: getStr(ds, TAG.AccessionNumber),
    patientName: getStr(ds, TAG.PatientName),
    patientID: getStr(ds, TAG.PatientID),
    birth: getStr(ds, TAG.PatientBirthDate),
    studyDate: getStr(ds, TAG.StudyDate),
    hasPixels: !!findEl(ds.elements, TAG.PixelData),
    ts: ds.ts,
  };
}

const NON_CONTRAST_RE = /(S\s*\/\s*C\b|\bSC\b|SEM\s*(CONTR|C\b)|S\/CONT|\bNC\b|N\/C|NON[\s-]*CON|NONCON|UNENHANC|W\/O|WITHOUT|PLAIN|NATIV|PRE[\s-]*CON|BASAL|\bSIN\s+CONT)/i;
const CONTRAST_RE = /(C\s*\+|\+\s*C\b|\bC\/C\b|COM\s*CONTR|CONTRAST|CONTRASTE|POS[\s-]*CON|P[OÓ]S[\s-]*CONT|POST[\s-]*CON|\bCE\b|ENHANC|W\/\s*C\b|WITH\s+CON|ARTER|VENOS|VENOUS|PORTAL|ANGIO|\bCTA\b|ANGIOTC|PERFUS|DELAY|TARDIA|IV\s*CONT|IODO)/i;

export function contrastStatus(info) {
  const agent = (info.contrastAgent || '').trim().toUpperCase();
  const agentNo = !agent || /^(NONE|NO|N|NAO|NÃO|SEM|NENHUM|0|-|NULL)$/.test(agent);
  const d = info.desc + ' ' + (info.studyDesc || '');
  if (!agentNo) return { contrast: true, why: 'agente: ' + info.contrastAgent };
  if (NON_CONTRAST_RE.test(info.desc)) return { contrast: false, why: 'descrição' };
  if (CONTRAST_RE.test(info.desc)) return { contrast: true, why: 'descrição' };
  if (Number.isFinite(info.contrastVolume) && info.contrastVolume > 0) return { contrast: true, why: 'volume de contraste' };
  if (info.contrastRoute && /IV|INTRA/i.test(info.contrastRoute)) return { contrast: true, why: 'via' };
  if (NON_CONTRAST_RE.test(d)) return { contrast: false, why: 'descrição do estudo' };
  return { contrast: false, why: 'sem indicação de contraste' };
}

// Valor numérico do kernel (filtro de reconstrução). Menor = mais suave.
const NAMED = [
  [/ULTRA\s*SOFT|SMOOTH/, 10], [/SOFT/, 20], [/STANDARD|STD|NORMAL/, 30], [/BRAIN|CEREBR|HEAD/, 30], [/DETAIL/, 45],
  [/CHEST|LUNG|PULM/, 60], [/BONE\s*PLUS|BONEPLUS/, 80], [/BONE|OSSO|OSSEO/, 70], [/EDGE|SHARP/, 90],
];
export function kernelValue(k) {
  if (!k) return { value: 50, label: '—' };
  const s = k.toUpperCase().replace(/\\/g, ' ').trim();
  const m = s.match(/(\d{2,3})/);
  if (m) return { value: parseInt(m[1], 10), label: k };
  for (const [re, v] of NAMED) if (re.test(s)) return { value: v, label: k };
  // Philips: letra única (A=mais suave ... E/L=mais duro)
  const mm = s.match(/^([A-Z])\b/);
  if (mm) return { value: 20 + (mm[1].charCodeAt(0) - 65) * 8, label: k };
  return { value: 50, label: k };
}

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

/** Avalia uma série: retorna {ok, reasons[], spacing, nslices, ...} */
export function evaluateSeries(slices) {
  const s0 = slices[0].info;
  const reasons = [];
  const out = { series: s0.series, desc: s0.desc, number: s0.number, kernel: s0.kernel, n: slices.length, ok: false, reasons, ts: s0.ts };
  out.kernelValue = kernelValue(s0.kernel).value;
  const cs = contrastStatus(s0); out.contrast = cs.contrast; out.contrastWhy = cs.why;
  if (s0.modality && s0.modality !== 'CT') { reasons.push('modality'); return out; }
  if (s0.sopClass === ENH_CT || s0.frames > 1) { reasons.push('multiframe'); return out; }
  if (/LOCALIZER|SCOUT|TOPO/.test(s0.imageType) || /SCOUT|TOPOGRAM|TOPOGRAMA|LOCALIZ|SURVIEW|SCANOGRAM/i.test(s0.desc)) { reasons.push('localizer'); return out; }
  if (/DERIVED.*(SECONDARY|REFORMAT|MPR|MIP|VR|3D)|\bMPR\b|\bMIP\b|\bVRT?\b|\b3D\b/i.test(s0.imageType + ' ' + s0.desc) && !/AXIAL/i.test(s0.imageType)) {
    // reconstruções derivadas não axiais são descartadas mais adiante pela orientação
  }
  if (!slices.every((s) => s.info.hasPixels)) { reasons.push('nopixels'); return out; }
  if (slices.length < 30) { reasons.push('few'); return out; }
  const iop = s0.iop;
  if (iop.length !== 6 || s0.ipp.length !== 3) { reasons.push('geometry'); return out; }
  const r = iop.slice(0, 3), c = iop.slice(3, 6), nrm = cross(r, c);
  if (Math.abs(nrm[2]) < Math.cos((35 * Math.PI) / 180)) { reasons.push('notaxial'); return out; }
  const rows = s0.rows, cols = s0.cols;
  for (const s of slices) {
    const i = s.info;
    if (i.rows !== rows || i.cols !== cols || i.iop.length !== 6 || i.ipp.length !== 3) { reasons.push('inconsistent'); return out; }
    for (let k = 0; k < 6; k++) if (Math.abs(i.iop[k] - iop[k]) > 1e-3) { reasons.push('inconsistent'); return out; }
  }
  const pos = slices.map((s) => dot(s.info.ipp, nrm)).sort((a, b) => a - b);
  const d = [];
  for (let k = 1; k < pos.length; k++) d.push(pos[k] - pos[k - 1]);
  const ds = d.slice().sort((a, b) => a - b);
  const med = ds[ds.length >> 1];
  if (!(med > 0.05)) { reasons.push('duplicates'); return out; }
  const irregular = d.filter((x) => Math.abs(x - med) > 0.25 * med).length;
  if (irregular > Math.max(2, d.length * 0.02)) { reasons.push('irregular'); return out; }
  out.spacing = med;
  if (med > 2.01) { reasons.push('thick'); return out; }
  const ps = s0.ps.length === 2 ? s0.ps : [NaN, NaN];
  if (!(ps[0] > 0 && ps[1] > 0)) { reasons.push('geometry'); return out; }
  out.ps = ps; out.rows = rows; out.cols = cols;
  out.extent = pos[pos.length - 1] - pos[0];
  if (out.extent < 50) { reasons.push('short'); return out; }
  out.ok = true;
  return out;
}

/** Agrupa cabeçalhos em estudos e escolhe a série de cada estudo. */
export function chooseSeries(headers) {
  const studies = new Map();
  for (const h of headers) {
    const key = h.info.study || 'sem-estudo';
    if (!studies.has(key)) studies.set(key, new Map());
    const sm = studies.get(key);
    const sk = h.info.series || 'sem-serie';
    if (!sm.has(sk)) sm.set(sk, []);
    sm.get(sk).push(h);
  }
  const result = [];
  for (const [study, sm] of studies) {
    const evals = [];
    for (const [, slices] of sm) evals.push({ ev: evaluateSeries(slices), slices });
    const ok = evals.filter((e) => e.ev.ok);
    const rank = (a, b) => (a.ev.contrast - b.ev.contrast) || (a.ev.kernelValue - b.ev.kernelValue) || (a.ev.spacing - b.ev.spacing) || (b.ev.n - a.ev.n);
    ok.sort(rank);
    result.push({
      study,
      candidates: evals.map((e) => e.ev),
      chosen: ok.length ? ok[0] : null,
      onlyContrast: ok.length > 0 && ok[0].ev.contrast,
      first: evals[0].slices[0].info,
    });
  }
  return result;
}
