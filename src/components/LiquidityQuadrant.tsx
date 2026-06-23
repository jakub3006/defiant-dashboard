import { useState } from 'react';

interface LiquidityQuadrantProps {
  /** Current (nominal) Federal Funds Rate, e.g. 4.33 */
  nominalRate: number;
  /** Current headline inflation, CPI YoY %, e.g. 3.1 */
  inflationRate: number;
  /** Regime signal: % change in WALCL over the trailing 12 months */
  balanceSheetChangePct12m: number;
}

// --- X axis calibration -------------------------------------------------
// The X axis is the REAL Fed Funds Rate (nominal minus inflation), not the
// headline number — a 5% rate under 8% inflation is stimulative, not tight.
// Midpoint is 0% real: negative real = accommodative ("low" / left), positive
// real = restrictive ("high" / right). Scale spans -5% .. +5%, the realistic
// modern range (deeply negative in 2022, ~+2% at the recent tightening peak).
const RATE_MIN = -5;
const RATE_MAX = 5;

// --- Y axis calibration -------------------------------------------------
// A 12-month % change inside this band is treated as macro-neutral — neither
// QE nor QT — so the dot stays at the centre line. 1.5% over 12 months is
// roughly $100B on a $6.7T balance sheet, well below the pace at which any
// modern QE / QT regime moves; bigger moves push the dot off centre.
const NEUTRAL_BAND_PCT = 1.5;

// A ±MAX_SPEED move (12 months) pushes the dot to its furthest offset.
// 12% per year covers slowed-pace QT comfortably; peak QE/QT clamp at the edge.
const MAX_SPEED = 12;
const MAX_DEFLECTION = 42; // max distance (in %) from the 50% centre line

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

// --- Stock-style guidance per quadrant ----------------------------------
// Each macro regime favours a different equity archetype. Numbers and
// labels mirror the Defiant Gatekeeper framework but described in plain
// language (no "Stock A/B/C/D" letter codes — readers aren't expected
// to memorise the source slide).
type QuadrantKey = 'tl' | 'tr' | 'bl' | 'br';

interface QuadrantInfo {
  /** Big label inside the cell — kept short so it doesn't wrap. */
  label: string;
  /** Tailwind text colour class — matches the cell's accent tone. */
  tone: string;
  /** Tailwind ring colour class used on the hovered cell. */
  ring: string;
  /** Recommended % of portfolio to allocate to equities in this regime. */
  allocation: string;
  /** Plain-English stock archetype name. */
  archetype: string;
  /** 3-line characteristic profile. */
  traits: { label: string; value: string }[];
  /** One-sentence rationale — why this archetype wins in this regime. */
  rationale: string;
}

