import { postMessage, updateMessage } from "../slack/api";
import type { Block } from "../slack/blocks";
import { buildVerificationAlertBlocks, buildStatusLineBlock, VERIFY_ACTION_IDS } from "../verification/blocks";
import { notifyFormsCallback } from "../verification/formsClient";
import { recordInviteLinkUse, type InviteLinkGuardEnv } from "../verification/inviteLinkGuard";
import type { VerificationAction, VerificationButtonPayload, VerificationSubmission } from "../verification/schema";

export interface VerificationEnv extends InviteLinkGuardEnv {
  FORM_CALLBACK_URL: string;
  FORM_INTEGRATION_SECRET: string;
}

/** New Google Form row, relayed by Apps Script. Caller has already ack'd; runs in waitUntil. */
export async function handleVerificationSubmit(env: VerificationEnv, submission: VerificationSubmission): Promise<void> {
  const blocks = buildVerificationAlertBlocks(submission);
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
  }

  const updatedBlocks = [...payload.message.blocks, buildStatusLineBlock(action, payload.user.id)];
  await updateMessage(env.SLACK_BOT_TOKEN, payload.channel.id, payload.message.ts, updatedBlocks, `Access request ${action}`);
}
