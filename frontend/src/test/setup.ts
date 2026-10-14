// jsdom lacks matchMedia. Model reduced motion for tests that explicitly opt
// into it; other media queries remain unmatched.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)",
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Display labels are cached for a short time; tests start from an empty cache.
import { afterEach } from "vitest";
import { clearRevisionLabels } from "../lib/revision-labels";
afterEach(() => clearRevisionLabels());