const QUADRANT_INFO: Record<QuadrantKey, QuadrantInfo> = {
  // Top-left: BS Expanding + Real Rate Low
  tl: {
    label: 'Most Liquid',
    tone: 'text-secondary',
    ring: 'ring-secondary/60',
    allocation: '~100% equities',
    archetype: 'Hyper-growth / Disruptors',
    traits: [
      { label: 'Revenue Growth', value: 'Very High (>50%)' },
      { label: 'Profitability',  value: 'Often unprofitable' },
      { label: 'Debt Load',      value: 'Heavy — cheap to service' },
    ],
    rationale:
      'Abundant liquidity + cheap money lifts every risk asset; ' +
      'leveraged growth wins hardest. Risk tolerance is high.',
  },
  // Top-right: BS Expanding + Real Rate High
  tr: {
    label: 'In Between',
    tone: 'text-tertiary',
    ring: 'ring-tertiary/60',
    allocation: '0–50% equities',
    archetype: 'Quality Growth',
    traits: [
      { label: 'Revenue Growth', value: 'Moderate (~10%)' },
      { label: 'Profitability',  value: 'Solid earnings' },
      { label: 'Debt Load',      value: 'Modest' },
    ],
    rationale:
      'Liquidity tailwind, but higher rates cap multiples. ' +
      'Profitable compounders beat speculative names here.',
  },
  // Bottom-left: BS Contracting + Real Rate Low
  bl: {
    label: 'In Between',
    tone: 'text-tertiary',
    ring: 'ring-tertiary/60',
    allocation: '0–50% equities',
    archetype: 'Growth–Value Mix',
    traits: [
      { label: 'Revenue Growth', value: 'Higher (~20%)' },
      { label: 'Profitability',  value: 'Solid earnings' },
      { label: 'Debt Load',      value: 'Higher tolerance' },
    ],
    rationale:
      'Low rates still support multiples, but a draining Fed balance ' +
      'sheet means be selective — quality growth at reasonable price.',
  },
  // Bottom-right: BS Contracting + Real Rate High
  br: {
    label: 'Least Liquid',
    tone: 'text-error',
    ring: 'ring-error/60',
    allocation: '0–20% equities',
    archetype: 'Defensive / Value',
    traits: [
      { label: 'Revenue Growth', value: 'Low (~5%)' },
      { label: 'Profitability',  value: 'Steady, predictable' },
      { label: 'Debt Load',      value: 'Low / clean balance sheet' },
    ],
    rationale:
      'Capital preservation mode. Only clean balance sheets at cheap ' +
      'valuations survive sustained tightening — cash + short bonds are fine.',
  },
};

