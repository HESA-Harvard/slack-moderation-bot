/**
 * HESA Slack access-queue integration.
 *
 * Lives outside the Cloudflare Worker because Slack's bot-token API has no
 * way to invite someone to a non-Enterprise workspace (admin.users.invite is
 * Enterprise Grid only). This script fills that one gap: it relays new
 * Google Form submissions to the Worker, and sends the applicant an email
 * once a moderator has acted on it in #access-queue. Everything else —
 * posting the alert, the Approve/Request info/Deny buttons, who approved
 * what — is handled by the Worker (see src/handlers/verification.ts).
 *
 * This file is kept in the git repo for the same reason everything else in
 * this project documents itself for a successor with no context: Apps
 * Script's own editor has no meaningful version history or code review.
 * Copy it into script.google.com; it is not deployed by `wrangler`.
 *
 * SETUP
 * Deliberately kept on a personal @g.harvard.edu account for now rather than
 * a HESA-controlled Gmail account, even though that ties it to one officer —
 * the Form collects HUIDs, and a consumer Gmail account sits outside
 * Harvard's institutional Google Workspace governance (data residency,
 * e-discovery, admin oversight) that a @g.harvard.edu account has. Revisit
 * this if HESA obtains its own dedicated @g.harvard.edu account for org
 * infrastructure; until then this single-officer dependency is accepted
 * knowingly, not by oversight.
 * 1. Create the Google Form. Required question titles (must match exactly —
 *    onFormSubmit() below looks them up by title):
 *      - "Full name"
 *      - "Which best describes you?" (multiple choice, options must match
 *        STATUS_OPTION_TO_CODE below exactly):
 *          "Degree candidate - undergraduate (ALB)"
 *          "Degree candidate - graduate (ALM)"
 *          "Certificate or microcertificate student"
 *          "Premedical program"
 *          "Non-degree course taker"
 *      - "HUID"
 *    Do NOT add a separate "Email" question — turn on Form Settings →
 *    Responses → "Collect email addresses" → "Verified". That's what makes
 *    the email trustworthy (tied to the respondent's signed-in Google
 *    account) rather than just typed text, and this script reads it via
 *    response.getRespondentEmail().
 *
 *    Also add a required "Community guidelines & access" checkbox question
 *    (e.g. "I agree to follow HESA's community guidelines while a member of
 *    the Slack workspace") — this is Form-only, onFormSubmit() below doesn't
 *    read it. Its record lives in the Form's own response log; that's
 *    sufficient, since the point is just that Forms won't accept a
 *    submission without it checked.
 * 2. Extensions → Apps Script, paste this file in as Code.gs.
 * 3. Project Settings → Script Properties, add:
 *      FORM_INTEGRATION_SECRET  — same value as the Worker's
 *                                  FORM_INTEGRATION_SECRET secret
 *      WORKER_SUBMIT_URL        — https://<worker-url>/forms/verification-submit
 *      SLACK_INVITE_LINK        — HESA workspace's shareable invite link,
 *                                  set to "Never expires" in Slack admin
 *                                  settings (Settings & administration →
 *                                  Invite people). It's still capped at 400
 *                                  uses there, fixed, not adjustable — that's
 *                                  deliberate: with expiry off, the use cap
 *                                  is the *only* limit, and it's the one the
 *                                  Worker actually tracks (no Slack API
 *                                  exposes a link's real remaining uses, so
 *                                  it counts its own Approve sends instead —
 *                                  see src/verification/inviteLinkGuard.ts).
 *                                  #access-queue gets a warning near 350
 *                                  uses with a "Mark link refreshed" button;
 *                                  regenerate the link (still Never expires)
 *                                  and click it. If you ever turn expiry
 *                                  back on, that resurfaces the same
 *                                  time-based blind spot noted in the
 *                                  README's "Invite-link expiry" section —
 *                                  there's no scheduled check for it.
 *      REPLY_TO_EMAIL           — hesa@g.harvard.edu
 * 4. Triggers (clock icon, left sidebar) → Add Trigger:
 *      onFormSubmit  · From form · On form submit
 * 5. Deploy → New deployment → type "Web app" → Execute as "Me",
 *    Who has access "Anyone" (this is fine: doPost() itself checks the
 *    shared secret in the body — see comment there). Copy the deployment
 *    URL (ends in /exec) into the Worker's FORM_CALLBACK_URL var in
 *    wrangler.toml. To update the script later, edit this same deployment
 *    (Manage deployments → pencil icon) rather than creating a new one —
 *    a new deployment gets a new URL, which would silently break
 *    FORM_CALLBACK_URL until someone notices.
 */

// Must mirror ApplicantStatus / STATUS_LABELS in src/verification/schema.ts exactly.
var STATUS_OPTION_TO_CODE = {
  "Degree candidate - undergraduate (ALB)": "degree_alb",
  "Degree candidate - graduate (ALM)": "degree_alm",
  "Certificate or microcertificate student": "certificate",
  "Premedical program": "premedical",
  "Non-degree course taker": "course_taker",
};

