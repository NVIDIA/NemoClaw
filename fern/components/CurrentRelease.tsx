/**
 * Inline component that renders the current docs version (e.g. "26.02").
 * Parses the version from the URL path (/v26.02/...) at runtime.
 * Use in headers or prose: # NeMo Curator <CurrentRelease /> Release Notes
 */
export function CurrentRelease() {
  if (typeof window !== "undefined") {
    const match = window.location.pathname.match(/\/v(\d+\.\d+)(?:\/|$)/);
    if (match) return <span>{match[1]}</span>;
  }
  return <span>26.02</span>;
}
