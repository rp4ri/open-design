import { useCallback, useEffect, useRef, useState } from 'react';
import { projectRawUrl } from '../providers/registry';
import type { ProjectFile } from '../types';

interface Props {
  projectId: string;
  files: ProjectFile[];
  onOpenFile: (name: string) => void;
}

interface FramePos { x: number; y: number }
interface FrameSize { w: number; h: number }

const FRAME_W = 1280;
const DEFAULT_H = 800;
const GAP = 120;
const LABEL_H = 40;
const COLS = 3;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 1.5;
const LAYOUT_FILE = '_canvas-layout.json';
const SAVE_DEBOUNCE = 2000;
const FIT_PADDING = 60;

function masonryLayout(sizes: FrameSize[]): FramePos[] {
  const colTops = Array(COLS).fill(0);
  const out: FramePos[] = [];
  for (let i = 0; i < sizes.length; i++) {
    const shortest = colTops.indexOf(Math.min(...colTops));
    out.push({ x: shortest * (FRAME_W + GAP), y: colTops[shortest] });
    colTops[shortest] += sizes[i].h + LABEL_H + GAP;
  }
  return out;
}

interface DragInfo {
  frameIdx: number;
  startMx: number;
  startMy: number;
  origFx: number;
  origFy: number;
}

interface SavedLayout {
  positions: FramePos[];
  heights: Record<string, number>;
  fileKeys: string[];
  zoom: number;
  pan: { x: number; y: number };
}

async function loadLayout(projectId: string): Promise<SavedLayout | null> {
  try {
    const resp = await fetch(projectRawUrl(projectId, LAYOUT_FILE));
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
}

async function saveLayout(projectId: string, data: SavedLayout, inflightRef: React.RefObject<boolean>): Promise<void> {
  if (inflightRef.current) return;
  inflightRef.current = true;
  try {
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: LAYOUT_FILE, content: JSON.stringify(data, null, 2) }),
    });
  } catch { /* best effort */ }
  finally { inflightRef.current = false; }
}

