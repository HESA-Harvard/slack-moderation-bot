export interface SlackMessageRef {
  user_id: string;
  ts: string;
  text: string;
}

interface IncidentRecordBase {
  incident_id: string;
  captured_at: string;
  source: "report" | "emoji";
  channel: string;
  permalink: string;
  context: SlackMessageRef[];
}

export interface ReportIncidentRecord extends IncidentRecordBase {
  source: "report";
  anonymous: boolean;
  reporter_user_id?: string;
  report_text: string;
  flagged_message?: SlackMessageRef;
}

export interface EmojiIncidentRecord extends IncidentRecordBase {
  source: "emoji";
  anonymous: false;
  reporter_user_id: string;
  flagged_message: SlackMessageRef;
}

export type IncidentRecord = ReportIncidentRecord | EmojiIncidentRecord;
