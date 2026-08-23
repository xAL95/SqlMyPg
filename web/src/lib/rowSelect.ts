/**
 * Row picking for the result grid, kept pure so the branching can be tested: this decides which
 * rows a click selects, and a delete acts on whatever it returns.
 */
export type RowPick = {
  rows: ReadonlySet<number>;
  /** the row a Shift+click extends from - the last row touched without Shift */
  anchor: number | null;
};

export const NO_PICK: RowPick = { rows: new Set<number>(), anchor: null };

function span(from: number, to: number): Set<number> {
  const [a, b] = from <= to ? [from, to] : [to, from];
  const out = new Set<number>();
  for (let i = a; i <= b; i++) out.add(i);
  return out;
}

/** Ctrl toggles one row, Shift extends from the anchor, a plain click replaces the pick. */
export function pickRow(cur: RowPick, row: number, mods: { shift?: boolean; ctrl?: boolean }): RowPick {
  if (mods.ctrl) {
    const rows = new Set(cur.rows);
    if (rows.has(row)) rows.delete(row);
    else rows.add(row);
    return { rows, anchor: row };
  }
  if (mods.shift && cur.anchor !== null) {
    // the anchor stays put, so dragging the far end around keeps extending from the same row
    return { rows: span(cur.anchor, row), anchor: cur.anchor };
  }
  return { rows: new Set([row]), anchor: row };
}

/**
 * The rows an action applies to: the pick when there is one, otherwise the rows the cell
 * rectangle covers, so a plain cell selection still supports the row menu.
 */
export function pickedRows(pick: RowPick, fallback: { r0: number; r1: number } | null): number[] {
  if (pick.rows.size > 0) return [...pick.rows].sort((a, b) => a - b);
  if (!fallback) return [];
  return Array.from({ length: fallback.r1 - fallback.r0 + 1 }, (_, i) => fallback.r0 + i);
}