export function GridOverviewPanel({ projectId, files, onOpenFile }: Props) {
  const htmlFiles = files.filter((f) => f.kind === 'html');
  const fileKeys = htmlFiles.map((f) => f.name);
  const canvasRef = useRef<HTMLDivElement>(null);

  const [zoom, setZoom] = useState(0.1);
  const [pan, setPan] = useState({ x: 60, y: 60 });
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [positions, setPositions] = useState<FramePos[]>([]);
  const [layoutReady, setLayoutReady] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);

  const dragRef = useRef<DragInfo | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const heightsRef = useRef(heights);
  heightsRef.current = heights;
  const fileKeysRef = useRef(fileKeys);
  fileKeysRef.current = fileKeys;
  const userDragged = useRef(false);
  const saveInflightRef = useRef(false);

  // Load layout from project file on mount
  useEffect(() => {
    let cancelled = false;
    loadLayout(projectId).then((saved) => {
      if (cancelled) return;
      const savedSet = saved ? [...saved.fileKeys].sort().join(',') : '';
      const currentSet = [...fileKeys].sort().join(',');
      if (saved && savedSet === currentSet && saved.positions.length === htmlFiles.length) {
        const posMap: Record<string, FramePos> = {};
        for (let i = 0; i < saved.fileKeys.length; i++) posMap[saved.fileKeys[i]] = saved.positions[i];
        setPositions(fileKeys.map((k) => posMap[k] ?? { x: 0, y: 0 }));
        setHeights(saved.heights);
        setZoom(saved.zoom ?? 0.1);
        setPan(saved.pan ?? { x: 60, y: 60 });
        userDragged.current = true;
      } else {
        const sizes = htmlFiles.map(() => ({ w: FRAME_W, h: DEFAULT_H }));
        setPositions(masonryLayout(sizes));
      }
      setLayoutReady(true);
    });
    return () => { cancelled = true; };
  }, [projectId, htmlFiles.length]);

  // Re-layout when heights change (only if no saved layout was loaded or user dragged)
  useEffect(() => {
    if (userDragged.current) return;
    const measuredCount = Object.keys(heights).length;
    if (measuredCount === 0) return;
    const sizes = htmlFiles.map((f) => ({ w: FRAME_W, h: heights[f.name] ?? DEFAULT_H }));
    setPositions(masonryLayout(sizes));
  }, [heights, htmlFiles.length]);

  // Debounced save — all state read from refs so the callback never goes stale
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (positionsRef.current.length === 0) return;
      saveLayout(projectId, {
        positions: positionsRef.current,
        heights: heightsRef.current,
        fileKeys: fileKeysRef.current,
        zoom: zoomRef.current,
        pan: panRef.current,
      }, saveInflightRef);
    }, SAVE_DEBOUNCE);
  }, [projectId]);

  useEffect(() => {
    if (!layoutReady || positions.length === 0) return;
    scheduleSave();
  }, [positions, heights, layoutReady, zoom, pan, scheduleSave]);

  // Save on unmount (tab switch)
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (positionsRef.current.length > 0) {
        saveLayout(projectId, {
          positions: positionsRef.current,
          heights: heightsRef.current,
          fileKeys: fileKeysRef.current,
          zoom: zoomRef.current,
          pan: panRef.current,
        }, saveInflightRef);
      }
    };
  }, [projectId]);

  // Measure iframe content height on load
  const onIframeLoad = useCallback((e: React.SyntheticEvent<HTMLIFrameElement>, fileName: string) => {
    try {
      const doc = (e.target as HTMLIFrameElement).contentDocument;
      if (!doc) return;
      const h = doc.documentElement.scrollHeight;
      if (h > 0) {
        setHeights((prev) => {
          if (prev[fileName] === h) return prev;
          return { ...prev, [fileName]: h };
        });
      }
    } catch { /* cross-origin, use default */ }
  }, []);

  // Fit: compute bounding box of all frames, set zoom+pan to fit them in viewport
  const fitAll = useCallback(() => {
    const el = canvasRef.current;
    if (!el || positionsRef.current.length === 0) return;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < positionsRef.current.length; i++) {
      const p = positionsRef.current[i];
      const fh = heightsRef.current[htmlFiles[i]?.name] ?? DEFAULT_H;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y - LABEL_H);
      maxX = Math.max(maxX, p.x + FRAME_W);
      maxY = Math.max(maxY, p.y + fh);
    }
    const contentW = maxX - minX;
    const contentH = maxY - minY;
    if (contentW <= 0 || contentH <= 0) return;
    const z = Math.min(
      (vw - FIT_PADDING * 2) / contentW,
      (vh - FIT_PADDING * 2) / contentH,
      MAX_ZOOM,
    );
    const clampedZ = Math.max(MIN_ZOOM, z);
    setZoom(clampedZ);
    setPan({
      x: (vw - contentW * clampedZ) / 2 - minX * clampedZ,
      y: (vh - contentH * clampedZ) / 2 - minY * clampedZ,
    });
  }, [htmlFiles]);

  const zoomBy = useCallback((factor: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    const oldZ = zoomRef.current;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZ * factor));
    const ratio = next / oldZ;
    zoomRef.current = next;
    setZoom(next);
    setPan((p) => ({ x: cx - ratio * (cx - p.x), y: cy - ratio * (cy - p.y) }));
  }, []);

  // Wheel: zoom (ctrl/cmd, dampened) + pan
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (e.ctrlKey || e.metaKey) {
        const raw = -e.deltaY * 0.004;
        const factor = Math.exp(raw);
        const oldZ = zoomRef.current;
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZ * factor));
        const ratio = next / oldZ;
        zoomRef.current = next;
        setZoom(next);
        setPan((p) => ({ x: mx - ratio * (mx - p.x), y: my - ratio * (my - p.y) }));
      } else {
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  // Global drag listeners
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (!userDragged.current) userDragged.current = true;
      const dx = (e.clientX - drag.startMx) / zoomRef.current;
      const dy = (e.clientY - drag.startMy) / zoomRef.current;
      setPositions((prev) => {
        const next = [...prev];
        next[drag.frameIdx] = { x: drag.origFx + dx, y: drag.origFy + dy };
        return next;
      });
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const onFramePointerDown = useCallback((e: React.PointerEvent, idx: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    setSelected(idx);
    dragRef.current = {
      frameIdx: idx,
      startMx: e.clientX,
      startMy: e.clientY,
      origFx: positions[idx].x,
      origFy: positions[idx].y,
    };
  }, [positions]);

  const onCanvasClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('go-world')) {
      setSelected(null);
    }
  }, []);

  if (htmlFiles.length === 0) {
    return <div className="grid-overview-empty">No HTML files in this project.</div>;
  }

  const invScale = 1 / zoom;

  return (
    <div ref={canvasRef} className="go-canvas" onClick={onCanvasClick}>
      <div className="go-toolbar">
        <button type="button" onClick={() => zoomBy(1.3)}>+</button>
        <span className="go-zoom-pct">{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => zoomBy(1 / 1.3)}>−</button>
        <div className="go-toolbar-sep" />
        <button type="button" onClick={fitAll}>Fit</button>
      </div>

      <div
        className="go-world"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}
      >
        {htmlFiles.map((file, i) => {
          const pos = positions[i] ?? { x: 0, y: 0 };
          const src = `${projectRawUrl(projectId, file.name)}?v=${Math.round(file.mtime)}`;
          const label = file.name.replace(/\.html?$/i, '');
          const isSel = selected === i;
          const frameH = heights[file.name] ?? DEFAULT_H;
          return (
            <div
              key={file.name}
              className={`go-frame${isSel ? ' go-selected' : ''}`}
              style={{ left: pos.x, top: pos.y, width: FRAME_W, cursor: 'grab' }}
              onPointerDown={(e) => onFramePointerDown(e, i)}
              onDoubleClick={() => onOpenFile(file.name)}
            >
              <div
                className="go-frame-label"
                style={{ transform: `scale(${invScale})`, transformOrigin: '0 100%' }}
              >
                {label}
              </div>
              <div className="go-frame-viewport" style={{ width: FRAME_W, height: frameH }}>
                <iframe
                  title={file.name}
                  src={src}
                  sandbox="allow-scripts allow-same-origin"
                  onLoad={(e) => onIframeLoad(e, file.name)}
                  style={{ width: FRAME_W, height: frameH, border: 0, display: 'block', pointerEvents: 'none' }}
                  tabIndex={-1}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
