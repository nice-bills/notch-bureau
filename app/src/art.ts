// Engraved stamp art as SVG strings (ported from the approved design, design/demos-opus/src/demo-3-post.src.html).
// Static, generated from numbers we format ourselves: never from user text.
export type Ink = 'verm' | 'ultra' | 'ochre' | 'sea';
const INK: Record<Ink, string> = { verm: '#D23F26', ultra: '#2B46C2', ochre: '#B97A14', sea: '#1C6E5C' };
const PAPER: Record<Ink, string> = { verm: '#FFF8F1', ultra: '#F6F7FF', ochre: '#FFFAEC', sea: '#F3FAF6' };
export type Motif = 'bank' | 'sun' | 'waves' | 'kente' | 'horn';

let n = 0;
/** A perforated sheet edge: circles masked out of every side. */
export function perf(W: number, H: number, r: number, step: number, body: string): string {
  const id = `pf${n++}`;
  let holes = '';
  const nx = Math.max(2, Math.round(W / step)), ny = Math.max(2, Math.round(H / step)), sx = W / nx, sy = H / ny;
  for (let i = 0; i < nx; i++) { const x = sx / 2 + i * sx; holes += `<circle cx="${x}" cy="0" r="${r}"/><circle cx="${x}" cy="${H}" r="${r}"/>`; }
  for (let i = 0; i < ny; i++) { const y = sy / 2 + i * sy; holes += `<circle cx="0" cy="${y}" r="${r}"/><circle cx="${W}" cy="${y}" r="${r}"/>`; }
  return `<defs><mask id="${id}"><rect width="${W}" height="${H}" fill="#fff"/><g fill="#000">${holes}</g></mask></defs><g mask="url(#${id})">${body}</g>`;
}

function motif(kind: Motif, cx: number, cy: number, s: number, ink: string): string {
  const g = (d: string) => `<g fill="none" stroke="${ink}" stroke-width="${1.1 * Math.max(0.7, s)}" stroke-linecap="round" stroke-linejoin="round">${d}</g>`;
  if (kind === 'bank') return g(`<path d="M${cx - 22 * s} ${cy - 6 * s}l${22 * s} ${-14 * s} ${22 * s} ${14 * s}z"/>${[-15, -5, 5, 15].map((x) => `<path d="M${cx + x * s} ${cy - 3 * s}v${20 * s}"/>`).join('')}<path d="M${cx - 24 * s} ${cy + 20 * s}h${48 * s}M${cx - 20 * s} ${cy + 24 * s}h${40 * s}"/>`);
  if (kind === 'sun') return g(`<circle cx="${cx}" cy="${cy}" r="${9 * s}"/>${Array.from({ length: 16 }, (_, i) => { const a = (i * Math.PI) / 8, r1 = 13 * s, r2 = (i % 2 ? 19 : 24) * s; return `<path d="M${cx + Math.cos(a) * r1} ${cy + Math.sin(a) * r1}L${cx + Math.cos(a) * r2} ${cy + Math.sin(a) * r2}"/>`; }).join('')}`);
  if (kind === 'waves') return g(Array.from({ length: 5 }, (_, i) => { const y = cy - 14 * s + i * 7 * s; return `<path d="M${cx - 24 * s} ${y}q${6 * s} ${-5 * s} ${12 * s} 0t${12 * s} 0t${12 * s} 0t${12 * s} 0"/>`; }).join(''));
  if (kind === 'kente') {
    const zig = (dy: number) => `M${cx - 24 * s} ${cy + dy}` + Array.from({ length: 4 }, () => `l${6 * s} ${-8 * s} ${6 * s} ${8 * s}`).join(' ');
    return g(`<path d="M${cx - 24 * s} ${cy - 12 * s}h${48 * s}M${cx - 24 * s} ${cy + 12 * s}h${48 * s}"/><path d="${zig(0)}"/><path d="${zig(6 * s)}" opacity=".45"/>`);
  }
  return g(`<path d="M${cx - 20 * s} ${cy + 2 * s}c0 ${-14 * s} ${22 * s} ${-16 * s} ${26 * s} ${-4 * s}c${3 * s} ${9 * s} ${-8 * s} ${14 * s} ${-14 * s} ${8 * s}c${-5 * s} ${-5 * s} 0 ${-12 * s} ${7 * s} ${-10 * s}"/><path d="M${cx + 6 * s} ${cy - 2 * s}l${16 * s} ${-10 * s}v${22 * s}z"/>`);
}

