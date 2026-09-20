import { postMessage, updateMessage } from "../slack/api";
import { section, type Block } from "../slack/blocks";
import { appendRosterRow, readRosterRows } from "../archive/drive";
import { nextApprovalId } from "../dedupe";
import { buildVerificationAlertBlocks, buildStatusLineBlock, VERIFY_ACTION_IDS } from "../verification/blocks";
import { notifyFormsCallback } from "../verification/formsClient";
import { recordInviteLinkUse, type InviteLinkGuardEnv } from "../verification/inviteLinkGuard";
import { findConductRemoval, REMOVED_TAB } from "../verification/priorRemoval";
import type { VerificationAction, VerificationButtonPayload, VerificationSubmission } from "../verification/schema";

export interface VerificationEnv extends InviteLinkGuardEnv {
  FORM_CALLBACK_URL: string;
  FORM_INTEGRATION_SECRET: string;
  GOOGLE_SA_KEY: string;
  ACCESS_ROSTER_SHEET_ID: string;
}

const APPROVALS_TAB = "Approvals";

/** New Google Form row, relayed by Apps Script. Caller has already ack'd; runs in waitUntil. */
export async function handleVerificationSubmit(env: VerificationEnv, submission: VerificationSubmission): Promise<void> {
  const removedRows = await readRosterRows(env, env.ACCESS_ROSTER_SHEET_ID, REMOVED_TAB);
  const priorRemoval = findConductRemoval(removedRows, submission.email);

  const blocks = buildVerificationAlertBlocks(submission, priorRemoval);
  await postMessage(env.SLACK_BOT_TOKEN, env.ACCESS_QUEUE_CHANNEL, blocks, `New access request: ${submission.full_name}`);
}

const ACTION_ID_TO_ACTION: Record<string, VerificationAction> = {
  [VERIFY_ACTION_IDS.approve]: "approve",
  [VERIFY_ACTION_IDS.more_info]: "more_info",
  [VERIFY_ACTION_IDS.deny]: "deny",
};

interface BlockActionsPayload {
  type: "block_actions";
  user: { id: string };
  channel: { id: string };
  message: { ts: string; blocks: Block[] };
  actions: { action_id: string; value: string }[];
}

export function isVerificationAction(payload: { type: string; actions?: { action_id: string }[] }): payload is BlockActionsPayload {
  return payload.type === "block_actions" && !!payload.actions?.[0] && payload.actions[0].action_id in ACTION_ID_TO_ACTION;
}

/** Approve/Request info/Deny button click. Caller has already ack'd; runs in waitUntil. */
export async function handleVerificationAction(env: VerificationEnv, payload: BlockActionsPayload): Promise<void> {
  const actionId = payload.actions[0]!.action_id;
  const action = ACTION_ID_TO_ACTION[actionId]!;
  const applicant = JSON.parse(payload.actions[0]!.value) as VerificationButtonPayload;

  await notifyFormsCallback(env.FORM_CALLBACK_URL, env.FORM_INTEGRATION_SECRET, action, applicant);
  if (action === "approve") {
    await recordInviteLinkUse(env);
    await recordApproval(env, applicant, payload.user.id);
  }

  const updatedBlocks = [...payload.message.blocks, buildStatusLineBlock(action, payload.user.id)];
  await updateMessage(env.SLACK_BOT_TOKEN, payload.channel.id, payload.message.ts, updatedBlocks, `Access request ${action}`);
}

/**
 * Appends the approval to the roster spreadsheet's Approvals tab — the
 * durable "who currently has access" record the annual reconfirmation
 * comparison depends on. Never throws: on failure it posts a notice with
 * the row data into #access-queue instead of losing the record silently,
 * same "never drop it quietly" principle as the moderation archive, just
 * without a dedicated failure-notice Block Kit builder for something this
 * simple.
 */
async function recordApproval(env: VerificationEnv, applicant: VerificationButtonPayload, moderatorUserId: string): Promise<void> {
  const approvalId = await nextApprovalId(env.DEDUPE);
  const approvedAt = new Date().toISOString();
  const row = [approvalId, approvedAt, applicant.full_name, applicant.email, applicant.status, applicant.huid, moderatorUserId];

  const ok = await appendRosterRow(env, env.ACCESS_ROSTER_SHEET_ID, APPROVALS_TAB, row);
  if (ok) return;

  await postMessage(
    env.SLACK_BOT_TOKEN,
    env.ACCESS_QUEUE_CHANNEL,
    [
      section(
        `:rotating_light: *Roster write failed for ${approvalId}*\nCould not append this approval to the roster spreadsheet automatically. Add this row to the "${APPROVALS_TAB}" tab manually:`,
      ),
      section(`\`\`\`${JSON.stringify(row)}\`\`\``),
    ],
    `ROSTER WRITE FAILED for ${approvalId} — add manually`,
  );
}
