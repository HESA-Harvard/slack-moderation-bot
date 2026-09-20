// Tab name and column layout for the roster spreadsheet's "Denials" tab —
// written automatically by recordDenial in handlers/verification.ts on every
// Deny click. Unlike "Removed", this tab is not hand-maintained and carries
// no reason_category: Deny is a single click with no reason captured, so
// there's no way to know whether a given denial was for conduct or something
// administrative (unverifiable info, missing HUID, etc). That's why this
// surfaces as a neutral "applied before" count, not a "Removed"-style
// conduct warning — see buildVerificationAlertBlocks.
export const DENIALS_TAB = "Denials";
const DENIALS_COLS = { email: 0, denied_at: 1, denied_by: 2, full_name: 3 };

export interface PriorDenials {
  count: number;
  mostRecentAt: string;
}

/**
 * Counts prior denials on record for this email, and the most recent one's
 * timestamp — used to flag repeat applications after a denial (e.g. someone
 * resubmitting the Form hoping for a different reviewer), purely
 * informational. Never throws, same reasoning as findConductRemoval: this
 * powers a warning, not something the system enforces itself.
 */
export function findPriorDenials(rows: string[][], email: string): PriorDenials | undefined {
  const target = email.toLowerCase().trim();
  let count = 0;
  let mostRecentAt = "";

  // Skip row 0 (header). Later rows are later in time (append-only).
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const rowEmail = String(row[DENIALS_COLS.email] ?? "").toLowerCase().trim();
    if (rowEmail !== target) continue;

    count++;
    mostRecentAt = String(row[DENIALS_COLS.denied_at] ?? mostRecentAt);
  }

  return count > 0 ? { count, mostRecentAt } : undefined;
}