export function LiquidityQuadrant({
  nominalRate,
  inflationRate,
  balanceSheetChangePct12m,
}: LiquidityQuadrantProps) {
  // Hovered cell (null = nothing hovered → info panel shows the CURRENT
  // live regime). Hover beats default so the user can preview "what if".
  const [hoveredKey, setHoveredKey] = useState<QuadrantKey | null>(null);

  // The inflation-adjusted policy rate — what actually loosens or tightens conditions.
  const realRate = nominalRate - inflationRate;

  // X: map the real rate onto 0..100 across the -5% .. +5% band.
  const xPct = clamp((realRate - RATE_MIN) / (RATE_MAX - RATE_MIN), 0, 1) * 100;

  // Y: apply a neutral band before scaling. Changes inside ±NEUTRAL_BAND_PCT
  // are treated as macro-flat and leave the dot at the centre line; only moves
  // beyond the band deflect it. This stops a tiny recent uptick after years of
  // QT from flipping the dot to "Most Liquid".
  const beyondBand =
    Math.sign(balanceSheetChangePct12m) *
    Math.max(0, Math.abs(balanceSheetChangePct12m) - NEUTRAL_BAND_PCT);
  const deflection =
    clamp(beyondBand / (MAX_SPEED - NEUTRAL_BAND_PCT), -1, 1) * MAX_DEFLECTION;
  const yPct = clamp(50 - deflection, 5, 95);

  const expanding = balanceSheetChangePct12m > NEUTRAL_BAND_PCT;
  const contracting = balanceSheetChangePct12m < -NEUTRAL_BAND_PCT;
  const lowRate = realRate < (RATE_MIN + RATE_MAX) / 2; // real rate below 0% = accommodative

  // Quadrant label: extreme corners require the BS regime to actually be
  // outside the neutral band. Otherwise it's transitional / mixed.
  const quadrant = !expanding && !contracting
    ? 'Transitional'
    : expanding && lowRate
      ? 'Most Liquid'
      : contracting && !lowRate
        ? 'Least Liquid'
        : 'In Between';

  const quadrantTone =
    quadrant === 'Most Liquid'
      ? 'text-secondary'
      : quadrant === 'Least Liquid'
        ? 'text-error'
        : 'text-tertiary';

  // Which cell does the live dot live in? Used as the default info-panel
  // selection when nothing is hovered. Transitional → pick the cell that
  // matches the real-rate side (so the panel always shows *something*
  // grounded in current data rather than going blank).
  const currentKey: QuadrantKey =
    expanding && lowRate ? 'tl'
    : expanding && !lowRate ? 'tr'
    : contracting && lowRate ? 'bl'
    : contracting && !lowRate ? 'br'
    : lowRate ? 'bl' : 'tr'; // Transitional fallback

  const activeKey = hoveredKey ?? currentKey;
  const active = QUADRANT_INFO[activeKey];

  return (
    <section className="bg-gradient-to-br from-surface-container-low to-surface-container-lowest rounded-xl p-5 relative overflow-hidden w-full flex flex-col">
      <div className="absolute top-0 right-0 w-48 h-48 bg-primary/5 rounded-full blur-3xl -mr-16 -mt-16"></div>

      <div className="relative flex flex-col flex-1">
        {/* Heading */}
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <p className="text-secondary font-bold text-[10px] uppercase tracking-[0.2em]">
            Liquidity Regime
          </p>
          <span className={`text-xs font-bold px-3 py-1 rounded-full bg-surface-container-high ${quadrantTone}`}>
            {quadrant}
          </span>
        </div>

        {/* Plot fills the column width. The 2x2 grid keeps a fixed aspect
            ratio so the boxes don't squeeze when the card stretches
            vertically to match the two stacked indicator cards on the right. */}
        <div className="flex-1 flex items-center justify-center">
          <div className="w-full flex gap-2">
              {/* Y axis labels — vertical text, no icon-font dependency */}
              <div className="flex flex-col justify-between items-center py-1 w-5 shrink-0 self-stretch">
                <span className="text-secondary text-[10px] font-bold uppercase tracking-widest [writing-mode:vertical-rl] rotate-180">
                  Increasing
                </span>
                <span className="text-on-surface-variant text-[9px] font-bold uppercase tracking-[0.15em] [writing-mode:vertical-rl] rotate-180">
                  Balance Sheet
                </span>
                <span className="text-error text-[10px] font-bold uppercase tracking-widest [writing-mode:vertical-rl] rotate-180">
                  Decreasing
                </span>
              </div>

              <div className="flex-1">
                {/* The 2x2 quadrant — fills column width, wider than tall.
                    onMouseLeave on the wrapper resets hover so the info
                    panel snaps back to the current regime when the cursor
                    leaves the grid entirely (rather than only when leaving
                    one cell for a sibling). */}
                <div
                  className="relative aspect-[4/3] w-full"
                  onMouseLeave={() => setHoveredKey(null)}
                >
                  <div className="grid grid-cols-2 grid-rows-2 gap-1.5 h-full">
                    <QuadrantCell
                      info={QUADRANT_INFO.tl}
                      cellBg="bg-secondary/10 border-secondary/30"
                      isActive={hoveredKey === 'tl'}
                      dimmed={hoveredKey !== null && hoveredKey !== 'tl'}
                      onHover={() => setHoveredKey('tl')}
                    />
                    <QuadrantCell
                      info={QUADRANT_INFO.tr}
                      cellBg="bg-tertiary/10 border-tertiary/30"
                      isActive={hoveredKey === 'tr'}
                      dimmed={hoveredKey !== null && hoveredKey !== 'tr'}
                      onHover={() => setHoveredKey('tr')}
                    />
                    <QuadrantCell
                      info={QUADRANT_INFO.bl}
                      cellBg="bg-tertiary/10 border-tertiary/30"
                      isActive={hoveredKey === 'bl'}
                      dimmed={hoveredKey !== null && hoveredKey !== 'bl'}
                      onHover={() => setHoveredKey('bl')}
                    />
                    <QuadrantCell
                      info={QUADRANT_INFO.br}
                      cellBg="bg-error/10 border-error/30"
                      isActive={hoveredKey === 'br'}
                      dimmed={hoveredKey !== null && hoveredKey !== 'br'}
                      onHover={() => setHoveredKey('br')}
                    />
                  </div>

                  {/* The live position dot. pointer-events-none so the dot
                      doesn't swallow hover events from the underlying cells. */}
                  <div
                    className="absolute z-20 pointer-events-none"
                    style={{ left: `${xPct}%`, top: `${yPct}%`, transform: 'translate(-50%, -50%)' }}
                  >
                    <span className="relative flex h-3.5 w-3.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-60"></span>
                      <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-primary ring-4 ring-primary/30"></span>
                    </span>
                    <span className="absolute left-1/2 -translate-x-1/2 mt-1 text-[8px] font-bold uppercase tracking-widest text-primary whitespace-nowrap">
                      Now
                    </span>
                  </div>
                </div>

                {/* X axis labels */}
                <div className="flex justify-between mt-1.5 px-0.5">
                  <span className="text-[9px] font-bold uppercase tracking-widest text-on-surface-variant">
                    Real Rate Low
                  </span>
                  <span className="text-[9px] font-bold uppercase tracking-widest text-on-surface-variant">
                    Real Rate High
                  </span>
                </div>
              </div>
          </div>
        </div>

        {/* Persistent info panel below the grid. Default shows the live
            regime's archetype; on hover, swaps to whichever cell the
            cursor is over. Transitions opacity smoothly so the swap
            feels intentional rather than jarring. */}
        <div className="mt-4 rounded-lg bg-surface-container-high/50 border border-outline-variant/20 px-3 py-2.5 backdrop-blur-sm">
          <div className="flex items-baseline justify-between gap-2 mb-1.5">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className={`text-[10px] font-bold uppercase tracking-widest ${active.tone}`}>
                {active.label}
              </span>
              <span className="text-on-surface text-sm font-bold truncate">
                {active.archetype}
              </span>
            </div>
            <span className={`text-[10px] font-bold uppercase tracking-wider ${active.tone} whitespace-nowrap`}>
              {active.allocation}
            </span>
          </div>
          {/* Inline traits — comma-separated to save vertical space */}
          <div className="text-[10px] text-on-surface-variant flex flex-wrap gap-x-3 gap-y-0.5 mb-1.5">
            {active.traits.map((t) => (
              <span key={t.label}>
                <span className="opacity-60">{t.label}:</span>{' '}
                <span className="font-semibold text-on-surface">{t.value}</span>
              </span>
            ))}
          </div>
          <p className="text-[11px] leading-snug text-on-surface-variant italic">
            {active.rationale}
          </p>
        </div>
      </div>
    </section>
  );
}