export function rosette(cx: number, cy: number, R: number, count: number, ink: string, op: number): string {
  let d = '';
  for (let i = 0; i < count; i++) d += `<ellipse cx="${cx}" cy="${cy}" rx="${R}" ry="${R * 0.38}" transform="rotate(${(i * 180) / count} ${cx} ${cy})"/>`;
  return `<g fill="none" stroke="${ink}" stroke-width=".6" opacity="${op}">${d}</g>`;
}

export interface StampOpts { ink?: Ink; foil?: boolean; num: string; cap: string; motif: Motif; numSize?: number; top?: string; rosette?: boolean; ms?: number }
export function stamp(W: number, H: number, o: StampOpts): string {
  const inkName = o.ink ?? 'ultra';
  const ink = o.foil ? '#fff' : INK[inkName], paper = o.foil ? 'url(#foil)' : PAPER[inkName], hat = o.foil ? 'foil' : inkName, k = W / 88, m = 7 * k;
  const iw = W - 2 * m, ih = H - 2 * m;
  const body = `<rect width="${W}" height="${H}" fill="#FFFDF8"/><rect x="${m}" y="${m}" width="${iw}" height="${ih}" fill="${paper}"/>
    <rect x="${m}" y="${m}" width="${iw}" height="${ih * 0.62}" fill="url(#hatch-${hat})" opacity=".55"/>${o.foil ? `<rect x="${m}" y="${m}" width="${iw}" height="${ih}" fill="url(#foilHi)"/>` : ''}
    ${o.rosette ? rosette(W / 2, m + ih * 0.32, iw * 0.46, 36, ink, o.foil ? 0.32 : 0.38) : ''}
    <rect x="${m + 3 * k}" y="${m + 3 * k}" width="${iw - 6 * k}" height="${ih - 6 * k}" fill="none" stroke="${ink}" stroke-width="${0.9 * k}"/>
    <rect x="${m + 5 * k}" y="${m + 5 * k}" width="${iw - 10 * k}" height="${ih - 10 * k}" fill="none" stroke="${ink}" stroke-width="${0.35 * k}"/>
    ${motif(o.motif, W / 2, m + ih * 0.34, k * (o.ms ?? 0.62), ink)}
    <text x="${m + 9 * k}" y="${H - m - 12 * k}" font-family="Instrument Serif" font-size="${(o.numSize ?? 30) * k}" fill="${ink}" letter-spacing="-.5">${o.num}</text>
    <text x="${W - m - 9 * k}" y="${H - m - 13 * k}" text-anchor="end" font-family="Inter Variable, Inter" font-weight="700" font-size="${5.2 * k}" letter-spacing="${0.9 * k}" fill="${ink}">${o.cap}</text>
    ${o.top ? `<text x="${W / 2}" y="${m + 13 * k}" text-anchor="middle" font-family="Inter Variable, Inter" font-weight="600" font-size="${4.4 * k}" letter-spacing="${1.4 * k}" fill="${ink}" opacity=".8">${o.top}</text>` : ''}`;
  return perf(W, H, 2.6 * k, 8 * k, body);
}

