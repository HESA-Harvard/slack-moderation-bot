import { Hono } from "hono";
import { verifySlackSignature, timingSafeEqual } from "./slack/verify";
import { claimEvent } from "./dedupe";
import { handleReactionAdded, type ReactionAddedEvent } from "./handlers/reaction";
import { handleChannelCreated, type ChannelCreatedEvent } from "./handlers/channelCreated";
import { handleMessageEvent, type MessageChannelsEvent } from "./handlers/messageEvent";
import { handleReportCommand, handleReportSubmission, isReportSubmission } from "./handlers/report";
import { handleVerificationSubmit, handleVerificationAction, isVerificationAction } from "./handlers/verification";
import { handleInviteLinkRefreshed, INVITE_LINK_REFRESHED_ACTION_ID } from "./verification/inviteLinkGuard";
import type { VerificationSubmission } from "./verification/schema";

export interface Env {
  DEDUPE: KVNamespace;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  GOOGLE_SA_KEY: string;
  MOD_ALERTS_CHANNEL: string;
  ARCHIVE_FOLDER_ID: string;
  FLAG_EMOJI: string;
  ACCESS_QUEUE_CHANNEL: string;
  FORM_CALLBACK_URL: string;
  FORM_INTEGRATION_SECRET: string;
  SHADOW_ALERTS_CHANNEL: string;
  OPENAI_API_KEY: string;
}

type Variables = { rawBody: string };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Every Slack surface (events, commands, interactivity) is signed the same way.
app.use("/slack/*", async (c, next) => {
  const rawBody = await c.req.text();
  const ok = await verifySlackSignature(
    c.env.SLACK_SIGNING_SECRET,
    c.req.header("X-Slack-Request-Timestamp") ?? null,
    c.req.header("X-Slack-Signature") ?? null,
    rawBody,
  );
  if (!ok) return c.text("invalid signature", 401);

  // Stash the raw body since Hono only lets the request stream be consumed once.
  c.set("rawBody", rawBody);
  await next();
});

app.post("/slack/events", async (c) => {
  const rawBody = c.get("rawBody");
  const payload = JSON.parse(rawBody) as
    | { type: "url_verification"; challenge: string }
    | {
        type: "event_callback";
        event_id: string;
        event: (
          | (ReactionAddedEvent & { type: "reaction_added" })
          | (ChannelCreatedEvent & { type: "channel_created" })
          | (MessageChannelsEvent & { type: "message" })
        );
      };

  if (payload.type === "url_verification") {
    return c.text(payload.challenge);
  }

  if (payload.type === "event_callback") {
    const isNew = await claimEvent(c.env.DEDUPE, payload.event_id);
    if (isNew && payload.event.type === "reaction_added") {
      c.executionCtx.waitUntil(handleReactionAdded(c.env, payload.event));
    } else if (isNew && payload.event.type === "channel_created") {
      c.executionCtx.waitUntil(handleChannelCreated(c.env, payload.event));
    } else if (isNew && payload.event.type === "message") {
      c.executionCtx.waitUntil(handleMessageEvent(c.env, payload.event));
    }
  }

  return c.text("", 200);
});

app.post("/slack/commands", async (c) => {
  const rawBody = c.get("rawBody");
  const form = new URLSearchParams(rawBody);
  const command = form.get("command");
  const triggerId = form.get("trigger_id");
  const channelId = form.get("channel_id");

  if (command === "/report" && triggerId && channelId) {
    c.executionCtx.waitUntil(handleReportCommand(c.env, triggerId, channelId));
  }

  return c.text("", 200);
});

app.post("/slack/interactivity", async (c) => {
  const rawBody = c.get("rawBody");
  const form = new URLSearchParams(rawBody);
  const payloadRaw = form.get("payload");
  if (!payloadRaw) return c.text("", 200);

  const payload = JSON.parse(payloadRaw);
  if (payload.type === "view_submission" && isReportSubmission(payload)) {
    c.executionCtx.waitUntil(handleReportSubmission(c.env, payload));
  } else if (isVerificationAction(payload)) {
    c.executionCtx.waitUntil(handleVerificationAction(c.env, payload));
  } else if (payload.type === "block_actions" && payload.actions?.[0]?.action_id === INVITE_LINK_REFRESHED_ACTION_ID) {
    c.executionCtx.waitUntil(handleInviteLinkRefreshed(c.env, payload));
  }

  return c.text("", 200);
});

// Not a Slack request — Apps Script relays new Google Form rows here. Authenticated
// with a shared secret instead of Slack's signature scheme, so it sits outside /slack/*.
app.post("/forms/verification-submit", async (c) => {
  const provided = c.req.header("X-Form-Secret") ?? "";
  if (!timingSafeEqual(provided, c.env.FORM_INTEGRATION_SECRET)) {
    return c.text("invalid secret", 401);
  }

  const submission = (await c.req.json()) as VerificationSubmission;
  c.executionCtx.waitUntil(handleVerificationSubmit(c.env, submission));

  return c.text("", 200);
});

export default app;
