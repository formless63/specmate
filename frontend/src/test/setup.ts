import { configure } from "@testing-library/react";

// findBy*/waitFor default to 1000 ms, which React.lazy dynamic imports (first-use module
// transform) can exceed on a loaded host. A larger ceiling only delays failure of a genuinely
// absent element; passing runs return as soon as the element appears.
configure({ asyncUtilTimeout: 15_000 });

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
