import { fetchWithTimeout } from "../http";
import type { VerificationAction, VerificationButtonPayload } from "./schema";

const CALLBACK_TIMEOUT_MS = 5000;

/**
 * Tells the HESA-owned Apps Script project to send the applicant an email —
 * the invite link, a request for more proof, or a decline with appeal
 * instructions, depending on `action`. Apps Script does the actual sending
 * (via MailApp) since Slack's bot-token API has no way to invite someone to
 * a non-Enterprise workspace — see README "Access requests" for why.
 *
 * The shared secret travels in the JSON body, not a header: Apps Script Web
 * Apps' doPost(e) has no access to incoming request headers, only postData
 * and query params. (The other direction — Apps Script calling us — isn't
 * affected; that's Apps Script as the *client*, and UrlFetchApp can set
 * whatever headers it likes, which our own server reads normally.)
 *
 * `applicant.status` rides along mainly for the more_info email, which
 * conditionally suggests resubmitting with a g.harvard.edu email — see
 * access-queue.gs's EMAIL_TEMPLATES.more_info.
 */
export async function notifyFormsCallback(
  callbackUrl: string,
  sharedSecret: string,
  action: VerificationAction,
  applicant: VerificationButtonPayload,
): Promise<void> {
  const res = await fetchWithTimeout(
    callbackUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: sharedSecret, action, ...applicant }),
    },
    CALLBACK_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`Apps Script callback failed: ${res.status} ${await res.text()}`);
  }
}
