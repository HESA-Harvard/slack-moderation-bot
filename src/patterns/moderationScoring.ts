import { fetchWithTimeout } from "../http";

const OPENAI_MODERATION_ENDPOINT = "https://api.openai.com/v1/moderations";
const MODERATION_MODEL = "omni-moderation-latest";
const MODERATION_TIMEOUT_MS = 5000;

// Scoped deliberately to harassment/hate — the categories moderation-policy.md
// actually treats as misconduct. self-harm and sexual are excluded on purpose:
// self-harm needs the specialized crisis-resource routing the build spec calls
// for (never a sanction, involves the Dean of Students office, not built yet),
// and sexual risks flagging the kind of good-faith trauma disclosure CLAUDE.md
// explicitly says is a context mismatch, not misconduct. See README "Stage 1
// moderation scoring" for the full reasoning.
export const MODERATION_CATEGORIES = ["harassment", "harassment/threatening", "hate", "hate/threatening"] as const;
export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

export interface ModerationScore {
  flagged: boolean;
  scores: Record<ModerationCategory, number>;
}

interface OpenAiModerationResponse {
  results: { categories: Record<string, boolean>; category_scores: Record<string, number> }[];
}

/**
 * Scores a message via OpenAI's free Moderation API. Fails open: returns
 * undefined (never throws) on any error or timeout, so a moderation-vendor
 * outage never blocks ordinary message processing — this is a best-effort
 * shadow-mode signal, not the archive writer's evidence guarantee, so a
 * quiet skip is the right response here, not a loud failure notice.
 */
export async function scoreMessage(apiKey: string, text: string): Promise<ModerationScore | undefined> {
  try {
    const res = await fetchWithTimeout(
      OPENAI_MODERATION_ENDPOINT,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODERATION_MODEL, input: text }),
      },
      MODERATION_TIMEOUT_MS,
    );

    if (!res.ok) {
      console.error("OpenAI moderation request failed", res.status, await res.text());
      return undefined;
    }

    const body = (await res.json()) as OpenAiModerationResponse;
    const result = body.results[0];
    if (!result) return undefined;

    const scores = {} as Record<ModerationCategory, number>;
    let flagged = false;
    for (const category of MODERATION_CATEGORIES) {
      scores[category] = result.category_scores[category] ?? 0;
      // Our own scoped flagged check — deliberately not OpenAI's own top-level
      // `flagged`, which also covers the categories we excluded above.
      if (result.categories[category]) flagged = true;
    }

    return { flagged, scores };
  } catch (err) {
    console.error("OpenAI moderation request threw", err);
    return undefined;
  }
}
