import type { IncidentRecord } from "../archive/schema";
import { writeArchiveRecord, type ArchiveEnv } from "../archive/drive";
import { logIncident } from "../archive/incidentLog";
import { buildIncidentAlertBlocks } from "../slack/blocks";
import { listChannels, openView, postEphemeral, postMessage } from "../slack/api";
import { buildReportModal, DIRECT_MESSAGE_OPTION_VALUE, REPORT_CALLBACK_ID } from "../slack/modal";
import { richTextToString, type RichTextValue } from "../slack/richText";
import { nextIncidentId } from "../dedupe";

export interface ReportEnv extends ArchiveEnv {}

/** Slash command entry point. Caller has already ack'd within 3s; this runs in waitUntil. */
export async function handleReportCommand(env: ReportEnv, triggerId: string, invokingChannelId: string): Promise<void> {
  const channels = await listChannels(env.SLACK_BOT_TOKEN);
  const view = buildReportModal(channels, invokingChannelId);
  await openView(env.SLACK_BOT_TOKEN, triggerId, view);
}

interface ViewSubmissionPayload {
  view: {
    callback_id: string;
    private_metadata: string;
    state: {
      values: Record<
        string,
        Record<
          string,
          {
            value?: string;
            selected_option?: { value: string };
            selected_date_time?: number;
            rich_text_value?: RichTextValue;
          }
        >
      >;
    };
  };
  user: { id: string };
}

function fieldValue(payload: ViewSubmissionPayload, blockId: string): string | undefined {
  return payload.view.state.values[blockId]?.value?.value;
}

function selectValue(payload: ViewSubmissionPayload, blockId: string): string | undefined {
  return payload.view.state.values[blockId]?.value?.selected_option?.value;
}

function dateTimeValue(payload: ViewSubmissionPayload, blockId: string): number | undefined {
  return payload.view.state.values[blockId]?.value?.selected_date_time;
}

function richTextFieldValue(payload: ViewSubmissionPayload, blockId: string): string {
  return richTextToString(payload.view.state.values[blockId]?.value?.rich_text_value);
}

export function isReportSubmission(payload: ViewSubmissionPayload): boolean {
  return payload.view.callback_id === REPORT_CALLBACK_ID;
}

/** view_submission handler. Caller has already ack'd; this runs in waitUntil. */
export async function handleReportSubmission(env: ReportEnv, payload: ViewSubmissionPayload): Promise<void> {
  const whatHappened = fieldValue(payload, "what_happened") ?? "";
  const where = selectValue(payload, "where") ?? DIRECT_MESSAGE_OPTION_VALUE;
  const whenTs = dateTimeValue(payload, "when");
  const who = richTextFieldValue(payload, "who");
  const fileAs = selectValue(payload, "file_as") ?? "named";
  const anonymous = fileAs === "anonymous";

  const reportTextParts = [whatHappened];
  if (whenTs !== undefined) reportTextParts.push(`When: ${new Date(whenTs * 1000).toISOString()}`);
  if (who) reportTextParts.push(`Who was involved: ${who}`);

  const incidentId = await nextIncidentId(env.DEDUPE);
  const record: IncidentRecord = {
    incident_id: incidentId,
    captured_at: new Date().toISOString(),
    source: "report",
    channel: where,
    permalink: "",
    context: [],
    anonymous,
    reporter_user_id: anonymous ? undefined : payload.user.id,
    report_text: reportTextParts.join("\n"),
  };

  const archiveLink = await writeArchiveRecord(env, record);
  await logIncident(env, record, archiveLink);

  const blocks = buildIncidentAlertBlocks(record, archiveLink);
  await postMessage(env.SLACK_BOT_TOKEN, env.MOD_ALERTS_CHANNEL, blocks, `New report: incident ${incidentId}`);

  await postEphemeral(
    env.SLACK_BOT_TOKEN,
    payload.view.private_metadata,
    payload.user.id,
    "Thanks — your report was received. A moderator will acknowledge it within 48 hours per the HESA moderation policy.",
  );
}
