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
                {/* The 2x2 quadrant — fills column width, wider than tall */}
                <div className="relative aspect-[4/3] w-full">
                  <div className="grid grid-cols-2 grid-rows-2 gap-1.5 h-full">
                    {/* Top-left: Increasing + Low */}
                    <div className="rounded-lg border border-secondary/30 bg-secondary/10 flex items-center justify-center text-center p-1">
                      <span className="text-secondary text-base font-bold leading-tight">Most Liquid</span>
                    </div>
                    {/* Top-right: Increasing + High */}
                    <div className="rounded-lg border border-tertiary/30 bg-tertiary/10 flex items-center justify-center text-center p-1">
                      <span className="text-tertiary text-base font-bold leading-tight">In Between</span>
                    </div>
                    {/* Bottom-left: Decreasing + Low */}
                    <div className="rounded-lg border border-tertiary/30 bg-tertiary/10 flex items-center justify-center text-center p-1">
                      <span className="text-tertiary text-base font-bold leading-tight">In Between</span>
                    </div>
                    {/* Bottom-right: Decreasing + High */}
                    <div className="rounded-lg border border-error/30 bg-error/10 flex items-center justify-center text-center p-1">
                      <span className="text-error text-base font-bold leading-tight">Least Liquid</span>
                    </div>
                  </div>

                  {/* The live position dot */}
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
