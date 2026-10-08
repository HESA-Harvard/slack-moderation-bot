/**
 * Mirrors the Qualtrics survey's "Which best describes you?" options exactly
 * — see STATUS_LABELS below for the display text each maps to, and
 * statusFromLabel for how the Worker converts the raw label text Qualtrics
 * pipes back into one of these codes.
 */
export type ApplicantStatus = "degree_alb" | "degree_alm" | "certificate" | "premedical" | "course_taker";

/** What the Qualtrics Web Service task POSTs to /forms/verification-submit on a new survey response. */
export interface VerificationSubmission {
  full_name: string;
  email: string;
  /** True only when the survey's HarvardKey SSO gate confirms this email as the respondent's actual Harvard-affiliated address — not self-typed, not just "a real inbox." */
  email_verified: boolean;
  status: ApplicantStatus;
  huid: string;
  submitted_at: string;
}

/** What the Qualtrics Web Service task POSTs to /forms/reconfirmation-submit on each annual-reconfirmation response. */
export interface ReconfirmationSubmission {
  full_name: string;
  email: string;
  submitted_at: string;
}

/** Exact option text as it must appear in the Qualtrics survey question. */
export const STATUS_LABELS: Record<ApplicantStatus, string> = {
  degree_alb: "Degree candidate - undergraduate (ALB)",
  degree_alm: "Degree candidate - graduate (ALM)",
  certificate: "Certificate or microcertificate student",
  premedical: "Premedical program",
  course_taker: "Non-degree course taker",
};

const LABEL_TO_STATUS: Record<string, ApplicantStatus> = Object.fromEntries(
  (Object.entries(STATUS_LABELS) as [ApplicantStatus, string][]).map(([code, label]) => [label, code]),
);

/**
 * Converts the Qualtrics survey's raw selected-choice label text into a
 * code. Needed because Qualtrics' numeric Recode Value can't hold an
 * arbitrary string — confirmed by testing: the "Selected Choices Recode"
 * piped-text option returns the choice's plain numeric position (e.g. "2"),
 * not a custom code, and keying off that position would silently point at
 * the wrong status if the question's choices are ever reordered. So the
 * survey's Web Service task pipes the plain label text instead (the
 * question's default piped-text option), and this does the same
 * label-matching access-queue.gs's old STATUS_OPTION_TO_CODE used to do
 * before the Google Form relay was replaced. Matches by exact text — a
 * mismatch (e.g. the option wording drifts) returns undefined, which
 * surfaces loudly in the alert as "(unrecognized — check...)" rather than
 * silently guessing.
 */
export function statusFromLabel(label: string): ApplicantStatus | undefined {
  return LABEL_TO_STATUS[label];
}

export type VerificationAction = "approve" | "more_info" | "deny";

/** Carried in each button's `value` so review state needs no separate storage — see report.ts for the same pattern. */
export interface VerificationButtonPayload {
  full_name: string;
  email: string;
  status: ApplicantStatus;
  huid: string;
}
