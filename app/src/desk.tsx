// Wide screens (a laptop or a desktop): the same app, laid out for the room. Phones never take these paths.
// One media query decides it, read before the first paint so nothing jumps.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { stamp, type Ink, type Motif } from './art';

const WIDE = '(min-width: 1024px)';
const mq = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(WIDE) : null);
const subscribe = (f: () => void) => {
  const m = mq();
  m?.addEventListener('change', f);
  return () => m?.removeEventListener('change', f);
};
/** True on a screen at least 1024px wide. */
export const useDesk = () => useSyncExternalStore(subscribe, () => !!mq()?.matches, () => false);

/** The page address without the screen part (#lend), for the phone to open. */
const pageUrl = () => `${location.origin}${location.pathname}`;

/** "Best on your phone": a QR code of this page, made here (no outside service), drawn as one SVG path. */
export function PhoneQr() {
  const [path, setPath] = useState<{ d: string; n: number } | null>(null);
  useEffect(() => {
    let dead = false;
    import('uqr').then(({ encode }) => {
      if (dead) return;
      const { data, size } = encode(pageUrl(), { ecc: 'M', border: 0 });
      let d = '';
      data.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x} ${y}h1v1h-1z`; }));
      setPath({ d, n: size });
    }).catch(() => { /* no code: the card still says where to go */ });
    return () => { dead = true; };
  }, []);
  return (
    <aside className="desk-qr" aria-label="Open Notch on your phone">
      <span className="qr-box">
        {path ? (
          <svg viewBox={`-1 -1 ${path.n + 2} ${path.n + 2}`} role="img" aria-label={`QR code for ${pageUrl()}`} shapeRendering="crispEdges"><path d={path.d} /></svg>
        ) : <span className="qr-skel" aria-hidden="true" />}
      </span>
      <span className="qr-t">
        <b>Best on your phone</b>
        <small>Scan with your camera to open Notch there.</small>
      </span>
    </aside>
  );
}

/** A few stamps resting on the desk around the column: the postal theme, quietly. Decorative only. */
const DECO: { ink: Ink; motif: Motif; num: string; cap: string; cls: string }[] = [
  { ink: 'ultra', motif: 'bank', num: '10', cap: 'ACCRA', cls: 'd1' },
  { ink: 'ochre', motif: 'sun', num: '5', cap: 'GHANA', cls: 'd2' },
  { ink: 'sea', motif: 'waves', num: '2', cap: 'AIRMAIL', cls: 'd3' },
  { ink: 'verm', motif: 'kente', num: '20', cap: 'NOTCH', cls: 'd4' },
];
export function DeskDeco() {
  const art = useMemo(() => DECO.map((d) => ({ ...d, svg: stamp(88, 104, d) })), []);
  return (
    <div className="desk-deco" aria-hidden="true">
      {art.map((d) => <svg key={d.cls} className={d.cls} viewBox="0 0 88 104" dangerouslySetInnerHTML={{ __html: d.svg }} />)}
    </div>
  );
}
