import { section, contextBlock, type Block } from "../slack/blocks";
import { STATUS_LABELS, type VerificationAction, type VerificationButtonPayload, type VerificationSubmission } from "./schema";

export const VERIFY_ACTION_IDS: Record<VerificationAction, string> = {
  approve: "verify_approve",
  more_info: "verify_more_info",
  deny: "verify_deny",
};

const HARVARD_EMAIL_DOMAIN = "@g.harvard.edu";

// Falls back visibly rather than rendering the literal string "undefined" —
// this happens if the Form's "Which best describes you?" option text drifts
// out of sync with access-queue.gs's STATUS_OPTION_TO_CODE (that script logs
// a warning to its own Executions log when this happens, for debugging).
function statusLabel(status: VerificationSubmission["status"]): string {
  return STATUS_LABELS[status] ?? "(unrecognized — check Form/Apps Script status mapping)";
}

// Only admitted degree candidates are known to reliably get a g.harvard.edu
// account — certificate/premedical/course-taker admission doesn't obviously
// come with one, so they're excluded rather than guessed at. Adjust this set
// if that assumption turns out to be wrong for one of them.
const STATUSES_EXPECTED_ON_HARVARD_DOMAIN = new Set<VerificationSubmission["status"]>(["degree_alb", "degree_alm"]);

/**
 * Degree candidates should have a g.harvard.edu account; other categories
 * often don't. This is a hint for the reviewer, not an enforced rule —
 * flagging a mismatch, never blocking a legitimate applicant who lacks one.
 */
function domainMismatchWarning(submission: VerificationSubmission): Block | undefined {
  if (!STATUSES_EXPECTED_ON_HARVARD_DOMAIN.has(submission.status)) return undefined;
  if (submission.email.toLowerCase().endsWith(HARVARD_EMAIL_DOMAIN)) return undefined;
  return contextBlock([`:warning: Claims "${statusLabel(submission.status)}" but verified email isn't ${HARVARD_EMAIL_DOMAIN}`]);
}

export function buildVerificationAlertBlocks(submission: VerificationSubmission): Block[] {
  const payload: VerificationButtonPayload = {
    full_name: submission.full_name,
    email: submission.email,
    status: submission.status,
  };
  const buttonValue = JSON.stringify(payload);

  const details = [
    `*Name:* ${submission.full_name}`,
    `*Email:* ${submission.email}${submission.email_verified ? " (verified)" : " (not verified)"}`,
    `*Status:* ${statusLabel(submission.status)}`,
    `*HUID:* ${submission.huid}`,
  ];

  const blocks: Block[] = [section("*New HESA Slack access request*"), section(details.join("\n"))];

  const warning = domainMismatchWarning(submission);
  if (warning) blocks.push(warning);

  blocks.push(
    {
      type: "actions",
      elements: [
        { type: "button", action_id: VERIFY_ACTION_IDS.approve, style: "primary", text: { type: "plain_text", text: "Approve" }, value: buttonValue },
        { type: "button", action_id: VERIFY_ACTION_IDS.more_info, text: { type: "plain_text", text: "Request info" }, value: buttonValue },
        { type: "button", action_id: VERIFY_ACTION_IDS.deny, style: "danger", text: { type: "plain_text", text: "Deny" }, value: buttonValue },
      ],
    },
    contextBlock([`Submitted ${submission.submitted_at}`]),
  );

  return blocks;
}

const STATUS_LINE: Record<VerificationAction, string> = {
  approve: ":white_check_mark: Approved",
  more_info: ":raised_hand: Info requested",
  deny: ":no_entry: Denied",
};

/** Appended to the alert's existing blocks via chat.update — see handlers/verification.ts. */
export function buildStatusLineBlock(action: VerificationAction, moderatorUserId: string): Block {
  return contextBlock([`${STATUS_LINE[action]} by <@${moderatorUserId}> · ${new Date().toISOString()}`]);
}
