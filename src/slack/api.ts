import type { IncidentRecord } from "../archive/schema";
import type { Block } from "./blocks";
import { buildArchiveFailureBlocks } from "./blocks";
import { fetchWithTimeout } from "../http";

const SLACK_API_BASE = "https://slack.com/api";

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

async function callSlack(token: string, method: string, payload: Record<string, unknown>): Promise<SlackApiResponse> {
  const res = await fetchWithTimeout(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as SlackApiResponse;
  if (!body.ok) {
    throw new Error(`Slack API ${method} failed: ${body.error}`);
  }
  return body;
}

export async function postMessage(token: string, channel: string, blocks: Block[], text: string): Promise<void> {
  await callSlack(token, "chat.postMessage", { channel, blocks, text });
}

export async function updateMessage(token: string, channel: string, ts: string, blocks: Block[], text: string): Promise<void> {
  await callSlack(token, "chat.update", { channel, ts, blocks, text });
}

export async function postEphemeral(
  token: string,
  channel: string,
  user: string,
  text: string,
): Promise<void> {
  await callSlack(token, "chat.postEphemeral", { channel, user, text });
}

export async function openView(token: string, triggerId: string, view: Record<string, unknown>): Promise<void> {
  await callSlack(token, "views.open", { trigger_id: triggerId, view });
}

export interface SlackHistoryMessage {
  user: string;
  ts: string;
  text: string;
}

/** Fetches a message and the `contextSize` messages preceding it in the channel. */
export async function fetchMessageWithContext(
  token: string,
  channel: string,
  ts: string,
  contextSize: number,
): Promise<{ message: SlackHistoryMessage | undefined; context: SlackHistoryMessage[] }> {
  const body = await callSlack(token, "conversations.history", {
    channel,
    latest: ts,
    inclusive: true,
    limit: contextSize + 1,
  });
  const messages = (body.messages as SlackHistoryMessage[] | undefined) ?? [];
  const [message, ...rest] = messages;
  return { message, context: rest };
}

/**
 * chat.getPermalink is one of the few Slack Web API methods that rejects a JSON POST body
 * (returns invalid_arguments) — it expects a query string, so it can't go through callSlack.
 */
export async function getPermalink(token: string, channel: string, messageTs: string): Promise<string> {
  const url = new URL(`${SLACK_API_BASE}/chat.getPermalink`);
  url.searchParams.set("channel", channel);
  url.searchParams.set("message_ts", messageTs);

  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json()) as SlackApiResponse;
  if (!body.ok) {
    throw new Error(`Slack API chat.getPermalink failed: ${body.error}`);
  }
  return body.permalink as string;
}

export interface SlackChannel {
  id: string;
  name: string;
}

/** Public channels the bot is a member of — used to populate the /report modal's "Where" select. */
export async function listChannels(token: string): Promise<SlackChannel[]> {
  const body = await callSlack(token, "conversations.list", {
    types: "public_channel",
    exclude_archived: true,
    limit: 200,
  });
  return (body.channels as SlackChannel[] | undefined) ?? [];
}

/** Joins a public channel the bot isn't in yet — requires the channels:join scope. */
export async function joinChannel(token: string, channel: string): Promise<void> {
  await callSlack(token, "conversations.join", { channel });
}

/** Last-resort path when the archive write itself fails — see archive/drive.ts. */
export async function postFailureNotice(token: string, channel: string, record: IncidentRecord): Promise<void> {
  const blocks = buildArchiveFailureBlocks(record);
  await postMessage(
    token,
    channel,
    blocks,
    `ARCHIVE WRITE FAILED for incident ${record.incident_id} — evidence below must be preserved manually`,
  );
}
