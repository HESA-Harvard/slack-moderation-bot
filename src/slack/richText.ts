interface RichTextElement {
  type: string;
  text?: string;
  user_id?: string;
  channel_id?: string;
  name?: string;
  url?: string;
  elements?: RichTextElement[];
}

export interface RichTextValue {
  type: "rich_text";
  elements: RichTextElement[];
}

function elementToString(el: RichTextElement): string {
  switch (el.type) {
    case "text":
      return el.text ?? "";
    case "user":
      return el.user_id ? `<@${el.user_id}>` : "";
    case "channel":
      return el.channel_id ? `<#${el.channel_id}>` : "";
    case "emoji":
      return el.name ? `:${el.name}:` : "";
    case "link":
      return el.url ?? el.text ?? "";
    default:
      // rich_text_section, rich_text_list, etc. — just flatten their children.
      return (el.elements ?? []).map(elementToString).join("");
  }
}

/**
 * Converts a rich_text_input's submitted value into plain text. @-mentions become
 * Slack user-id tokens (<@U…>), never resolved display names — consistent with
 * CLAUDE.md's "store Slack user IDs, never display names" rule for archived content.
 */
export function richTextToString(value: RichTextValue | undefined): string {
  if (!value?.elements) return "";
  return value.elements
    .map((section) => elementToString(section))
    .join("\n")
    .trim();
}
