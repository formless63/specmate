/** Matcher on rendered text content, for lines that SB components split across elements. Matches the innermost element only. */
const same = (text: string, pattern: string | RegExp) => typeof pattern === "string" ? text.replace(/\s+/g, " ").trim() === pattern : pattern.test(text.replace(/\s+/g, " "));
export const byContent = (pattern: string | RegExp) => (_content: string, element: Element | null) =>
  !!element && same(element.textContent ?? "", pattern) && ![...element.children].some((child) => same(child.textContent ?? "", pattern));
