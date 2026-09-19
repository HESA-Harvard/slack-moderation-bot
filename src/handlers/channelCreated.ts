import { joinChannel } from "../slack/api";

export interface ChannelCreatedEnv {
  SLACK_BOT_TOKEN: string;
}

export interface ChannelCreatedEvent {
  channel: { id: string; name: string };
}

/**
 * channel_created dispatch. Caller has already ack'd; this runs in waitUntil.
 * Joins the new public channel so it's covered from the start — otherwise the
 * flag-emoji reaction handler (and any future classifier) sees nothing there
 * until a human remembers to /invite the bot. Slack only ever fires this event
 * for public channels, so this can't reach into private channels or DMs.
 */
export async function handleChannelCreated(env: ChannelCreatedEnv, event: ChannelCreatedEvent): Promise<void> {
  await joinChannel(env.SLACK_BOT_TOKEN, event.channel.id);
}
