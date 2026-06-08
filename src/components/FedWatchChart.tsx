import { useMemo, useState } from 'react';

// Shape produced by scraping/daily_scrape.py → fedwatch_data.json
export interface FedWatchProbability {
  rate: string;         // e.g. "4.25-4.50"
  probability: number;  // 0..1
}

export interface FedWatchMeeting {
  meeting_date: string;         // ISO "YYYY-MM-01" (best-effort) or ""
  label: string;                // CME's raw label, e.g. "JUN 26"
  current_target_range: string; // e.g. "4.25-4.50"
  fetched_at: string;           // ISO 8601
  probabilities: FedWatchProbability[];
}

interface FedWatchChartProps {
  /** Up to 5 upcoming FOMC meetings, soonest first. */
  meetings: FedWatchMeeting[] | null;
}

// Pretty-print "JUN 26" → "Jun 2026". Keeps the raw label as a fallback so
// the user always sees *something*, even if our parser doesn't recognise it.
function prettyLabel(label: string): string {
  const m = label.trim().match(/^([A-Za-z]{3,4})\s+(\d{2})$/);
  if (!m) return label;
  const month = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return `${month} 20${m[2]}`;
}

export function FedWatchChart({ meetings }: FedWatchChartProps) {
  // Index of the currently-selected meeting tab. Default = 0 = nearest meeting.
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Always show up to 5 tabs even if the data is shorter.
  const visibleMeetings = (meetings ?? []).slice(0, 5);
  const selected = visibleMeetings[selectedIdx] ?? null;

  // Rank rate ranges by the implied move from the current target rate. Without
  // doing this the bars sort lexicographically and you can't tell at a glance
  // whether "cut" sits above or below "hold".
  const sortedBars = useMemo(() => {
    if (!selected) return [];
    const parseLow = (range: string) => {
      const m = range.match(/^(-?\d+(?:\.\d+)?)/);
      return m ? parseFloat(m[1]) : Number.POSITIVE_INFINITY;
    };
    // Sort ascending by low end — lowest (deepest cut) at top, highest (hike) at bottom.
    return [...selected.probabilities].sort(
      (a, b) => parseLow(a.rate) - parseLow(b.rate),
    );
  }, [selected]);

  const maxProb = sortedBars.reduce(
    (m, b) => (b.probability > m ? b.probability : m),
    0,
  );

  // Empty / error state — keep the card visible so the user knows the
  // section exists, just with no data yet.
  if (!meetings || visibleMeetings.length === 0) {
    return (
      <section className="bg-gradient-to-br from-surface-container-low to-surface-container-lowest rounded-xl p-5 relative overflow-hidden w-full flex flex-col">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <p className="text-secondary font-bold text-[10px] uppercase tracking-[0.2em]">
            FedWatch — Implied FOMC Probabilities
          </p>
        </div>
        <div className="flex-1 flex items-center justify-center text-on-surface-variant text-xs">
          No FedWatch data yet — run <code className="mx-1 px-1 bg-surface-container-high rounded">scraping/daily_scrape.py</code>
        </div>
      </section>
    );
  }

  return (
    <section className="bg-gradient-to-br from-surface-container-low to-surface-container-lowest rounded-xl p-5 relative overflow-hidden w-full flex flex-col">
      <div className="absolute top-0 right-0 w-48 h-48 bg-primary/5 rounded-full blur-3xl -mr-16 -mt-16"></div>

      <div className="relative flex flex-col flex-1">
        {/* Heading + current target rate */}
        <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
          <p className="text-secondary font-bold text-[10px] uppercase tracking-[0.2em]">
            FedWatch — Implied FOMC Probabilities
          </p>
          {selected?.current_target_range && (
            <span className="text-[10px] font-bold px-3 py-1 rounded-full bg-surface-container-high text-on-surface">
              Current: {selected.current_target_range}%
            </span>
          )}
        </div>

        {/* Meeting toggle buttons. Default selection (idx 0) = nearest meeting. */}
        <div className="flex flex-wrap gap-1.5 mb-4">
          {visibleMeetings.map((m, i) => {
            const isActive = i === selectedIdx;
            return (
              <button
                key={`${m.label}-${i}`}
                type="button"
                onClick={() => setSelectedIdx(i)}
                className={`px-3 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-colors ${
                  isActive
                    ? 'bg-primary text-on-primary'
                    : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'
                }`}
              >
                {prettyLabel(m.label)}
              </button>
            );
          })}
        </div>

        {/* Horizontal bar chart — one row per target-rate range */}
        <div className="flex flex-col gap-2 flex-1 justify-center min-h-[160px]">
          {sortedBars.map((bar) => {
            const pct = bar.probability * 100;
            // Width of the filled portion: scale to the max bar, not to 100%,
            // so a meeting with 60% peak still shows a full bar at that peak.
            // Easier to read at a glance.
            const widthPct = maxProb > 0 ? (bar.probability / maxProb) * 100 : 0;
            const isPeak = bar.probability === maxProb && maxProb > 0;
            return (
              <div key={bar.rate} className="flex items-center gap-3 text-xs">
                <span className="w-20 shrink-0 text-right font-mono font-semibold text-on-surface">
                  {bar.rate}%
                </span>
                <div className="flex-1 h-5 rounded bg-surface-container-high overflow-hidden relative">
                  <div
                    className={`h-full transition-all duration-300 ${
                      isPeak ? 'bg-primary' : 'bg-secondary/60'
                    }`}
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
                <span
                  className={`w-12 shrink-0 text-right font-mono font-bold ${
                    isPeak ? 'text-primary' : 'text-on-surface-variant'
                  }`}
                >
                  {pct.toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>

        {selected && (
          <p className="text-[9px] uppercase tracking-widest text-on-surface-variant mt-3">
            Source: CME FedWatch · Meeting: {prettyLabel(selected.label)}
          </p>
        )}
      </div>
    </section>
  );
}
