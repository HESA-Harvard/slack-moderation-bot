import { section, contextBlock, type Block } from "../slack/blocks";
import { CROSS_POST_WINDOW_SECONDS, type CrossPostOccurrence } from "./crossPost";

export function buildCrossPostAlertBlocks(params: {
  authorId: string;
  text: string;
  occurrences: CrossPostOccurrence[];
  permalinks: string[];
}): Block[] {
  const channelLines = params.occurrences
    .map((o, i) => `<#${o.channel}> — <${params.permalinks[i]}|permalink>`)
    .join("\n");
  const windowMinutes = CROSS_POST_WINDOW_SECONDS / 60;

  return [
    section(`*Possible cross-post* (shadow mode — not acted on)\nAuthor: <@${params.authorId}>`),
    section(`*Message:*\n${params.text}`),
    section(`*Posted in ${params.occurrences.length} channels within ${windowMinutes} minutes:*\n${channelLines}`),
    contextBlock([`Shadow mode — for threshold calibration only · ${new Date().toISOString()}`]),
  ];
}
