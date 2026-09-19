export const REPORT_CALLBACK_ID = "report_modal";
export const DIRECT_MESSAGE_OPTION_VALUE = "__dm__";

export interface ChannelOption {
  id: string;
  name: string;
}

/**
 * The /report modal. "Where" is a plain static_select built from the channels the
 * bot can see, plus a synthetic "Direct message" option — CLAUDE.md calls for exactly
 * that shape, not Slack's built-in conversations_select (which can't represent "a DM").
 *
 * "Who was involved" uses rich_text_input (free-form prose with optional @-mention
 * autocomplete), not a multi_users_select. CLAUDE.md Section 7 rules out a *picker*
 * specifically because forcing a hard selection up front "makes the form feel like an
 * accusation machine" — rich_text_input keeps the field as normal prose a reporter
 * writes at their own pace, with mentioning someone an optional convenience inside it
 * rather than the only way to fill out the field.
 */
export function buildReportModal(channelOptions: ChannelOption[], invokingChannelId: string): Record<string, unknown> {
  const whereOptions = [
    ...channelOptions.map((c) => ({
      text: { type: "plain_text", text: `#${c.name}` },
      value: c.id,
    })),
    {
      text: { type: "plain_text", text: "Direct message" },
      value: DIRECT_MESSAGE_OPTION_VALUE,
    },
  ];

  return {
    type: "modal",
    callback_id: REPORT_CALLBACK_ID,
    private_metadata: invokingChannelId,
    title: { type: "plain_text", text: "Report to HESA" },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "what_happened",
        label: { type: "plain_text", text: "What happened" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
        },
      },
      {
        type: "input",
        block_id: "where",
        label: { type: "plain_text", text: "Where" },
        element: {
          type: "static_select",
          action_id: "value",
          options: whereOptions,
        },
      },
      {
        type: "input",
        block_id: "when",
        optional: true,
        label: { type: "plain_text", text: "When" },
        hint: { type: "plain_text", text: "Approximate is fine" },
        element: { type: "datetimepicker", action_id: "value" },
      },
      {
        type: "input",
        block_id: "who",
        optional: true,
        label: { type: "plain_text", text: "Who was involved" },
        hint: { type: "plain_text", text: "Describe them, or mention with @ — whatever's easiest" },
        element: { type: "rich_text_input", action_id: "value" },
      },
      {
        type: "input",
        block_id: "file_as",
        label: { type: "plain_text", text: "File as" },
        element: {
          type: "radio_buttons",
          action_id: "value",
          options: [
            { text: { type: "plain_text", text: "Named" }, value: "named" },
            { text: { type: "plain_text", text: "Anonymous" }, value: "anonymous" },
          ],
        },
      },
    ],
  };
}
