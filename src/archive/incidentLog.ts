import type { IncidentRecord } from "./schema";
import { appendRosterRow, type ArchiveEnv } from "./drive";
import { postMessage } from "../slack/api";
import { section } from "../slack/blocks";

// Lives in the same restricted Drive folder as the evidence JSON files, per
// docs/build-spec.md Section 7's "log row" design — a separate spreadsheet
// from the Access Roster (src/handlers/verification.ts), since who should
// see moderation incidents (the Moderation Team, per docs/moderation-policy.md
// Section 8) isn't necessarily the same group as whoever manages access-queue
// approvals.
export const INCIDENT_LOG_TAB = "Incidents";

// Columns the bot can populate automatically at flag time, followed by
// columns docs/moderation-policy.md Section 9 defines as part of the
// incident log but that only a moderator's later decision can fill in —
// left blank here for hand completion, same pattern as the roster's
// "Removed" tab. There's no button/modal flow on #mod-alerts to capture
// these automatically (alerts are read-only, per CLAUDE.md), so unlike
// Approvals/Denials this row is deliberately incomplete on write.
//
// No message text or report narrative here, on purpose — that's already the
// evidence JSON file's job (linked via archive_link), and a second copy of
// it in a more widely-filterable spreadsheet is exactly the kind of "just in
// case" duplication CLAUDE.md's "minimize retained content" rules out. This
// sheet exists to answer "does this member have priors," not to re-host the
// content.
const BOT_COLUMNS = [
  "incident_id",
  "date_opened",
  "source",
  "channel",
  "flagged_user_id",
  "reporter_user_id",
  "anonymous",
  "archive_link",
] as const;
const MODERATOR_COLUMNS = ["tier_assigned", "moderators_involved", "action_taken", "referred_to_hes", "date_closed"] as const;
export const INCIDENT_LOG_HEADER = [...BOT_COLUMNS, ...MODERATOR_COLUMNS];

function flaggedUserId(record: IncidentRecord): string {
  // Emoji flags always reference a specific message; /report's "who was
  // involved" is deliberately free text folded into report_text, not a
  // picker (CLAUDE.md Section 7), so there's no reliable id to put here for
  // most reports — same limitation already documented in repeatFlags.ts.
  return record.source === "emoji" ? record.flagged_message.user_id : (record.flagged_message?.user_id ?? "");
}

function buildIncidentLogRow(record: IncidentRecord, archiveLink: string | undefined): (string | number)[] {
  return [
    record.incident_id,
    record.captured_at,
    record.source,
    record.channel,
    flaggedUserId(record),
    record.anonymous ? "" : (record.reporter_user_id ?? ""),
    record.anonymous ? "yes" : "no",
    archiveLink ?? "",
    "",
    "",
    "",
    "",
    "",
  ];
}

/**
 * Appends a searchable index row for this incident — what closes the gap
 * between the 30-day automated flag counter (src/repeatFlags.ts) and
 * docs/moderation-policy.md's 12-month "prior finding" aggravating factor:
 * without this, the only record of past incidents was a folder of
 * per-incident JSON files with no way to filter by member. Best-effort, like
 * recordDenial in handlers/verification.ts: the JSON evidence file (already
 * written by writeArchiveRecord) remains the actual record, so a failure
 * here is a visible tracking gap, not lost evidence.
 */
export async function logIncident(env: ArchiveEnv, record: IncidentRecord, archiveLink: string | undefined): Promise<void> {
  const row = buildIncidentLogRow(record, archiveLink);
  const ok = await appendRosterRow(env, env.INCIDENT_LOG_SHEET_ID, INCIDENT_LOG_TAB, row);
  if (ok) return;

  await postMessage(
    env.SLACK_BOT_TOKEN,
    env.MOD_ALERTS_CHANNEL,
    [
      section(
        `:warning: *Incident-log write failed for ${record.incident_id}*\nCould not append this row to the "${INCIDENT_LOG_TAB}" tab automatically. The evidence file is unaffected; add this row manually if useful:`,
      ),
      section(`\`\`\`${JSON.stringify(row)}\`\`\``),
    ],
    `Incident-log write failed for ${record.incident_id} — add manually if useful`,
  );
}
