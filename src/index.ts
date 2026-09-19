import { Hono } from "hono";
import { verifySlackSignature } from "./slack/verify";
import { claimEvent } from "./dedupe";
import { handleReactionAdded, type ReactionAddedEvent } from "./handlers/reaction";
import { handleReportCommand, handleReportSubmission, isReportSubmission } from "./handlers/report";

export interface Env {
  DEDUPE: KVNamespace;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  GOOGLE_SA_KEY: string;
  MOD_ALERTS_CHANNEL: string;
  ARCHIVE_FOLDER_ID: string;
  FLAG_EMOJI: string;
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
    | { type: "event_callback"; event_id: string; event: ReactionAddedEvent & { type: string } };

  if (payload.type === "url_verification") {
    return c.text(payload.challenge);
  }

  if (payload.type === "event_callback") {
    const isNew = await claimEvent(c.env.DEDUPE, payload.event_id);
    if (isNew && payload.event.type === "reaction_added") {
      c.executionCtx.waitUntil(handleReactionAdded(c.env, payload.event));
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
  }

  return c.text("", 200);
});

export default app;
