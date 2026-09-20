// Tab name and column layout for the roster spreadsheet's "Removed" tab —
// must match google-apps-script/access-roster-report.gs's expectations
// exactly, since that script also reads this tab.
export const REMOVED_TAB = "Removed";
const REMOVED_COLS = { email: 0, removed_at: 1, removed_by: 2, reason_category: 3, notes: 4 };

// Only "conduct" removals warrant a warning on a new application — a routine
// "lapsed" (didn't reconfirm, graduated, etc.) removal isn't a reason to
// flag someone reapplying later; that's exactly the kind of person this
// whole system expects to see again.
const CONDUCT_REASON = "conduct";

export interface PriorRemoval {
  removedAt: string;
  removedBy: string;
  notes: string;
}

/**
 * Finds the most recent "conduct" removal on record for this email, if any.
 * `rows` is the raw Removed tab (header row included) from readRosterRows.
 * Never throws — a malformed or missing row just isn't matched, since this
 * powers a warning, not a gate the system enforces itself (CLAUDE.md: no
 * automated enforcement — a human decides what a conduct removal means for
 * a new application, this only makes sure they can't miss it).
 */
export function findConductRemoval(rows: string[][], email: string): PriorRemoval | undefined {
  const target = email.toLowerCase().trim();
  let mostRecent: PriorRemoval | undefined;

  // Skip row 0 (header). Later rows are later in time (append-only), so the
  // last match found is the most recent one.
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const rowEmail = String(row[REMOVED_COLS.email] ?? "").toLowerCase().trim();
    if (rowEmail !== target) continue;

    const reasonCategory = String(row[REMOVED_COLS.reason_category] ?? "").toLowerCase().trim();
    if (reasonCategory !== CONDUCT_REASON) continue;

    mostRecent = {
      removedAt: String(row[REMOVED_COLS.removed_at] ?? ""),
      removedBy: String(row[REMOVED_COLS.removed_by] ?? ""),
      notes: String(row[REMOVED_COLS.notes] ?? ""),
    };
  }

  return mostRecent;
}