/** Runs when someone submits the Form. Relays the row to the Worker. */
function onFormSubmit(e) {
  var props = PropertiesService.getScriptProperties();

  var answers = {};
  e.response.getItemResponses().forEach(function (item) {
    answers[item.getItem().getTitle()] = item.getResponse();
  });

  var payload = {
    full_name: answers["Full name"],
    email: e.response.getRespondentEmail(),
    email_verified: true, // guaranteed by the Form's "Collect email addresses: Verified" setting
    status: STATUS_OPTION_TO_CODE[answers["Which best describes you?"]],
    huid: answers["HUID"],
    submitted_at: new Date().toISOString(),
  };

  var response = UrlFetchApp.fetch(props.getProperty("WORKER_SUBMIT_URL"), {
    method: "post",
    contentType: "application/json",
    headers: { "X-Form-Secret": props.getProperty("FORM_INTEGRATION_SECRET") },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true, // so we can log the real status instead of throwing
  });

  var status = response.getResponseCode();
  if (status !== 200) {
    // Check Executions (clock icon, left sidebar) for this — 401 means
    // FORM_INTEGRATION_SECRET doesn't match the Worker's; 404 means
    // WORKER_SUBMIT_URL is wrong or missing /forms/verification-submit;
    // anything else, read the body below.
    Logger.log("Worker rejected submission: %s %s", status, response.getContentText());
  } else {
    Logger.log("Submission relayed to Worker successfully.");
  }
}

// Must mirror src/verification/blocks.ts's STATUSES_EXPECTED_ON_HARVARD_DOMAIN.
var STATUSES_EXPECTED_ON_HARVARD_DOMAIN = ["degree_alb", "degree_alm"];

/**
 * True only for an applicant who claimed degree status but didn't submit
 * with a g.harvard.edu email — the same condition that puts the mismatch
 * warning on the #access-queue alert. Suggesting a resubmit is only useful
 * (and not confusing) in exactly that case: a course-taker without that
 * domain is normal, and a degree candidate who already used it has nothing
 * to gain from resubmitting.
 */
function shouldSuggestHarvardEmail(status, email) {
  var isDegreeCandidate = STATUSES_EXPECTED_ON_HARVARD_DOMAIN.indexOf(status) !== -1;
  var alreadyHarvardEmail = typeof email === "string" && email.toLowerCase().indexOf("@g.harvard.edu") !== -1;
  return isDegreeCandidate && !alreadyHarvardEmail;
}

// Each template takes one context object rather than positional args, since
// they need different fields (invite link, applicant status/email) — see
// doPost() below for what's in ctx.
var EMAIL_TEMPLATES = {
  approve: function (ctx) {
    return {
      subject: "Your HESA Slack access request was approved",
      body:
        "Hi " + ctx.name + ",\n\n" +
        "Your request to join the HESA Slack workspace has been approved. Join here:\n" +
        ctx.inviteLink + "\n\n" +
        "This link is for you personally — please don't forward or post it elsewhere.\n\n" +
        "If it doesn't work, just reply to this email and we'll sort it out.\n\nHESA",
    };
  },
  more_info: function (ctx) {
    var harvardEmailNote = shouldSuggestHarvardEmail(ctx.status, ctx.email)
      ? "\n\nIf you're an admitted degree student, resubmitting the form using your g.harvard.edu " +
        "email may speed up verification.\n"
      : "";
    return {
      subject: "HESA Slack access request: more information needed",
      body:
        "Hi " + ctx.name + ",\n\n" +
        "Thanks for requesting access to the HESA Slack. Before we can approve your request, " +
        "we need a bit more proof of your current HES enrollment — for example, a screenshot of " +
        "your MyDCE registration or a course confirmation email." +
        harvardEmailNote + "\n" +
        "Please reply directly to this email with that information.\n\nHESA",
    };
  },
  deny: function (ctx) {
    return {
      subject: "HESA Slack access request: not approved",
      body:
        "Hi " + ctx.name + ",\n\n" +
        "We weren't able to verify your current HES enrollment from your request, so we couldn't " +
        "approve access to the HESA Slack at this time.\n\n" +
        "If you think this is a mistake, or can provide further proof of enrollment (a MyDCE " +
        "registration screenshot or course confirmation, for example), reply directly to this email " +
        "and we'll take another look.\n\nHESA",
    };
  },
};

/**
 * Web app endpoint the Worker calls after a moderator clicks Approve /
 * Request info / Deny in #access-queue. Web Apps can't read custom request
 * headers, so — unlike everywhere else in this project — the shared secret
 * here travels in the JSON body instead; see src/verification/formsClient.ts
 * for the matching comment on the Worker side.
 */
function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput("bad request");
  }

  if (body.secret !== props.getProperty("FORM_INTEGRATION_SECRET")) {
    return ContentService.createTextOutput("unauthorized");
  }

  var template = EMAIL_TEMPLATES[body.action];
  if (!template) return ContentService.createTextOutput("unknown action");

  var emailContent = template({
    name: body.full_name || "",
    email: body.email,
    status: body.status,
    inviteLink: props.getProperty("SLACK_INVITE_LINK"),
  });

  MailApp.sendEmail({
    to: body.email,
    replyTo: props.getProperty("REPLY_TO_EMAIL"),
    name: "HESA", // MailApp always sends as the account executing the script (whatever
    // that is), and can't change the actual From address — this just makes it display
    // as "HESA <that-account>" instead of the account's raw name/address.
    subject: emailContent.subject,
    body: emailContent.body,
  });

  return ContentService.createTextOutput("ok");
}
