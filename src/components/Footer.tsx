// Fed-action legend: explains what the colored Contractionary / Neutral /
// Expansionary badges in each card's hamburger panel actually mean for the
// Federal Reserve's response. Keeps colours in sync with FED_COLOR in
// IndicatorCard.tsx — emerald = expansionary, slate = neutral, rose =
// contractionary.
export function Footer() {
  return (
    <footer className="mt-12 py-6 border-t border-outline-variant/10 px-8 text-on-surface-variant text-xs">
      <div className="flex items-center gap-6 flex-wrap">
        <span className="font-bold uppercase tracking-[0.2em] text-[10px] text-on-surface-variant">
          Fed Action Legend
        </span>
        <span className="h-4 w-[1px] bg-outline-variant/30"></span>
        <span className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
          <span className="font-semibold text-emerald-400">Expansionary</span>
          <span className="text-on-surface-variant">= Rate Cut</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-slate-300"></span>
          <span className="font-semibold text-slate-300">Neutral</span>
          <span className="text-on-surface-variant">= Hold</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-rose-400"></span>
          <span className="font-semibold text-rose-400">Contractionary</span>
          <span className="text-on-surface-variant">= Rate Hike</span>
        </span>
      </div>
    </footer>
  );
}
