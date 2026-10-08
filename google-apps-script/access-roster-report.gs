/**
 * HESA Access Roster — rolling reconfirmation comparison.
 *
 * Bound to the "HESA Access Roster" spreadsheet itself (Extensions > Apps
 * Script, opened from within that Sheet) — a separate Apps Script project
 * from access-queue.gs (which only sends applicant emails; it isn't bound
 * to anything). Not deployed by `wrangler`.
 *
 * Rolling, not a shared annual cutoff: HESA approves members all year round,
 * not in one intake batch, so there's no single calendar date that's fair to
 * measure everyone against. Each person's own reconfirmation clock starts at
 * their most recent approval and resets every time they reconfirm — see
 * RECONFIRMATION_INTERVAL_DAYS and generateReconfirmationReport below. That
 * means this report is safe (and meant) to run periodically — monthly or
 * quarterly — rather than once a year; each run only surfaces whoever's
 * actually overdue *right now*, not a single annual batch.
 *
 * SETUP
 * 1. "Approvals" tab — written automatically by the Cloudflare Worker
 *    (src/handlers/verification.ts, appendRosterRow) on every Approve
 *    click. Columns: approval_id, approved_at, full_name, email, status,
 *    huid, approved_by. Treat it as an append-only log — don't hand-edit.
 * 2. "Reconfirmations" tab — needs to exist with a header row before the
 *    first write; the Sheets API errors on a missing tab rather than
 *    creating one (same caveat as the "Denials" tab in access-queue's
 *    roster). Header: timestamp, email, full_name — the Worker
 *    (src/handlers/reconfirmation.ts, appendRosterRow) writes rows in
 *    exactly that order. findColumnByHeader below matches "email"/
 *    "timestamp" by substring, not position, so the exact header wording
 *    isn't load-bearing beyond that. Responses accumulate forever — this
 *    script always reads each person's *most recent* response, not just
 *    whether one exists at all, which is what makes a per-person rolling
 *    window possible in the first place.
 * 3. Paste this file in as the bound script (Extensions → Apps Script),
 *    save, then reload the spreadsheet — a "HESA Tools" menu should
 *    appear in the menu bar.
 * 4. Run HESA Tools → Generate Reconfirmation Report periodically (monthly
 *    or quarterly is reasonable) rather than just once a year. Writes/
 *    overwrites a "Needs Review" tab listing every approved member whose
 *    own rolling window has lapsed — degree candidates included. Degree
 *    status isn't a one-time check either: people graduate, withdraw, or
 *    otherwise stop being current HES students, so everyone goes through
 *    the same check, regardless of category.
 * 5. "Removed" tab (create it the first time you remove someone) — columns:
 *    email, removed_at, removed_by, reason_category, notes. "Approvals" is
 *    an append-only log (step 1) and is never edited, so without this,
 *    someone removed from Slack would just keep reappearing in "Needs
 *    Review" every single year forever, since their email will never show
 *    up in "Reconfirmations" either. Add a row here whenever you actually
 *    remove someone and future reports skip them — unless they're later
 *    re-approved through the normal access-queue flow *after* that removal
 *    date, in which case the report correctly un-suppresses them (dates are
 *    compared, not just presence — see generateReconfirmationReport).
 *    Approvals from before the removal stay superseded; only a later
 *    approval reactivates review for them, and — deliberately — a
 *    self-service reconfirmation submission can NEVER clear a removal on
 *    its own; only a fresh moderator approval can (removal is checked
 *    before reconfirmation, for exactly this reason).
 *      reason_category — expected values: "conduct" or "lapsed" (routine:
 *        graduated, withdrew, didn't reconfirm). Only "conduct" removals
 *        trigger the warning in src/handlers/verification.ts when that
 *        email applies again — a "lapsed" removal is exactly the kind of
 *        person this whole system expects to see reapply later, and isn't
 *        flagged.
 *      notes — free text, e.g. a reference to the moderation-incident
 *        archive record this removal was based on.
 * 6. "Denials" tab — create it once, empty, with just the header row (email,
 *    denied_at, denied_by, full_name) — the Sheets API errors on a missing
 *    tab rather than creating one, so this does NOT appear on its own.
 *    Written automatically after that by the Worker (recordDenial in
 *    src/handlers/verification.ts) on every Deny click in #access-queue. It
 *    plays no part in this script or the Needs Review report — it's a
 *    separate, lighter-weight log used only to show a neutral "applied
 *    before and was denied" note on a later reapplication
 *    (src/verification/priorDenial.ts).
 *
 * This only ever produces a report for a human to review — it never removes
 * anyone or changes access itself, and never decides who gets approved
 * either (the Worker's conduct-removal warning is the same: informational
 * only, per CLAUDE.md's "no automated enforcement, ever" — a human always
 * makes the actual call). Slack workspace removal has no API on a
 * non-Enterprise plan; it's a manual step via Slack's own admin UI.
 */

