import { postMessage } from "../slack/api";
import { section } from "../slack/blocks";
import { appendRosterRow } from "../archive/drive";
import type { ReconfirmationSubmission } from "../verification/schema";

// Must match what google-apps-script/access-roster-report.gs's
// RECONFIRMATIONS_TAB expects — that script also reads this tab.
export const RECONFIRMATIONS_TAB = "Reconfirmations";

export interface ReconfirmationEnv {
  DEDUPE: KVNamespace;
  GOOGLE_SA_KEY: string;
  ACCESS_ROSTER_SHEET_ID: string;
  SLACK_BOT_TOKEN: string;
  ACCESS_QUEUE_CHANNEL: string;
}

/**
 * Appends one row to the roster spreadsheet's Reconfirmations tab for every
 * annual-reconfirmation Qualtrics response. Replaces Google Forms' native
 * Sheets link (the previous mechanism, now gone): Qualtrics has no
 * equivalent zero-code way to write into an existing, multi-tab Sheet, so
 * the Worker does it the same way it already does for Approvals/Denials.
 *
 * No moderator decision, no alert, no review — this is purely a log row.
 * access-roster-report.gs's collectRecentEmailsByHeader reads it by header
 * substring match ("email", "timestamp"), not by position, so this doesn't
 * need to match Forms' original column order, just those two substrings.
 *
 * Never throws: on failure it posts a notice with the row data to
 * #access-queue instead of losing the record silently, same pattern as
 * recordDenial in handlers/verification.ts.
 */
export async function handleReconfirmationSubmit(env: ReconfirmationEnv, submission: ReconfirmationSubmission): Promise<void> {
  const row = [submission.submitted_at, submission.email, submission.full_name];
  const ok = await appendRosterRow(env, env.ACCESS_ROSTER_SHEET_ID, RECONFIRMATIONS_TAB, row);
  if (ok) return;

  await postMessage(
    env.SLACK_BOT_TOKEN,
    env.ACCESS_QUEUE_CHANNEL,
    [
      section(
        `:warning: *Reconfirmation write failed for ${submission.email}*\nCould not append this reconfirmation to the roster spreadsheet automatically. Add this row to the "${RECONFIRMATIONS_TAB}" tab manually:`,
      ),
      section(`\`\`\`${JSON.stringify(row)}\`\`\``),
    ],
    `Reconfirmation write failed for ${submission.email} — add manually`,
  );
}
