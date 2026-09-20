import { postMessage, getPermalink } from "../slack/api";
import { hashMessageText, recordCrossPost, MIN_MESSAGE_LENGTH } from "../patterns/crossPost";
import { buildCrossPostAlertBlocks } from "../patterns/blocks";

export interface MessageEnv {
  DEDUPE: KVNamespace;
  SLACK_BOT_TOKEN: string;
  SHADOW_ALERTS_CHANNEL: string;
}

/**
 * Shape of a `message.channels` event. Only ever public-channel messages —
 * that's what this event subscription is scoped to, mirroring the same
 * `message.groups`/`message.im`/`message.mpim` split Slack uses everywhere,
 * so this can't reach into private channels or DMs no matter what the
 * handler does with it.
 */
export interface MessageChannelsEvent {
  subtype?: string;
  bot_id?: string;
  channel: string;
  user?: string;
  text?: string;
  ts: string;
}

/**
 * message.channels dispatch — shadow mode only (see README "Cross-post
 * detection"). Caller has already ack'd; this runs in waitUntil.
 */
export async function handleMessageEvent(env: MessageEnv, event: MessageChannelsEvent): Promise<void> {
  // subtype is set for edits, deletes, joins, bot messages relayed as a subtype, etc. —
  // only plain new messages should count. bot_id is a second guard against self-triggering.
  if (event.subtype || event.bot_id) return;
  if (!event.user || !event.text) return;

  const text = event.text.trim();
  if (text.length < MIN_MESSAGE_LENGTH) return;

  const hash = await hashMessageText(text);
  const { shouldAlert, occurrences } = await recordCrossPost(env.DEDUPE, event.user, hash, event.channel, event.ts);
  if (!shouldAlert) return;

  const permalinks = await Promise.all(occurrences.map((o) => getPermalink(env.SLACK_BOT_TOKEN, o.channel, o.ts)));
  const blocks = buildCrossPostAlertBlocks({ authorId: event.user, text, occurrences, permalinks });
  await postMessage(
    env.SLACK_BOT_TOKEN,
    env.SHADOW_ALERTS_CHANNEL,
    blocks,
    `Possible cross-post by <@${event.user}> in ${occurrences.length} channels`,
  );
}
