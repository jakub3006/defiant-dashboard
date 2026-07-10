export function Header() {
  return (
    <header className="bg-[#0b1326]/80 backdrop-blur-xl sticky top-0 w-full z-40">
      <div className="flex items-baseline gap-4 px-4 sm:px-6 lg:px-8 2xl:px-[3vw] py-4 w-full">
        <h1 className="text-xl font-extrabold tracking-tight text-on-surface">
          Macro Gatekeeper
        </h1>
        <p className="text-on-surface-variant text-xs font-medium hidden sm:block">
          US Inflation, Labor & Sentiment Analysis
        </p>
      </div>
    </header>
  );
}
