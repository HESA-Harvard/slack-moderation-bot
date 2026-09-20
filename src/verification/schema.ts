/**
 * Mirrors the Google Form's "Which best describes you?" options exactly —
 * see google-apps-script/access-queue.gs's header comment and STATUS_LABELS
 * below for the display text each maps to.
 */
export type ApplicantStatus = "degree_alb" | "degree_alm" | "certificate" | "premedical" | "course_taker";

/** What Apps Script POSTs to /forms/verification-submit on a new form row. */
export interface VerificationSubmission {
  full_name: string;
  email: string;
  /** True only when Forms' "Verified" email collection confirms the applicant controls this inbox. */
  email_verified: boolean;
  status: ApplicantStatus;
  huid: string;
  submitted_at: string;
}

/** Exact option text as it must appear in the Google Form. */
export const STATUS_LABELS: Record<ApplicantStatus, string> = {
  degree_alb: "Degree candidate - undergraduate (ALB)",
  degree_alm: "Degree candidate - graduate (ALM)",
  certificate: "Certificate or microcertificate student",
  premedical: "Premedical program",
  course_taker: "Non-degree course taker",
};

export type VerificationAction = "approve" | "more_info" | "deny";

/** Carried in each button's `value` so review state needs no separate storage — see report.ts for the same pattern. */
export interface VerificationButtonPayload {
  full_name: string;
  email: string;
  status: ApplicantStatus;
}
