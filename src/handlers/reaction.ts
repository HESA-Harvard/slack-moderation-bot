import type { EmojiIncidentRecord } from "../archive/schema";
import { writeArchiveRecord, type ArchiveEnv } from "../archive/drive";
import { logIncident } from "../archive/incidentLog";
import { buildIncidentAlertBlocks } from "../slack/blocks";
import { fetchMessageWithContext, getPermalink, postMessage } from "../slack/api";
import { claimAlert, nextIncidentId } from "../dedupe";
import { recordFlag } from "../repeatFlags";

const CONTEXT_MESSAGE_COUNT = 3;

export interface ReactionEnv extends ArchiveEnv {
  FLAG_EMOJI: string;
}

export interface ReactionAddedEvent {
  reaction: string;
  user: string; // the member who added the reaction (the reporter)
  item: { type: string; channel: string; ts: string };
}

/** reaction_added dispatch. Caller has already ack'd; this runs in waitUntil. */
export async function handleReactionAdded(env: ReactionEnv, event: ReactionAddedEvent): Promise<void> {
  if (event.reaction !== env.FLAG_EMOJI) return;
  if (event.item.type !== "message") return;

  const isFirstAlertForMessage = await claimAlert(env.DEDUPE, event.item.channel, event.item.ts);
  if (!isFirstAlertForMessage) return;

  const { message, context } = await fetchMessageWithContext(
    env.SLACK_BOT_TOKEN,
    event.item.channel,
    event.item.ts,
    CONTEXT_MESSAGE_COUNT,
  );
  if (!message) return;

  const permalink = await getPermalink(env.SLACK_BOT_TOKEN, event.item.channel, event.item.ts);
  const incidentId = await nextIncidentId(env.DEDUPE);

  const record: EmojiIncidentRecord = {
    incident_id: incidentId,
    captured_at: new Date().toISOString(),
    source: "emoji",
    anonymous: false,
    reporter_user_id: event.user,
    channel: event.item.channel,
    permalink,
    flagged_message: { user_id: message.user, ts: message.ts, text: message.text },
    context: context.map((m) => ({ user_id: m.user, ts: m.ts, text: m.text })),
  };

  const [archiveLink, flagSummary] = await Promise.all([
    writeArchiveRecord(env, record),
    // Tracked against the flagged message's author, not the reactor — the
    // repeat count is about whose conduct keeps getting flagged.
    recordFlag(env.DEDUPE, message.user, "member_flag"),
  ]);
  await logIncident(env, record, archiveLink);

  const blocks = buildIncidentAlertBlocks(record, archiveLink, flagSummary);
  await postMessage(env.SLACK_BOT_TOKEN, env.MOD_ALERTS_CHANNEL, blocks, `Message flagged: incident ${incidentId}`);
}
