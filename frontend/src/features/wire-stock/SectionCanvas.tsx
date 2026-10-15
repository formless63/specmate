import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { renderSectionSvg } from '../../../../packages/section-layout/src';
import type { Section } from '../../../../packages/section-layout/src';
import { clientToMm, frameSection, nudgeOd, odFromPoint, withViewBox } from './builder-visual';
import type { ViewBox } from './builder-visual';
import type { OverlayShapes } from './builder-visual';

const circlePath = (cx: number, cy: number, r: number): string => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;

export interface JacketHandle { od: number; minOd: number }

/**
 * The large live cross-section. The stock drawing comes from the shared section renderer;
 * an overlay with the same view box draws fit findings (dashed bore, hatched interference,
 * ringed offenders, callouts) and the draggable jacket-edge handle. Nothing here computes
 * placement or fit.
 */
export function SectionCanvas({ section, title, label = 'Stock section drawing', selected, onSelect, overlay, handle, editable, onOd }: {
  section: Section; title: string; label?: string; selected?: string | null; onSelect?: (path: string | null) => void;
  overlay?: OverlayShapes; handle?: JacketHandle | null; editable: boolean; onOd?: (od: number) => void;
}) {
  const id = useId().replace(/:/g, '');
  // The frame is fixed while a drag is in progress, so the handle stays under the pointer as the jacket grows.
  const [frozen, setFrozen] = useState<ViewBox | null>(null);
  const framed = useMemo(() => frameSection(section, handle ? handle.od / 2 : 0), [section, handle]);
  const vb = frozen ?? framed;
  const svg = useMemo(() => withViewBox(renderSectionSvg(section, title, { selected }), vb), [section, title, selected, vb]);
  const overlayRef = useRef<SVGSVGElement>(null);
  const dragging = frozen !== null;
  const u = vb.w / 100;
  const big = Math.max(vb.w, vb.h) * 4;

  useEffect(() => {
    if (!dragging || !handle || !onOd) return;
    const move = (event: PointerEvent) => {
      const box = overlayRef.current?.getBoundingClientRect(); if (!box) return;
      const at = clientToMm(box, vb, event.clientX, event.clientY);
      onOd(odFromPoint(at.x, at.y, handle.minOd));
    };
    const stop = () => setFrozen(null);
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); };
  }, [dragging, handle, onOd, vb]);

  const interactive = editable && handle && onOd;
  return <div className="sb-stock-canvas" style={{ aspectRatio: `${vb.w} / ${vb.h}` }} data-dragging={dragging || undefined}>
    <div aria-label={label} className="sb-viewer sb-stock-canvas__drawing" style={{ color: 'var(--sb-text-primary)' }}
      onClick={event => { const hit = (event.target as Element).closest('[data-element]'); if (hit) onSelect?.(hit.getAttribute('data-element')); }}
      dangerouslySetInnerHTML={{ __html: svg }} />
    <svg ref={overlayRef} className="sb-stock-canvas__overlay" viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} aria-label="Fit findings and jacket handle" data-overlay>
      <defs>
        <pattern id={`${id}-hatch`} width={u * 1.4} height={u * 1.4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2={u * 1.4} stroke="var(--sb-invalid)" strokeWidth={u * 0.45} />
        </pattern>
        {overlay?.bands.map((band, i) => band.bore && <clipPath key={i} id={`${id}-out${i}`}>
          <path clipRule="evenodd" d={`M${-big} ${-big}H${big}V${big}H${-big}Z${circlePath(band.bore.cx, band.bore.cy, band.bore.r)}`} />
        </clipPath>)}
      </defs>
      {overlay?.bands.map((band, i) => band.bore && <circle key={`band${i}`} data-fit-band={band.path} cx={band.offender.cx} cy={band.offender.cy} r={band.offender.r}
        fill={`url(#${id}-hatch)`} clipPath={`url(#${id}-out${i})`} />)}
      {overlay?.bores.map(b => <circle key={`bore${b.path}`} data-fit-bore={b.path} cx={b.cx} cy={b.cy} r={b.r} fill="none" stroke="var(--sb-invalid)" strokeWidth={u * 0.5} strokeDasharray={`${u * 1.6} ${u * 1.1}`} />)}
      {overlay?.rings.map(ring => <circle key={`ring${ring.path}`} data-fit-ring={ring.path} cx={ring.cx} cy={ring.cy} r={ring.r + u * 0.9} fill="none" stroke="var(--sb-invalid)" strokeWidth={u * 0.5} />)}
      {overlay?.notes.map((note, i) => <g key={`note${note.path}`} data-fit-note={note.path}>
        <text x={note.x} y={note.y + i * u * 3.2} fontSize={u * 2.6} fill="var(--sb-invalid)" fontFamily="var(--sb-font-data)" fontWeight="600" paintOrder="stroke" stroke="var(--sb-surface-sunken)" strokeWidth={u * 0.9}>{note.text}</text>
      </g>)}
      {handle && <g className="sb-stock-handle" data-editable={interactive ? 'true' : 'false'}>
        <circle cx={0} cy={0} r={handle.od / 2} fill="none" stroke="var(--sb-accent)" strokeWidth={u * 0.3} strokeDasharray={`${u * 0.8} ${u * 1.2}`} opacity="0.7" />
        <g role="slider" tabIndex={interactive ? 0 : -1} aria-label="Jacket outer diameter handle" aria-valuemin={handle.minOd} aria-valuenow={handle.od} aria-valuetext={`${handle.od} mm`}
          aria-orientation="horizontal" aria-disabled={!interactive}
          transform={`translate(${handle.od / 2} 0)`} style={{ pointerEvents: interactive ? 'all' : 'none', cursor: interactive ? 'ew-resize' : 'default', touchAction: 'none' }}
          onPointerDown={event => { if (!interactive) return; event.preventDefault(); (event.currentTarget as Element).setPointerCapture?.(event.pointerId); setFrozen(framed); }}
          onKeyDown={event => {
            if (!interactive) return;
            const dir = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
            if (dir) { event.preventDefault(); onOd!(nudgeOd(handle.od, dir, handle.minOd)); }
          }}>
          <circle r={u * 4.2} fill="transparent" />
          <circle r={u * 1.7} fill="var(--sb-accent)" stroke="var(--sb-surface-sunken)" strokeWidth={u * 0.4} />
          <path d={`M${-u * 0.7} ${-u * 0.6}L${-u * 1.2} 0L${-u * 0.7} ${u * 0.6}M${u * 0.7} ${-u * 0.6}L${u * 1.2} 0L${u * 0.7} ${u * 0.6}`} stroke="var(--sb-accent-ink)" strokeWidth={u * 0.3} fill="none" />
        </g>
        <text x={handle.od / 2 + u * 3} y={-u * 2.4} fontSize={u * 3} fill="var(--sb-text-primary)" fontFamily="var(--sb-font-data)" paintOrder="stroke" stroke="var(--sb-surface-sunken)" strokeWidth={u * 0.8}>OD {handle.od} mm</text>
      </g>}
    </svg>
  </div>;
}
