import type { IncidentRecord, SlackMessageRef } from "../archive/schema";
import { DIRECT_MESSAGE_OPTION_VALUE } from "./modal";

// Minimal Block Kit typing — enough to build the blocks this app sends, not a full SDK surface.
export interface Block {
  type: string;
  [key: string]: unknown;
}

function section(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function contextBlock(elements: string[]): Block {
  return { type: "context", elements: elements.map((text) => ({ type: "mrkdwn", text })) };
}

function contextLines(context: SlackMessageRef[]): string {
  if (context.length === 0) return "_(no preceding context)_";
  return context.map((m) => `<@${m.user_id}>: ${m.text}`).join("\n");
}

export function buildIncidentAlertBlocks(record: IncidentRecord, archiveLink?: string): Block[] {
  const blocks: Block[] = [
    section(record.source === "report" ? "*New report filed via `/report`*" : "*Message flagged by member (emoji)*"),
  ];

  if (record.flagged_message) {
    blocks.push(
      section(`*Flagged message* (<${record.permalink}|permalink>)\n<@${record.flagged_message.user_id}>: ${record.flagged_message.text}`),
      contextBlock([`Channel: <#${record.channel}> · Preceding context:`]),
      section(contextLines(record.context)),
    );
  }

  if (record.source === "report") {
    const where = record.channel === DIRECT_MESSAGE_OPTION_VALUE ? "Direct message" : `<#${record.channel}>`;
    blocks.push(
      contextBlock([`Where: ${where}`]),
      section(`*What happened:*\n${record.report_text}`),
    );
    if (!record.anonymous && record.reporter_user_id) {
      blocks.push(contextBlock([`Reported by <@${record.reporter_user_id}>`]));
    } else {
      blocks.push(contextBlock(["Filed anonymously"]));
    }
  } else {
    blocks.push(contextBlock([`Flagged by <@${record.reporter_user_id}> (visible to moderators only)`]));
  }

  const incidentLabel = archiveLink ? `<${archiveLink}|Incident ${record.incident_id}>` : `Incident ${record.incident_id}`;
  blocks.push(contextBlock([`${incidentLabel} · captured ${record.captured_at}`]));

  return blocks;
}

export function buildArchiveFailureBlocks(record: IncidentRecord): Block[] {
  return [
    section(`:rotating_light: *Archive write failed for incident ${record.incident_id}*\nThe evidence below could not be written to the archive automatically. A moderator must save it manually.`),
    { type: "divider" },
    section(`\`\`\`${JSON.stringify(record, null, 2)}\`\`\``),
  ];
}
