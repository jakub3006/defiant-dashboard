import { useEffect, useMemo, useRef, useState } from 'react';

export interface SparklinePoint {
  date: string; // ISO date string, e.g. "2026-04-01" or "2026-05-22"
  value: number; // already-parsed numeric value
}

export type FedAction = 'Expansionary' | 'Neutral' | 'Contractionary';

export interface IndicatorBand {
  /** Numeric range or threshold, e.g. ">5.5%", "4–5.5%", "<4%" */
  range: string;
  /** Plain-English economic impact, e.g. "weak economy" */
  impact: string;
  /** What the Fed is likely to do at this level */
  fed: FedAction;
}

export interface IndicatorInfo {
  high: IndicatorBand;
  normal: IndicatorBand;
  low: IndicatorBand;
}

interface IndicatorCardProps {
  title: string;
  value: string;
  unit?: string;
  icon: string;
  color: 'primary' | 'secondary' | 'error';
  sparkline?: string;
  /** Raw points behind the sparkline path — required for hover tooltips. */
  sparklineData?: SparklinePoint[];
  /** Optional formatter for the tooltip value. Defaults to value + unit. */
  formatValue?: (point: SparklinePoint) => string;
  /** If supplied, the hamburger menu in the top-right opens a hover panel. */
  info?: IndicatorInfo;
  /** Which band the current value falls into — highlighted in the info panel. */
  currentLevel?: 'high' | 'normal' | 'low';
  /** Matched-period forecast — i.e. the consensus that was made for the
   *  release whose actual is currently displayed as `value`. Rendered
   *  inline next to the headline with an arrow: `3.8% → 3.7%`. */
  forecastValue?: string;
  /** Forecast for the NEXT upcoming release whose actual hasn't been
   *  published yet. Rendered small in the top-right above the burger
   *  menu / icon as `YYYY/MM Est: <value>`, where the month is taken
   *  from `date` (the release date). Distinct from `forecastValue`
   *  because the upcoming forecast doesn't describe what's already on
   *  the headline — it's the heads-up for the next print. */
  upcomingForecast?: { value: string; date: string };
  /** If present, renders a minimalistic 1M/3M/… text toggle that slices
   *  the sparkline data to the selected window. Only useful for daily
   *  series (VIX, 10Y, credit spread) — monthly series don't have enough
   *  points to benefit from zooming. Defaults to the LAST entry as the
   *  initial selection (i.e. widest window = least zoomed). */
  windowOptions?: { label: string; months: number }[];
  /** Extra classes appended to the root — e.g. "h-full" to fill a flex parent. */
  className?: string;
}

// Same vertical mapping App.tsx uses when building the path so the hover
// dot lines up with the curve exactly.
const Y_TOP = 4;
const Y_BOTTOM = 26;

const _SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function formatDate(iso: string): string {
  // Accept "2026-04-01" or "2026-05-22T..." — we only care about year-month-day.
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const [, y, mm, dd] = m;
  return `${_SHORT_MONTHS[parseInt(mm, 10) - 1]} ${parseInt(dd, 10)}, ${y}`;
}

// Compact label used for the x-axis ticks under the sparkline.
// e.g. "2026-04-01" → "Apr/26"
function formatMonthYearShort(iso: string): string {
  const m = String(iso).match(/^(\d{4})-(\d{2})/);
  if (!m) return String(iso);
  const [, y, mm] = m;
  return `${_SHORT_MONTHS[parseInt(mm, 10) - 1]}/${y.slice(2)}`;
}

// Used by the upcoming-forecast badge. "2026-06-10" → "2026/06".
function formatYearMonth(iso: string): string {
  const m = String(iso).match(/^(\d{4})-(\d{2})/);
  if (!m) return '';
  const [, y, mm] = m;
  return `${y}/${mm}`;
}

// How many axis labels we aim for — quarterly markers across the chart.
const AXIS_LABEL_COUNT = 4;

// Sparkline SVG bounds — kept in sync with the path the parent computes for
// the non-windowed default case, so a windowed/unwindowed card looks the same.
const SPARK_Y_TOP = 4;
const SPARK_Y_BOTTOM = 26;