var APPROVALS_TAB = "Approvals";
var RECONFIRMATIONS_TAB = "Reconfirmations";
var REMOVED_TAB = "Removed";
var NEEDS_REVIEW_TAB = "Needs Review";

// HESA approves members on a rolling basis all year, not in one annual
// intake batch — so reconfirmation is rolling too: each person's own clock
// starts at their most recent approval and resets every time they
// reconfirm, rather than everyone sharing one calendar cutoff. 395 days
// (365 + ~30 days grace) rather than exactly 365 gives slack for this report
// not being run on the exact anniversary of everyone's last check-in.
var RECONFIRMATION_INTERVAL_DAYS = 395;

// Column positions in "Approvals" — fixed, since the Worker writes this tab
// with exactly this layout. See appendRosterRow's caller in verification.ts.
var APPROVALS_COLS = { full_name: 2, email: 3, status: 4, huid: 5, approved_at: 1 };

function onOpen() {
  SpreadsheetApp.getUi().createMenu("HESA Tools").addItem("Generate Reconfirmation Report", "generateReconfirmationReport").addToUi();
}

function generateReconfirmationReport() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var approvalsSheet = ss.getSheetByName(APPROVALS_TAB);
  var reconfirmSheet = ss.getSheetByName(RECONFIRMATIONS_TAB);

  if (!approvalsSheet || !reconfirmSheet) {
    SpreadsheetApp.getUi().alert('Both "' + APPROVALS_TAB + '" and "' + RECONFIRMATIONS_TAB + '" tabs must exist first — see this script\'s header comment for setup.');
    return;
  }

  var latestReconfirmByEmail = collectLatestDateByEmail(reconfirmSheet, "timestamp");
  var removedSheet = ss.getSheetByName(REMOVED_TAB);
  var latestRemovalByEmail = removedSheet ? collectLatestDateByEmail(removedSheet, "removed_at") : {};
  var approvalsData = approvalsSheet.getDataRange().getValues();

  // Keep only each person's MOST RECENT approval — someone re-approved after
  // a prior removal (or just accidentally re-submitted) should be judged on
  // that, not an older, superseded row. "Approvals" itself is untouched;
  // this is just how the report reads it.
  var latestApprovalByEmail = {};
  for (var i = 1; i < approvalsData.length; i++) {
    var row = approvalsData[i];
    var email = String(row[APPROVALS_COLS.email] || "").toLowerCase().trim();
    if (!email) continue;
    var approvedAt = new Date(row[APPROVALS_COLS.approved_at]);
    var existing = latestApprovalByEmail[email];
    if (!existing || approvedAt > existing.approvedAt) {
      latestApprovalByEmail[email] = { row: row, approvedAt: approvedAt };
    }
  }

  var needsReview = [["full_name", "email", "status", "huid", "approved_at", "last_confirmed_at", "was_due"]];
  var skippedReconfirmed = 0;
  var skippedRemoved = 0;
  for (var email in latestApprovalByEmail) {
    var entry = latestApprovalByEmail[email];
    var latestRemoval = latestRemovalByEmail[email];

    // Removal is checked FIRST, against their most recent APPROVAL (a
    // moderator's decision) — never against reconfirmation, which is a
    // self-service Form submission nobody reviews. If this check ran after
    // the reconfirmation check instead, someone removed for conduct could
    // just resubmit the reconfirmation form and be silently treated as
    // fine, with no human ever seeing it. Only a fresh moderator approval
    // recorded after the removal date can clear this — reconfirming alone
    // never can.
    if (latestRemoval && latestRemoval >= entry.approvedAt) {
      skippedRemoved++;
      continue; // their most recent approval predates this removal — superseded, not re-approved since
    }

    // Rolling, per person: their own clock starts at approval and resets
    // every time they reconfirm — never a single shared cutoff everyone is
    // measured against (HESA approves people all year round, not in one
    // annual batch, so there's no one calendar date that's fair to everyone).
    var latestReconfirm = latestReconfirmByEmail[email];
    var anchor = latestReconfirm && latestReconfirm > entry.approvedAt ? latestReconfirm : entry.approvedAt;
    var dueDate = new Date(anchor.getTime() + RECONFIRMATION_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
    if (dueDate > new Date()) {
      skippedReconfirmed++;
      continue; // reconfirmed (or approved) recently enough, all set
    }

    var row = entry.row;
    // last_confirmed_at/was_due are computed here, not read from any sheet —
    // they tell a moderator why this person is on the list (their own last
    // check-in, and when their rolling window actually ran out), since
    // different people go overdue on different dates now.
    needsReview.push([
      row[APPROVALS_COLS.full_name],
      row[APPROVALS_COLS.email],
      row[APPROVALS_COLS.status],
      row[APPROVALS_COLS.huid],
      row[APPROVALS_COLS.approved_at],
      anchor.toISOString(),
      dueDate.toISOString(),
    ]);
  }
  needsReview = [needsReview[0]].concat(needsReview.slice(1).sort(function (a, b) { return String(a[0]).localeCompare(String(b[0])); }));

  var memberCount = needsReview.length - 1;
  var banner =
    "Approved members whose own rolling " + RECONFIRMATION_INTERVAL_DAYS + "-day window (from their most recent approval or reconfirmation, " +
    "whichever is later, not a shared calendar date) has lapsed as of " + new Date().toISOString() + ", and aren't covered by a later \"" +
    REMOVED_TAB + "\" entry" +
    " (" + skippedReconfirmed + " still within their own window, " + skippedRemoved + " already removed and not re-approved since — both excluded)" +
    ". \"was_due\" shows each person's own deadline. NOT a removal list — review each person before taking any action. " +
    "Safe to run anytime, not just once a year — this report is per-person, not a shared annual cutoff. " +
    "Generated via HESA Tools → Generate Reconfirmation Report.";

  var existing = ss.getSheetByName(NEEDS_REVIEW_TAB);
  if (existing) ss.deleteSheet(existing);
  var out = ss.insertSheet(NEEDS_REVIEW_TAB);

  var bannerColumnSpan = 9; // wider than the 7 data columns (A–G) so the wrapped text takes fewer lines
  out.getRange(1, 1).setValue(banner);
  out.getRange(1, 1, 1, bannerColumnSpan).merge().setWrap(true).setFontStyle("italic");

  out.getRange(2, 1, needsReview.length, needsReview[0].length).setValues(needsReview);
  out.getRange(2, 1, 1, needsReview[0].length).setFontWeight("bold");
  out.setFrozenRows(2);

  SpreadsheetApp.getUi().alert(
    "Done — " + memberCount + ' member(s) listed in "' + NEEDS_REVIEW_TAB + '" haven\'t reconfirmed recently. ' +
      "This is a starting point for a human to review, not a removal list — always double-check before removing anyone from Slack.",
  );
}

