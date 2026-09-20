import { section, contextBlock, type Block } from "../slack/blocks";
import type { SlackHistoryMessage } from "../slack/api";
import { RECENT_FLAG_WINDOW_SECONDS, formatFlagSummary, type RecentFlagSummary } from "../repeatFlags";
import { CROSS_POST_WINDOW_SECONDS, type CrossPostOccurrence } from "./crossPost";
import { MODERATION_CATEGORIES, type ModerationScore } from "./moderationScoring";

// Only worth a line when it actually shows a pattern — a first-ever flag
// tells a reviewer nothing they don't already see in the rest of the alert.
function repeatFlagBlock(summary: RecentFlagSummary): Block | undefined {
  if (summary.total <= 1) return undefined;
  const days = RECENT_FLAG_WINDOW_SECONDS / (24 * 60 * 60);
  return contextBlock([`:repeat: Repeat pattern — ${formatFlagSummary(summary)} for this author in the last ${days} days`]);
}

export function buildCrossPostAlertBlocks(params: {
  authorId: string;
  text: string;
  occurrences: CrossPostOccurrence[];
  permalinks: string[];
  flagSummary: RecentFlagSummary;
}): Block[] {
  const channelLines = params.occurrences
    .map((o, i) => `<#${o.channel}> — <${params.permalinks[i]}|permalink>`)
    .join("\n");
  const windowMinutes = CROSS_POST_WINDOW_SECONDS / 60;

  const blocks: Block[] = [
    section(`*Possible cross-post* (shadow mode — not acted on)\nAuthor: <@${params.authorId}>`),
    section(`*Message:*\n${params.text}`),
    section(`*Posted in ${params.occurrences.length} channels within ${windowMinutes} minutes:*\n${channelLines}`),
  ];

  const repeatBlock = repeatFlagBlock(params.flagSummary);
  if (repeatBlock) blocks.push(repeatBlock);

  blocks.push(contextBlock([`Shadow mode — for threshold calibration only · ${new Date().toISOString()}`]));

  return blocks;
}

export function buildModerationAlertBlocks(params: {
  authorId: string;
  channel: string;
  text: string;
  permalink: string;
  context: SlackHistoryMessage[];
  score: ModerationScore;
  flagSummary: RecentFlagSummary;
}): Block[] {
  const contextText =
    params.context.length === 0
      ? "_(no preceding context)_"
      : params.context.map((m) => `<@${m.user}>: ${m.text}`).join("\n");

  const scoreLines = MODERATION_CATEGORIES.map((c) => `${c}: ${params.score.scores[c].toFixed(2)}`).join(" · ");

  const blocks: Block[] = [
    section(`*Possible harassment/hate flag* (shadow mode — not acted on)\nAuthor: <@${params.authorId}> in <#${params.channel}>`),
    section(`*Flagged message* (<${params.permalink}|permalink>):\n${params.text}`),
    section(`*Preceding context:*\n${contextText}`),
    contextBlock([`Scores — ${scoreLines}`]),
  ];

  const repeatBlock = repeatFlagBlock(params.flagSummary);
  if (repeatBlock) blocks.push(repeatBlock);

  blocks.push(contextBlock([`Shadow mode — for threshold calibration only · ${new Date().toISOString()}`]));

  return blocks;
}