function _buildPath(points: SparklinePoint[]): string {
  if (!points || points.length < 2) return 'M0 15 L100 15';
  const clean = points.map((p) => p.value).filter((v) => Number.isFinite(v));
  if (clean.length < 2) return 'M0 15 L100 15';
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = max - min || 1;
  const yOf = (v: number) =>
    SPARK_Y_BOTTOM - ((v - min) / range) * (SPARK_Y_BOTTOM - SPARK_Y_TOP);
  return points
    .map((p, i) => {
      const x = ((i / (points.length - 1)) * 100).toFixed(2);
      const y = (Number.isFinite(p.value) ? yOf(p.value) : (SPARK_Y_TOP + SPARK_Y_BOTTOM) / 2).toFixed(2);
      return `${i === 0 ? 'M' : 'L'}${x} ${y}`;
    })
    .join(' ');
}

const FED_COLOR: Record<FedAction, string> = {
  Expansionary: 'text-emerald-400',
  Neutral: 'text-slate-300',
  Contractionary: 'text-rose-400',
};

export function IndicatorCard({
  title,
  value,
  unit,
  icon,
  color,
  sparkline,
  sparklineData,
  formatValue,
  info,
  currentLevel,
  forecastValue,
  upcomingForecast,
  windowOptions,
  className = '',
}: IndicatorCardProps) {
  const colorMap = {
    primary: 'text-primary bg-primary/10',
    secondary: 'text-secondary bg-secondary/10',
    error: 'text-error bg-error/10',
  };

  const textColorMap = {
    primary: 'text-primary',
    secondary: 'text-secondary',
    error: 'text-error',
  };

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Burger-menu info panel: on desktop it opens on hover (media-query gated
  // below), but hover doesn't exist on touch screens — there a tap toggles
  // it open/closed via this state, and tapping anywhere outside closes it.
  const [infoOpen, setInfoOpen] = useState(false);
  const infoRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!infoOpen) return;
    const onDown = (e: PointerEvent) => {
      if (infoRef.current && !infoRef.current.contains(e.target as Node)) {
        setInfoOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [infoOpen]);

  // On touch devices the tooltip is set by tapping/dragging on the chart and
  // intentionally stays visible after the finger lifts (handleLeave ignores
  // non-mouse pointers). This closes it when the user taps outside the chart.
  const sparkWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (hoverIdx == null) return;
    const onDown = (e: PointerEvent) => {
      if (sparkWrapRef.current && !sparkWrapRef.current.contains(e.target as Node)) {
        setHoverIdx(null);
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [hoverIdx]);

  // Window toggle (VIX, 10Y, HY spread). Default to the widest window
  // (last in the array). The actual sparklineData is sliced by date,
  // and the path is recomputed from the slice so a windowed view auto-
  // rescales its y-axis to the visible range (more readable when zooming
  // into a recent move that's small relative to the 12-month range).
  const [windowIdx, setWindowIdx] = useState<number>(
    windowOptions ? windowOptions.length - 1 : 0
  );
  const activeWindow = windowOptions?.[windowIdx] ?? null;

  // Track the previous window so the next render can compute the zoom
  // ratio. Stored as a ref because we need to read it during render
  // BEFORE the effect that updates it. On first mount, prev == current
  // so zoomFactor is 1 (no animation runs on load).
  const prevWindowIdxRef = useRef<number>(windowIdx);
  const zoomFactor = useMemo(() => {
    if (!windowOptions) return 1;
    const prev = prevWindowIdxRef.current;
    if (prev === windowIdx) return 1;
    const prevMonths = windowOptions[prev]?.months ?? 12;
    const newMonths = windowOptions[windowIdx]?.months ?? 12;
    return prevMonths / newMonths;
  }, [windowIdx, windowOptions]);
  useEffect(() => {
    prevWindowIdxRef.current = windowIdx;
  }, [windowIdx]);

  const activeData = useMemo<SparklinePoint[]>(() => {
    if (!sparklineData || !activeWindow) return sparklineData ?? [];
    const latest = sparklineData[sparklineData.length - 1];
    if (!latest?.date) return sparklineData;
    const latestDate = new Date(latest.date);
    if (Number.isNaN(latestDate.getTime())) return sparklineData;
    const cutoff = new Date(latestDate);
    cutoff.setMonth(cutoff.getMonth() - activeWindow.months);
    const sliced = sparklineData.filter((p) => {
      if (!p.date) return false;
      const t = new Date(p.date).getTime();
      return !Number.isNaN(t) && t >= cutoff.getTime();
    });
    // Always keep at least 2 points so the sparkline doesn't collapse.
    return sliced.length >= 2 ? sliced : sparklineData.slice(-2);
  }, [sparklineData, activeWindow]);

  const activePath = useMemo(() => {
    if (!activeWindow) return sparkline;
    return _buildPath(activeData);
  }, [activeWindow, activeData, sparkline]);

  // X-axis labels: pick up to AXIS_LABEL_COUNT evenly-spaced points and
  // emit the date at each, positioned at the same x% the data point sits
  // at on the sparkline. This replaces the old footer strip — labels now
  // line up under their actual data positions on the chart.
  const axisLabels = useMemo(() => {
    if (!activeData || activeData.length < 2) return [];
    const n = activeData.length;
    const count = Math.min(AXIS_LABEL_COUNT, n);
    const result: { xPct: number; text: string }[] = [];
    const seen = new Set<number>();
    for (let k = 0; k < count; k++) {
      const idx = count === 1 ? 0 : Math.round((k / (count - 1)) * (n - 1));
      if (seen.has(idx)) continue;
      seen.add(idx);
      result.push({
        xPct: (idx / (n - 1)) * 100,
        text: formatMonthYearShort(activeData[idx].date),
      });
    }
    return result;
  }, [activeData]);

  // Pre-compute the per-point screen position once so mouse-move just does an
  // index lookup instead of recomputing min/max on every pointer event.
  const layout = useMemo(() => {
    if (!activeData || activeData.length < 2) return null;
    const finite = activeData.filter((p) => Number.isFinite(p.value));
    if (finite.length < 2) return null;
    const vals = finite.map((p) => p.value);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const range = max - min || 1;
    const yOf = (v: number) =>
      Y_BOTTOM - ((v - min) / range) * (Y_BOTTOM - Y_TOP);
    const xs = activeData.map((_, i) =>
      activeData.length === 1 ? 50 : (i / (activeData.length - 1)) * 100
    );
    const ys = activeData.map((p) =>
      Number.isFinite(p.value) ? yOf(p.value) : (Y_TOP + Y_BOTTOM) / 2
    );
    return { xs, ys };
  }, [activeData]);

  // Pointer events unify mouse + touch: mouse hover scrubs as before, and on
  // touch a tap (pointerdown) or drag (pointermove) selects the nearest point.
  const handleMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!activeData || !layout || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    // Convert pixel x within the SVG into the 0..100 viewBox space, then find
    // the nearest data point by x distance.
    const xInView = ((e.clientX - rect.left) / rect.width) * 100;
    let nearest = 0;
    let bestDist = Infinity;
    for (let i = 0; i < layout.xs.length; i++) {
      const d = Math.abs(layout.xs[i] - xInView);
      if (d < bestDist) {
        bestDist = d;
        nearest = i;
      }
    }
    setHoverIdx(nearest);
  };

  // Only a MOUSE leaving the chart clears the tooltip. For touch, the pointer
  // "leaves" the moment the finger lifts — clearing there would make the
  // tooltip flash for a split second and vanish (the old buggy behaviour).
  // Touch dismissal is handled by the outside-tap listener above instead.
  const handleLeave = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'mouse') setHoverIdx(null);
  };

  const hoverPoint = hoverIdx != null && activeData ? activeData[hoverIdx] : null;
  const hoverX = hoverIdx != null && layout ? layout.xs[hoverIdx] : null;
  const hoverY = hoverIdx != null && layout ? layout.ys[hoverIdx] : null;

  const defaultFormat = (p: SparklinePoint) =>
    `${p.value.toFixed(p.value % 1 === 0 ? 0 : 2)}${unit ?? ''}`;
  const fmt = formatValue ?? defaultFormat;

  return (
    <div className={`bg-surface-container-low rounded-xl p-6 flex flex-col justify-between transition-all hover:bg-surface-container hover:-translate-y-1 ${className}`}>
      <div className="flex justify-between items-start mb-4">
        <div>
          <p className="text-on-surface-variant text-xs font-bold uppercase tracking-widest mb-1">
            {title}
          </p>
          <h3 className={`text-4xl font-extrabold tracking-tighter ${textColorMap[color]} flex items-baseline flex-wrap gap-x-1`}>
            <span>
              {value}
              {unit && (
                <span className="text-2xl font-bold opacity-80 ml-1">{unit}</span>
              )}
            </span>
            {forecastValue && forecastValue.trim() !== '' && forecastValue !== '—' && (
              <span className="text-lg font-bold opacity-60 ml-1" title="Forecast for this release">
                <span className="opacity-40 mr-1">→</span>
                {forecastValue}
              </span>
            )}
          </h3>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {upcomingForecast && upcomingForecast.value.trim() !== '' && upcomingForecast.value !== '—' && (
            // Heads-up for the next release: the consensus forecast for a
            // print that hasn't happened yet. Visually distinct from the
            // inline matched forecast (which describes the displayed actual).
            // Label includes the release year+month so the reader can see
            // WHICH upcoming release the forecast is for.
            <span className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant whitespace-nowrap">
              {formatYearMonth(upcomingForecast.date) || 'Next'} Est:{' '}
              <span className="text-on-surface">{upcomingForecast.value}</span>
            </span>
          )}
          {windowOptions && windowOptions.length > 1 && (
            // Minimalistic time-window toggle. Lives in the top-right column
            // alongside the burger menu — sits as a chart control next to
            // the other top-right items rather than awkwardly floating
            // between the headline and the sparkline.
            <div className="flex gap-3">
              {windowOptions.map((opt, i) => (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => setWindowIdx(i)}
                  className={`text-[10px] font-bold uppercase tracking-wider transition-opacity ${
                    i === windowIdx
                      ? `${textColorMap[color]} opacity-100`
                      : 'text-on-surface-variant opacity-40 hover:opacity-80'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
          {info ? (
          // Hamburger-style menu in the top-right. On hover-capable devices
          // (desktop) the panel opens on hover as before — the hover rules
          // are gated behind @media(hover:hover) so touch browsers' hover
          // emulation can't leave the panel stuck open/closed. On touch,
          // a tap toggles `infoOpen`; tapping outside closes it.
          <div ref={infoRef} className="relative group">
            <button
              type="button"
              aria-label={`${title} reference info`}
              aria-expanded={infoOpen}
              onClick={() => setInfoOpen((o) => !o)}
              className={`material-symbols-outlined p-2 rounded-lg cursor-help ${colorMap[color]}`}
            >
              menu
            </button>
            <div
              className={`absolute right-0 top-full mt-2 z-30 w-72 max-w-[82vw] rounded-lg shadow-2xl border border-outline-variant/60 backdrop-blur-sm transition-opacity duration-150 ${
                infoOpen
                  ? 'opacity-100 pointer-events-auto'
                  : 'opacity-0 pointer-events-none [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100'
              }`}
              style={{ backgroundColor: 'rgba(20, 20, 24, 0.97)', color: '#fff' }}
            >
              <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider opacity-70 border-b border-white/10 flex justify-between">
                <span>Economic impact &amp; Fed action</span>
                {currentLevel && (
                  <span className="text-[10px] font-bold text-amber-300">
                    NOW: {value}
                  </span>
                )}
              </div>
              <div className="divide-y divide-white/10">
                {(['high', 'normal', 'low'] as const).map((lvl) => {
                  const band = info[lvl];
                  const isNow = currentLevel === lvl;
                  return (
                    <div
                      key={lvl}
                      className={`px-3 py-2 text-[11px] leading-snug ${
                        isNow ? 'bg-amber-300/15 border-l-2 border-amber-300' : ''
                      }`}
                    >
                      <div className="flex justify-between items-baseline mb-0.5">
                        <span className="font-bold uppercase tracking-wider text-[10px] flex items-center gap-1">
                          {lvl}
                          {isNow && (
                            <span className="text-[9px] px-1 rounded bg-amber-300 text-black font-bold">
                              NOW
                            </span>
                          )}
                        </span>
                        <span className="opacity-80">{band.range}</span>
                      </div>
                      <div className="flex justify-between items-baseline">
                        <span className="opacity-80 italic">{band.impact}</span>
                        <span className={`font-semibold ${FED_COLOR[band.fed]}`}>
                          {band.fed}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <span className={`material-symbols-outlined p-2 rounded-lg ${colorMap[color]}`}>
            {icon}
          </span>
        )}
        </div>
      </div>
      {sparkline && (
        <div ref={sparkWrapRef} className="flex-grow w-full relative min-h-[100px]">
          <svg
            ref={svgRef}
            className={`w-full h-full sparkline-svg ${textColorMap[color]}`}
            preserveAspectRatio="none"
            viewBox="0 0 100 30"
            onPointerDown={handleMove}
            onPointerMove={handleMove}
            onPointerLeave={handleLeave}
            onPointerCancel={handleLeave}
            // pan-y: vertical swipes still scroll the page; horizontal
            // drags scrub the chart instead of fighting the scroll.
            style={{ touchAction: 'pan-y' }}
          >
            <g
              // Key forces React to remount on window change, which restarts
              // the CSS zoom animation. Wrapping in <g> (instead of putting
              // the animation on the path itself) means the transform
              // applies cleanly to the whole drawn region without affecting
              // the stroke width (`non-scaling-stroke` on the path keeps the
              // line crisp through the scale).
              key={activeWindow?.label ?? 'all'}
              className="sparkline-path-zoom"
              style={{ ['--spark-zoom-from' as any]: zoomFactor }}
            >
              <path
                d={activePath}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            </g>
            {hoverX != null && hoverY != null && (
              <>
                <line
                  x1={hoverX}
                  x2={hoverX}
                  y1={0}
                  y2={30}
                  stroke="currentColor"
                  strokeWidth="1"
                  strokeOpacity="0.3"
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx={hoverX}
                  cy={hoverY}
                  r="3.2"
                  fill="currentColor"
                  stroke="white"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              </>
            )}
          </svg>
          {hoverPoint && hoverX != null && (
            <div
              className="pointer-events-none absolute z-20 px-2 py-1 rounded-md text-[10px] font-semibold whitespace-nowrap shadow-xl border border-outline-variant/60 backdrop-blur-sm"
              style={{
                // Position by % of container width to match the SVG's
                // preserveAspectRatio="none" layout. Bias the tooltip up so
                // it floats above the dot, and clamp horizontally so it
                // doesn't get clipped at the card edges.
                left: `${Math.max(4, Math.min(96, hoverX))}%`,
                top: 0,
                transform: 'translate(-50%, -110%)',
                // Solid opaque fill — fixes the case where the big headline
                // number behind the chart was bleeding through the tooltip.
                backgroundColor: 'rgba(20, 20, 24, 0.96)',
                color: '#fff',
              }}
            >
              <div className="text-[9px] uppercase tracking-wider opacity-70">
                {formatDate(hoverPoint.date)}
              </div>
              <div className={textColorMap[color]}>{fmt(hoverPoint)}</div>
            </div>
          )}
        </div>
      )}
      {/* X-axis labels under the sparkline — each label sits at the same
          x% as its underlying data point, so 'Jul/25' is exactly above the
          July 2025 value on the chart. Edge labels (first/last) hug the
          card edges; middle labels are centred on their tick. */}
      {axisLabels.length > 0 && (
        <div className="relative w-full mt-2 pt-3 h-7 border-t border-outline-variant/10">
          {axisLabels.map(({ xPct, text }, i) => {
            const isFirst = i === 0;
            const isLast = i === axisLabels.length - 1;
            const style: React.CSSProperties = isFirst
              ? { left: '0%' }
              : isLast
              ? { right: '0%' }
              : { left: `${xPct}%`, transform: 'translateX(-50%)' };
            return (
              <span
                key={`${text}-${i}`}
                className="absolute text-[9px] font-semibold uppercase tracking-wider text-on-surface-variant whitespace-nowrap"
                style={style}
              >
                {text}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