/**
 * Finds a column by header text (case-insensitive substring) rather than a
 * fixed index — the Reconfirmation Form's auto-generated response sheet
 * lays out columns in whatever order the Form's questions are in (plus a
 * leading Timestamp column), which isn't under this script's control the
 * way Approvals is.
 */
function findColumnByHeader(header, substring) {
  for (var c = 0; c < header.length; c++) {
    if (String(header[c]).toLowerCase().indexOf(substring) !== -1) return c;
  }
  return -1;
}

function collectEmailsByHeader(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return [];

  var emailCol = findColumnByHeader(data[0], "email");
  if (emailCol === -1) return [];

  var emails = [];
  for (var r = 1; r < data.length; r++) {
    var email = String(data[r][emailCol] || "").toLowerCase().trim();
    if (email) emails.push(email);
  }
  return emails;
}

/**
 * Like collectEmailsByHeader, but keyed to the latest Date value in a second
 * column (e.g. "removed_at", or "timestamp" for Reconfirmations) — used for
 * both the removal-precedence check and the rolling reconfirmation anchor,
 * since both need each person's single *most recent* date, not just whether
 * any row exists for them at all.
 */
function collectLatestDateByEmail(sheet, dateHeaderSubstring) {
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return {};

  var emailCol = findColumnByHeader(data[0], "email");
  var dateCol = findColumnByHeader(data[0], dateHeaderSubstring);
  if (emailCol === -1 || dateCol === -1) return {};

  var latestByEmail = {};
  for (var r = 1; r < data.length; r++) {
    var email = String(data[r][emailCol] || "").toLowerCase().trim();
    if (!email) continue;
    var date = new Date(data[r][dateCol]);
    if (!latestByEmail[email] || date > latestByEmail[email]) {
      latestByEmail[email] = date;
    }
  }
  return latestByEmail;
}
