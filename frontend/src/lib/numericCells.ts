/**
 * Marks table cells whose whole text is a number (optionally with a short unit) with
 * `data-numeric`, which the Schematic Bench theme right-aligns in tabular mono. A header
 * is marked when every non-empty body cell in its column is numeric. Words such as
 * "unknown" never match, so unknown is never styled or aligned as a quantity.
 * Cells that set `data-numeric` themselves (any value) are left alone.
 */
const NUMERIC = /^[-+−]?(\d[\d,]*)(\.\d+)?([eE][-+]?\d+)?(\s?(%|[A-Za-zµΩ°]{1,4}(\/[A-Za-z]{1,3})?))?$/;

export function isNumericText(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 24 && NUMERIC.test(t);
}

export function markNumericCells(root: ParentNode): void {
  for (const table of Array.from(root.querySelectorAll("table"))) {
    const rows = Array.from(table.tBodies).flatMap((body) => Array.from(body.rows));
    const columns = new Map<number, { all: boolean; seen: number }>();
    for (const row of rows) {
      Array.from(row.cells).forEach((cell, index) => {
        const text = cell.textContent ?? "";
        const column = columns.get(index) ?? { all: true, seen: 0 };
        if (text.trim()) {
          column.seen += 1;
          if (!isNumericText(text)) column.all = false;
        }
        columns.set(index, column);
        if (cell.hasAttribute("data-numeric") && cell.dataset.numericAuto !== "1") return;
        const numeric = isNumericText(text);
        if (numeric) { cell.setAttribute("data-numeric", ""); cell.dataset.numericAuto = "1"; }
        else if (cell.dataset.numericAuto === "1") { cell.removeAttribute("data-numeric"); delete cell.dataset.numericAuto; }
      });
    }
    const head = table.tHead?.rows[table.tHead.rows.length - 1];
    if (!head) continue;
    Array.from(head.cells).forEach((cell, index) => {
      if (cell.hasAttribute("data-numeric") && cell.dataset.numericAuto !== "1") return;
      const column = columns.get(index);
      if (column && column.seen > 0 && column.all) { cell.setAttribute("data-numeric", ""); cell.dataset.numericAuto = "1"; }
      else if (cell.dataset.numericAuto === "1") { cell.removeAttribute("data-numeric"); delete cell.dataset.numericAuto; }
    });
  }
}

/** Observes the document and re-marks tables after changes. Returns a disconnect function. */
export function observeNumericCells(target: HTMLElement = document.body): () => void {
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; markNumericCells(target); });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(target, { childList: true, subtree: true, characterData: true });
  schedule();
  return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
}
