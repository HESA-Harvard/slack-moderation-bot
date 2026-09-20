import { postMessage, updateMessage } from "../slack/api";
import { section, contextBlock, type Block } from "../slack/blocks";

const USES_KEY = "invite_link:uses";
const WARNED_KEY = "invite_link:warned";

// Slack's shared invite link caps at 400 uses (fixed, not configurable) — warn
// with enough runway left for a human to notice and regenerate it before it
// actually goes dead. See buildInviteLinkWarningBlocks for why this is an
// estimate rather than Slack's real count.
const WARNING_THRESHOLD = 350;

export const INVITE_LINK_REFRESHED_ACTION_ID = "invite_link_refreshed";

export interface InviteLinkGuardEnv {
  DEDUPE: KVNamespace;
  SLACK_BOT_TOKEN: string;
  ACCESS_QUEUE_CHANNEL: string;
}

function buildInviteLinkWarningBlocks(count: number): Block[] {
  return [
    section(
      `:warning: *Slack invite link may be running low*\n` +
        `This app has sent the current invite link ~${count} times since it was last refreshed. ` +
        `Slack's shared invite links cap out at 400 uses (this one is set to Never expire, so that's ` +
        `the only limit) — there's no API to read the real remaining count (Slack doesn't expose one), ` +
        `so this is an estimate based on approvals processed here, not Slack's actual number.`,
    ),
    section(
      "Regenerate the link in Slack (Settings & administration → Invite people), paste it into the " +
        "Apps Script `SLACK_INVITE_LINK` property, then click below so this stops warning.",
    ),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: INVITE_LINK_REFRESHED_ACTION_ID,
          style: "primary",
          text: { type: "plain_text", text: "Mark link refreshed" },
        },
      ],
    },
  ];
}

/**
 * Call once per successful Approve. Slack exposes no way to read a shared
 * invite link's actual use count, so this counts our own sends instead — a
 * reasonable proxy since the link is only ever distributed through this
 * flow, though it can't detect uses of a leaked/forwarded link, and it
 * can't see the separate 7-day expiry at all (see README).
 */
export async function recordInviteLinkUse(env: InviteLinkGuardEnv): Promise<void> {
  const count = Number((await env.DEDUPE.get(USES_KEY)) ?? "0") + 1;
  await env.DEDUPE.put(USES_KEY, String(count));

  if (count < WARNING_THRESHOLD) return;
  if (await env.DEDUPE.get(WARNED_KEY)) return; // already warned this cycle

  await env.DEDUPE.put(WARNED_KEY, "1");
  await postMessage(
    env.SLACK_BOT_TOKEN,
    env.ACCESS_QUEUE_CHANNEL,
    buildInviteLinkWarningBlocks(count),
    `Slack invite link approaching its use limit (~${count} sent)`,
  );
}

export interface InviteLinkRefreshedPayload {
  user: { id: string };
  channel: { id: string };
  message: { ts: string; blocks: Block[] };
}

/** "Mark link refreshed" button click: resets our counter for the new link. */
export async function handleInviteLinkRefreshed(env: InviteLinkGuardEnv, payload: InviteLinkRefreshedPayload): Promise<void> {
  await env.DEDUPE.delete(USES_KEY);
  await env.DEDUPE.delete(WARNED_KEY);

  const updatedBlocks = [
    ...payload.message.blocks,
    contextBlock([`:white_check_mark: Marked refreshed by <@${payload.user.id}> · ${new Date().toISOString()}`]),
  ];
  await updateMessage(env.SLACK_BOT_TOKEN, payload.channel.id, payload.message.ts, updatedBlocks, "Invite link refreshed");
}
