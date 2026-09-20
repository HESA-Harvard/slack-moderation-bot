import { postMessage, getPermalink, fetchMessageWithContext } from "../slack/api";
import { hashMessageText, recordCrossPost, MIN_MESSAGE_LENGTH } from "../patterns/crossPost";
import { scoreMessage } from "../patterns/moderationScoring";
import { buildCrossPostAlertBlocks, buildModerationAlertBlocks } from "../patterns/blocks";
import { recordFlag } from "../repeatFlags";

export interface MessageEnv {
  DEDUPE: KVNamespace;
  SLACK_BOT_TOKEN: string;
  SHADOW_ALERTS_CHANNEL: string;
  OPENAI_API_KEY: string;
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

const MODERATION_CONTEXT_MESSAGE_COUNT = 3;

/**
 * message.channels dispatch — shadow mode only (see README "Cross-post
 * detection" and "Stage 1 moderation scoring"). Caller has already ack'd;
 * this runs in waitUntil. Cross-post detection and moderation scoring are
 * independent checks on the same message — each runs and fails on its own,
 * so one erroring never prevents the other.
 */
export async function handleMessageEvent(env: MessageEnv, event: MessageChannelsEvent): Promise<void> {
  // subtype is set for edits, deletes, joins, bot messages relayed as a subtype, etc. —
  // only plain new messages should count. bot_id is a second guard against self-triggering.
  if (event.subtype || event.bot_id) return;
  if (!event.user || !event.text) return;

  const text = event.text.trim();
  if (!text) return;

  await Promise.all([checkCrossPost(env, event, text), checkModeration(env, event, text)]);
}

// Cross-post's minimum length exists to cut noise from short common replies
// repeated coincidentally — not relevant to moderation scoring, where a short
// slur or threat is still meaningful, so that check stays scoped to this path.
async function checkCrossPost(env: MessageEnv, event: MessageChannelsEvent, text: string): Promise<void> {
  if (text.length < MIN_MESSAGE_LENGTH) return;

  const hash = await hashMessageText(text);
  const { shouldAlert, occurrences } = await recordCrossPost(env.DEDUPE, event.user!, hash, event.channel, event.ts);
  if (!shouldAlert) return;

  const [permalinks, flagSummary] = await Promise.all([
    Promise.all(occurrences.map((o) => getPermalink(env.SLACK_BOT_TOKEN, o.channel, o.ts))),
    recordFlag(env.DEDUPE, event.user!, "cross_post"),
  ]);
  const blocks = buildCrossPostAlertBlocks({ authorId: event.user!, text, occurrences, permalinks, flagSummary });
  await postMessage(
    env.SLACK_BOT_TOKEN,
    env.SHADOW_ALERTS_CHANNEL,
    blocks,
    `Possible cross-post by <@${event.user}> in ${occurrences.length} channels`,
  );
}

async function checkModeration(env: MessageEnv, event: MessageChannelsEvent, text: string): Promise<void> {
  const score = await scoreMessage(env.OPENAI_API_KEY, text);
  if (!score?.flagged) return;

  const [permalink, { context }, flagSummary] = await Promise.all([
    getPermalink(env.SLACK_BOT_TOKEN, event.channel, event.ts),
    fetchMessageWithContext(env.SLACK_BOT_TOKEN, event.channel, event.ts, MODERATION_CONTEXT_MESSAGE_COUNT),
    recordFlag(env.DEDUPE, event.user!, "moderation_flag"),
  ]);
  const blocks = buildModerationAlertBlocks({ authorId: event.user!, channel: event.channel, text, permalink, context, score, flagSummary });
  await postMessage(
    env.SLACK_BOT_TOKEN,
    env.SHADOW_ALERTS_CHANNEL,
    blocks,
    `Possible harassment/hate flag for <@${event.user}>`,
  );
}
