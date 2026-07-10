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
// Each macro regime favours a different equity archetype. The traits are
// deliberately qualitative (mirroring the Defiant Gatekeeper framework's
// idea, not its exact table numbers) so the cells stay readable at a glance.
type QuadrantKey = 'tl' | 'tr' | 'bl' | 'br';

interface QuadrantInfo {
  /** Regime label, e.g. "Most Liquid". */
  label: string;
  /** Tailwind text colour class — matches the cell's accent tone. */
  tone: string;
  /** Tailwind ring colour class used to highlight the live regime's cell. */
  ring: string;
  /** Recommended equity allocation in this regime. */
  allocation: string;
  /** Plain-English stock archetype name. */
  archetype: string;
  /** Short qualitative traits — only the essentials. */
  traits: string[];
}

const QUADRANT_INFO: Record<QuadrantKey, QuadrantInfo> = {
  // Top-left: BS Expanding + Real Rate Low
  tl: {
    label: 'Most Liquid',
    tone: 'text-secondary',
    ring: 'ring-secondary/60',
    allocation: '~100% invested',
    archetype: 'Hyper-Growth',
    traits: [
      'Very high revenue growth',
      'Profits optional',
      'Heavy debt is cheap to carry',
    ],
  },
  // Top-right: BS Expanding + Real Rate High
  tr: {
    label: 'In Between',
    tone: 'text-tertiary',
    ring: 'ring-tertiary/60',
    allocation: '0–50% invested',
    archetype: 'Quality Growth',
    traits: [
      'Decent revenue growth',
      'Solid earnings',
      'Moderate P/E, modest debt',
    ],
  },
  // Bottom-left: BS Contracting + Real Rate Low
  bl: {
    label: 'In Between',
    tone: 'text-tertiary',
    ring: 'ring-tertiary/60',
    allocation: '0–50% invested',
    archetype: 'Growth Tilt',
    traits: [
      'High revenue growth',
      'Very high P/E accepted',
      'Higher debt tolerated',
    ],
  },
  // Bottom-right: BS Contracting + Real Rate High
  br: {
    label: 'Least Liquid',
    tone: 'text-error',
    ring: 'ring-error/60',
    allocation: '0–20% invested',
    archetype: 'Defensive / Value',
    traits: [
      'Low but steady growth',
      'Cheap valuation (low P/E)',
      'Clean balance sheet',
    ],
  },
};

export function LiquidityQuadrant({
  nominalRate,
  inflationRate,
  balanceSheetChangePct12m,
}: LiquidityQuadrantProps) {
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

  // Which cell does the live dot live in? That cell gets a highlight ring so
  // the current regime pops out without any hover/tap interaction (works the
  // same on desktop and mobile). Transitional → pick the cell matching the
  // real-rate side so something is always highlighted.
  const currentKey: QuadrantKey =
    expanding && lowRate ? 'tl'
    : expanding && !lowRate ? 'tr'
    : contracting && lowRate ? 'bl'
    : contracting && !lowRate ? 'br'
    : lowRate ? 'bl' : 'tr'; // Transitional fallback

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

        {/* Plot fills the column width. Each cell carries its own compact
            playbook (allocation + archetype + traits) so all four regimes
            are readable at once — no hover required. */}
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
                {/* The 2x2 quadrant — fills column width. min-h keeps the
                    cells tall enough for their text on narrow screens. */}
                <div className="relative w-full">
                  <div className="grid grid-cols-2 grid-rows-2 gap-1.5">
                    {(['tl', 'tr', 'bl', 'br'] as const).map((key) => (
                      <QuadrantCell
                        key={key}
                        info={QUADRANT_INFO[key]}
                        cellBg={
                          key === 'tl'
                            ? 'bg-secondary/10 border-secondary/30'
                            : key === 'br'
                              ? 'bg-error/10 border-error/30'
                              : 'bg-tertiary/10 border-tertiary/30'
                        }
                        isCurrent={key === currentKey}
                      />
                    ))}
                  </div>

                  {/* The live position dot. pointer-events-none so it never
                      blocks taps/clicks on the cells beneath it. */}
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
      </div>
    </section>
  );
}

// A single cell of the 2×2 quadrant grid — a compact self-contained window:
// regime label + allocation on top, archetype, then the key traits. The cell
// matching the live regime gets a ring highlight; everything else stays
// static (no hover dependency, so it reads identically on touch devices).
function QuadrantCell({
  info,
  cellBg,
  isCurrent,
}: {
  info: QuadrantInfo;
  cellBg: string;
  isCurrent: boolean;
}) {
  return (
    <div
      className={`rounded-lg border ${cellBg} flex flex-col gap-1 p-2.5 sm:p-3 min-h-[108px] sm:min-h-[128px] overflow-hidden transition-all duration-200 ${
        isCurrent ? `ring-2 ${info.ring} brightness-110` : ''
      }`}
    >
      <div className="flex items-baseline justify-between gap-1 flex-wrap">
        <span className={`${info.tone} text-[11px] sm:text-xs font-bold uppercase tracking-wider leading-tight`}>
          {info.label}
        </span>
        <span className="text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-on-surface whitespace-nowrap">
          {info.allocation}
        </span>
      </div>
      <div className="text-on-surface text-[10px] sm:text-[11px] font-semibold leading-tight">
        {info.archetype}
      </div>
      <ul className="mt-auto space-y-0.5">
        {info.traits.map((t) => (
          <li key={t} className="text-[9px] sm:text-[10px] leading-snug text-on-surface-variant">
            · {t}
          </li>
        ))}
      </ul>
    </div>
  );
}