/** The home hero: the limit as an iridescent foil card. */
export function foilCard(amt: string, line1: string): string {
  const W = 342, H = 204, m = 10;
  const body = `<rect width="${W}" height="${H}" fill="#fff"/><rect x="${m}" y="${m}" width="${W - 2 * m}" height="${H - 2 * m}" fill="url(#foil)"/>
    <rect x="${m}" y="${m}" width="${W - 2 * m}" height="${H - 2 * m}" fill="url(#hatch-foil)" opacity=".5"/>
    ${rosette(W * 0.74, H * 0.46, H * 0.52, 48, '#fff', 0.3)}${rosette(W * 0.74, H * 0.46, H * 0.3, 36, '#fff', 0.26)}
    <rect x="${m}" y="${m}" width="${W - 2 * m}" height="${H - 2 * m}" fill="url(#foilHi)"/>
    <rect x="${m + 6}" y="${m + 6}" width="${W - 2 * m - 12}" height="${H - 2 * m - 12}" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width=".8"/>
    <text x="32" y="52" font-family="Inter Variable, Inter" font-weight="650" font-size="26" letter-spacing="-1" fill="#fff">notch</text>
    <text x="${W - 32}" y="46" text-anchor="end" font-family="Inter Variable, Inter" font-weight="600" font-size="9" letter-spacing="1.8" fill="#fff" opacity=".85">LIMIT STAMP</text>
    <text x="32" y="${H - 78}" font-family="Inter Variable, Inter" font-weight="600" font-size="9" letter-spacing="1.8" fill="#fff" opacity=".85">${line1}</text>
    <text x="32" y="${H - 30}" font-family="Instrument Serif" font-size="34" fill="#fff">${amt} <tspan font-family="Inter Variable, Inter" font-weight="600" font-size="12" letter-spacing="1.5">USDC</tspan></text>
    <text x="${W - 32}" y="${H - 30}" text-anchor="end" font-family="Inter Variable, Inter" font-weight="650" font-size="20" letter-spacing="-.5" fill="#fff" opacity=".95">credit</text>`;
  return perf(W, H, 4.2, 15, body);
}

/** The welcome envelope: par avion, a wax seal, and the limit stamp in the corner. */
export function envelope(): string {
  return `<defs><clipPath id="envc"><rect width="312" height="204" rx="8"/></clipPath></defs>
  <g clip-path="url(#envc)"><rect width="312" height="204" fill="url(#airmail)"/><rect x="10" y="10" width="292" height="184" rx="2" fill="#FFFDF8"/></g>
  <rect width="312" height="204" rx="8" fill="none" stroke="rgba(17,26,51,.08)"/>
  <text x="32" y="44" font-family="Inter Variable, Inter" font-weight="700" font-size="9" letter-spacing="2" fill="#2B46C2">PAR AVION · BY AIR MAIL</text>
  <text x="104" y="128" font-family="Inter Variable, Inter" font-weight="600" font-size="9" letter-spacing="1.6" fill="#5A6070">TO</text>
  <text x="104" y="150" font-family="Instrument Serif" font-style="italic" font-size="21" fill="#111A33">your.code@inbox.notch</text>
  <path d="M104 160h176M104 178h120" stroke="rgba(17,26,51,.14)"/>
  <g transform="translate(232 22) rotate(3 30 36)"><svg width="60" height="72" viewBox="0 0 88 104">${stamp(88, 104, { ink: 'ultra', num: '✓', cap: 'LIMIT', motif: 'bank', numSize: 28 })}</svg></g>
  <g transform="translate(40 116)"><path d="M28 2c6 0 9 3 14 4s9 5 10 11-1 9 0 14-3 10-9 13-9 2-14 4-11 0-16-3-7-7-9-12-1-9-1-14 4-10 9-13 10-4 16-4z" fill="#C8371F"/>
    <circle cx="28" cy="28" r="16" fill="none" stroke="#9E2A16" stroke-width="1.5"/><rect x="21" y="27" width="14" height="10" rx="2" fill="#9E2A16"/><path d="M24 27v-3a4 4 0 0 1 8 0v3" fill="none" stroke="#9E2A16" stroke-width="2"/></g>`;
}

/** Shared paint servers (foil, hatching, airmail stripes). Rendered once, hidden. */
export const FX_DEFS = `
  ${(['verm', 'ultra', 'ochre', 'sea'] as Ink[]).map((k) => `<pattern id="hatch-${k}" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0v4" stroke="${INK[k]}" stroke-width=".6" opacity=".35"/></pattern>`).join('')}
  <linearGradient id="foil" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9B88D6"/><stop offset=".38" stop-color="#B49AD8"/><stop offset=".62" stop-color="#9C86CC"/><stop offset=".82" stop-color="#8FA6E2"/><stop offset="1" stop-color="#7E6CC0"/></linearGradient>
  <radialGradient id="foilHi" cx=".25" cy=".1" r=".9"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></radialGradient>
  <pattern id="hatch-foil" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0v4" stroke="#fff" stroke-width=".5" opacity=".22"/></pattern>
  <pattern id="airmail" width="24" height="24" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="24" height="24" fill="#FFFDF8"/><rect width="7" height="24" fill="#D23F26"/><rect x="12" width="7" height="24" fill="#2B46C2"/></pattern>`;
