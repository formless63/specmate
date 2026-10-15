import "./brand.css";

/** Identification only: this mark never represents an engineering check result. */
export function BrandSymbol({ size = 20 }: { size?: number }) {
  return <svg className="specmate-symbol" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
    <path fill="currentColor" d="M6 4H28V12H12V16H4V6Z M26 28H4V20H20V16H28V26Z M15 13H17V19H15Z" />
  </svg>;
}

export function Brand() {
  return <span className="specmate-brand"><BrandSymbol /><span className="sb-wordmark">SPECMATE</span></span>;
}