// A single cell of the 2×2 quadrant grid. Pure visual — no tooltip JSX,
// no clipping problems. Hover state is reported up to the parent via
// `onHover`. tabIndex makes it keyboard-focusable so the info panel
// updates on Tab too.
function QuadrantCell({
  info,
  cellBg,
  isActive,
  dimmed,
  onHover,
}: {
  info: QuadrantInfo;
  cellBg: string;
  isActive: boolean;
  dimmed: boolean;
  onHover: () => void;
}) {
  // Visual states:
  //   isActive (hovered)  → bright, slight scale up, ring border, on top
  //   dimmed              → fades the OTHER cells back so the active one
  //                         visually pops out of the grid
  //   neither (no hover)  → default appearance
  const stateClasses = isActive
    ? `scale-[1.03] ring-2 ${info.ring} brightness-125 z-10`
    : dimmed
      ? 'opacity-40'
      : '';

  return (
    <div
      tabIndex={0}
      onMouseEnter={onHover}
      onFocus={onHover}
      className={`rounded-lg border ${cellBg} flex items-center justify-center text-center p-1 transition-all duration-200 ease-out outline-none focus-visible:ring-2 focus-visible:${info.ring} ${stateClasses}`}
    >
      <span className={`${info.tone} text-base font-bold leading-tight`}>
        {info.label}
      </span>
    </div>
  );
}
