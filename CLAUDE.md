# HESA Moderation Bot — Claude Code Briefing

2026-09-17

Context for a Claude Code session building this project. Read this first. The full design lives in the build spec; this is the working brief.

## 1. What this is

A Slack app for the Harvard Extension Student Association (HESA), a student government serving enrolled Harvard Extension School students. The workspace is on Slack's **Free plan**, with no Enterprise features, no SSO, and no Workflow Builder.

The app accepts reports of problematic conduct and preserves evidence outside Slack's 90-day retention window; flags possibly harassing messages and cross-posted spam in public channels for human moderators to review, in shadow mode; screens membership applications through a moderator approval queue; and supports an annual re-review of who still has access. See Section 3 for what's shipped versus still pending.

**Why it exists.** HES administration has raised concerns about bullying and harassment. Separately, the community is migrating from a \~2,000-member WhatsApp group that is being shut down, so Slack membership will grow quickly.

**What the community's problems actually look like**, which matters for prioritization:

- Members occasionally post heavy personal trauma in general channels. This is a context mismatch, **not misconduct**. Nothing in this system should flag, remove, or record it as a violation
- Unsolicited promotion and the same message cross-posted across channels
- Group dogpiling in response to that spam. **This is the actual violation**, and the spammer is usually not the person at fault

So the harassment classifier is not the highest-value component. Reporting and evidence preservation are, and cross-post detection addresses the most common trigger.

**Governance.** HESA is a student organization with annual officer turnover and no dedicated IT staff. Code and infrastructure must survive a change of maintainer. Prefer boring and obvious over clever.

## 2. Settled decisions

These were decided deliberately. Do not propose alternatives unless something here turns out to be technically impossible, in which case stop and say so rather than substituting.

| Decision | Rationale |
| --- | --- |
| **Cloudflare Workers**, not Render, Fly, Lambda or Cloud Run | Free at this scale, no cold starts, no billing account or card. Render's free tier cold-starts for 30–60s, which breaks Slack's 3s acknowledgment |
| **TypeScript**, Hono or itty-router | Small, Workers-native |
| **No Slack Bolt** | Bolt assumes a Node server and does not run cleanly on Workers. Signature verification is written by hand with WebCrypto HMAC-SHA256, roughly thirty lines |
| **A custom app, not Workflow Builder** | Workflow Builder is a paid Slack feature. Custom apps work on Free |
| **Google Drive for the archive**, via a service account | Harvard owns the Shared Drive, keeping records in University infrastructure. The service account is a Content Manager on one folder |
| **Workers KV** for event deduplication | Slack retries on timeout; dedupe on `event_id` |
| **HESA GitHub organization** | Never a personal account |

**Things that are deliberately absent**, not oversights: no database beyond KV in Phase 1, no message archive of unflagged content, no admin web UI, and no DM access of any kind.

**A constraint worth internalizing:** Slack's Free plan hides messages after 90 days and deletes data after a year. The archive is therefore the only durable record, which is why archive-write failures are treated as critical rather than logged and forgotten.

## 3. Phase 1 scope (shipped), and what's been built since

Phase 1 was deliberately small — build only that first — and it shipped as scoped. This section now also records what's been added on top of it, since a lot has: this is no longer a Phase 1 codebase, but Phase 1 is still the foundation everything else sits on, and the constraints in Section 4 apply to all of it equally, not just the original scope.

**Phase 1 — in scope (shipped)**

1. Request handling with Slack signature verification
2. `/report` slash command with a modal, including anonymous filing
3. Flag-emoji reaction handler
4. Moderator alerts posted to a private `#mod-alerts` channel
5. Archive writer to the Google Shared Drive
6. Event deduplication via KV

**Built since Phase 1.** Each of these was designed and explicitly approved before being built, the same way Phase 1 was — see git history for the sequence, and the README for full operational detail. None of it relaxes Section 4; in particular none of it takes automated action on a message or a member.

- **Membership verification (access-queue).** A Google Form plus Apps Script front end relays submissions here, which posts an approval card — Approve / Request info / Deny buttons — to a private `#access-queue` channel. The moderator's decision is relayed back to Apps Script, which emails the applicant, and an Approve also logs the member to a roster spreadsheet.
- **Deprovisioning / annual re-review.** A separate bound Apps Script (`google-apps-script/access-roster-report.gs`) compares the roster against a yearly reconfirmation Form and produces a "Needs Review" report for a human — it never removes anyone itself, since Slack's Free plan has no removal API anyway. Its `Removed` tab tracks people actually taken off the roster; a prior *conduct* removal (as opposed to a routine lapsed one) now surfaces as a warning on a later reapplication, still purely informational.
- **Shadow-mode pattern detection.** The app now reads `message.channels`, which supersedes the old "not in this phase" line below — see that paragraph for what changed and why it's still scoped. Two detectors run on it, both currently in shadow mode: findings post to a private channel for moderators to look at, nothing is actioned automatically.
  - Cross-post/spam detection: near-identical messages posted across channels in a short window.
  - Stage 1 harassment/hate scoring via the OpenAI Moderation API (free), deliberately scoped to harassment and hate only, excluding e.g. self-harm and sexual content categories.
- **Unified repeat-flag counter** (`src/repeatFlags.ts`). Tallies flags across all three sources above — member emoji-flag, cross-post, moderation score — per user over a 30-day window, so a moderator sees one combined count and a breakdown by type instead of three separate tallies.

**On `message.channels`.** Phase 1 deliberately did not subscribe to message events at all — the only events consumed were `reaction_added` and interactivity payloads, and message scopes existed only so the reaction handler could fetch a flagged message's context, not so the app could watch a channel. That changed for the two shadow-mode detectors above, which do need to see channel messages to do their job. This is still a scoped exception, not a general archive: unflagged message content is not retained past the detection window, no DM or private-channel scope was added, and nothing here takes action on its own — see Section 4's "no automated enforcement" and "minimize retained content." Any further widening of what's read or stored is still an escalation per Section 10.

**Still not built, on purpose.** LLM tier assignment / a Stage 2 review pass (deferred pending more shadow-mode data), digests, on-call rotation, and auto-dismissal. And permanently, not just "for now": any automated action of any kind — that's a Section 4 hard constraint, not a scope decision that later phases revisit.

**Why Phase 1 shipped in this order.** Reporting catches the serious cases that a classifier cannot see anyway, since harassment moves to DMs which are invisible to this app by design. Shipping reporting first also meant something real was running before the WhatsApp migration brought a large influx.

**Phase 1 build sequence.** Signature verification first, because nothing else is testable without it. Then the archive writer, because everything else depends on records landing. Then `/report`, then the reaction handler, then alert formatting.

## 4. Hard constraints

Violating any of these breaks the system or the policy it implements.

**Acknowledge within 3 seconds.** Slack retries any request not answered with HTTP 200 in 3 seconds, up to three times. Verify, acknowledge, then do the work in `ctx.waitUntil()`. Never await a Drive or Slack API call before responding.

**Deduplicate on `event_id`.** Retries still occur on timeout. Write the id to KV with a short TTL and discard repeats, or moderators see triplicate alerts.

**Verify every request.** HMAC-SHA256 over `v0:{timestamp}:{body}` against the signing secret, compared in constant time, rejecting timestamps older than 5 minutes. Without this, anyone who learns the endpoint can inject fabricated evidence into a moderation record.

**No automated enforcement, ever.** The app never deletes, edits, warns, mutes, suspends, or removes anyone. Every output is a notification to a human. This is a policy requirement, not a preference — an automated sanction landing on someone quoting harassment in order to report it would be worse for HESA than the original incident.

**Never request DM scopes.** No `im:history`, `mpim:history`, or user tokens. HESA has publicly told members that DMs are not monitored. The app must be technically incapable of it so the claim is verifiable from its scopes.

**Anonymity is real.** If a reporter files anonymously, their user ID appears nowhere: not in the alert, not in the archive record, not in logs. Do not keep a hidden mapping.

**Minimize retained content.** Store message text only for reported or flagged incidents. This app must not become a general message archive by accident.

**No secrets in the repository.** Not in code, not in `wrangler.toml`, not in test fixtures. Use `wrangler secret put` and the `.dev.vars` file, which is gitignored.

## 5. Repository and conventions

```
src/
  index.ts            entry, routing, fast ack
  slack/
    verify.ts         HMAC-SHA256 signature verification
    api.ts            typed fetch wrappers for the Web API
    blocks.ts         Block Kit builders
    modal.ts          /report modal definition
  handlers/
    report.ts         slash command + view submission
    reaction.ts       flag emoji
  archive/
    drive.ts          Google auth + Drive writes
    schema.ts         record types
  dedupe.ts           KV helpers
test/
docs/                 this brief and the build spec
wrangler.toml
.dev.vars.example     names only, never values
```

**Conventions**

- Strict TypeScript. Types for every Slack payload consumed; do not pass `any` around
- Handlers are pure where possible, with side effects isolated in `slack/api.ts` and `archive/drive.ts`, so both can be faked in tests
- Errors never swallowed. Archive failures in particular must surface loudly (Section 8)
- Small commits with clear messages. The audience is a successor with no context
- No dependency added without a reason recorded in the README

**README is a deliverable, not an afterthought.** It must let a future Director of Technology who has never seen this code deploy it: prerequisites, local run, how to set each secret, how to deploy, what each external dependency is and what happens if it disappears. Write it as you go.

**Local development.** `wrangler dev` with a tunnel for Slack to reach. Keep a small set of recorded Slack payloads as fixtures so handlers can be tested without a live workspace.

## 6. Configuration and secrets

**Secrets** (`wrangler secret put NAME`, and `.dev.vars` locally):

| Name | What it is |
| --- | --- |
| `SLACK_SIGNING_SECRET` | Verifies inbound requests. From the Slack app's Basic Information page |
| `SLACK_BOT_TOKEN` | `xoxb-…`. Calls the Web API |
| `GOOGLE_SA_KEY` | Service-account JSON key, stored as a single-line string, parsed at runtime |

**Plain variables** (`wrangler.toml` `[vars]`, not secret):

| Name | What it is |
| --- | --- |
| `MOD_ALERTS_CHANNEL` | Channel ID for `#mod-alerts`, a `C…` id, not a name |
| `ARCHIVE_FOLDER_ID` | Google Drive folder ID for the archive |
| `FLAG_EMOJI` | Name of the custom reaction emoji, without colons |

**KV namespace:** one binding, `DEDUPE`, for `event_id` keys with a TTL of roughly 10 minutes.

**Google authentication.** Workers has no Google client library, so mint a JWT signed with the service account's private key using WebCrypto RS256, exchange it at the token endpoint for an access token, and cache that token in KV until shortly before it expires. Scope it to `drive.file`, which limits the app to files it creates.

**Never committed:** `.dev.vars`, the service-account JSON, any `xoxb-` token, the signing secret. Commit `.dev.vars.example` with names and empty values.

**On rotation.** Every one of these is rotated at each change of Director of Technology. Nothing should hardcode a value such that rotation requires a code change.

## 7. Slack surfaces

### `/report`

Acknowledge the command, then call `views.open` within 3 seconds. Modal fields:

| Field | Type | Required |
| --- | --- | --- |
| What happened | `plain_text_input`, multiline | Yes |
| Where | `static_select`: channel list plus a "direct message" option | Yes |
| When | `plain_text_input`, approximate is fine | No |
| Who was involved | `plain_text_input` | No |
| File as | `radio_buttons`: named or anonymous | Yes |

Use a **plain text field** for who was involved, deliberately not a user picker. A picker turns naming someone into a two-click action and makes the form feel like an accusation machine.

On submission: write the archive record, post the alert, then respond to the reporter ephemerally confirming receipt and stating that acknowledgment follows within 48 hours per the moderation policy.

Slack file uploads inside modals are awkward. If a clean implementation is not available, omit the screenshot field in Phase 1 and tell the reporter they can share an image with a moderator directly. Do not build a half-working upload.

### Flag emoji

On `reaction_added`, filter to `FLAG_EMOJI`. Fetch the message via `conversations.history` with `latest`/`inclusive`, and the preceding 3 messages for context. Build the permalink with `chat.getPermalink`. Post an alert marked as member-reported, with the reporter visible to moderators only.

The reaction is publicly visible in-channel; that is inherent, and members are told as much. `/report` is the private route.

### Alerts

Post to `MOD_ALERTS_CHANNEL`. Include: the reported content or message, author and channel, timestamp, permalink, three messages of preceding context visually distinguished from the subject, and the report type. **No action buttons in Phase 1** — alerts are read-only, and moderators act manually per the policy. Omit the reporter field entirely for anonymous reports rather than showing a redaction mark, since redactions invite people to ask what is behind them.

### Deduplication

Several members flagging the same message produces one alert, not several. Key on channel plus message timestamp.

## 8. Archive writer

The most important component. Slack hides messages at 90 days and deletes at one year, so if this fails, HESA has no record when a complaint surfaces months later.

**Write one JSON file per incident** to `ARCHIVE_FOLDER_ID` via the Drive API, named `{incident_id}.json`:

```json
{
  "incident_id": "2026-0042",
  "captured_at": "2026-09-17T14:22:03Z",
  "source": "report | emoji",
  "anonymous": false,
  "reporter_user_id": "U…",
  "channel": "C…",
  "permalink": "https://…",
  "report_text": "…",
  "flagged_message": { "user_id": "U…", "ts": "…", "text": "…" },
  "context": [ { "user_id": "U…", "ts": "…", "text": "…" } ]
}
```

**Store Slack user IDs, never display names.** Display names change; IDs do not.

When `anonymous` is true, `reporter_user_id` is omitted from the object entirely rather than nulled.

**Incident IDs.** Sequential per year. Keep the counter in KV, and accept that a rare collision under concurrency is tolerable at this volume — but make ID generation a single function so it can be replaced later.

**Failure behavior is the one place to be loud.** If the Drive write fails, retry with exponential backoff, and if it still fails, post a clearly-marked failure notice into `#mod-alerts` containing the record so a human can preserve it manually. Never drop an archive write silently. A moderation system running with a broken archive looks fine and is worthless, and nobody discovers it until evidence is needed and gone.

**Do not write anything for unflagged messages.** There is no general archive.

The log-row spreadsheet described in the build spec is Phase 2. For now the JSON files are the record.

## 9. Acceptance criteria

Phase 1 is done when all of these pass against the real workspace.

**Security**

- [ ] A request with a bad signature is rejected with 401
- [ ] A request with a timestamp older than 5 minutes is rejected
- [ ] A valid request is accepted
- [ ] No secret appears anywhere in the repository or in `git log`

**Timing**

- [ ] Every endpoint responds in well under 3 seconds, including when Drive is slow
- [ ] A replayed `event_id` produces no second alert

**`/report`**

- [ ] The command opens the modal
- [ ] A named submission produces an alert and an archive file
- [ ] An anonymous submission produces both, with the reporter's ID absent from the alert, the file, and the logs
- [ ] The reporter sees an ephemeral confirmation

**Flag emoji**

- [ ] The flag emoji produces an alert with message, context, and a working permalink
- [ ] Other reactions produce nothing
- [ ] Two members flagging the same message produce one alert

**Archive**

- [ ] The file lands in the correct Drive folder and is readable by a moderator
- [ ] A simulated Drive failure produces a visible failure notice in `#mod-alerts` containing the record
- [ ] Nothing is written for ordinary unflagged messages

**Handover**

- [ ] README lets someone who has never seen the project deploy it from scratch
- [ ] Every secret is set via `wrangler secret`, and rotating one requires no code change

The simulated Drive failure test is not optional. Silent archive loss is the failure mode that makes this entire system worthless while appearing to work.

## 10. Escalate, do not decide

Stop and ask the human rather than choosing on your own:

- **Anything that would widen scopes**, especially toward DMs or private channels. If something seems to need `im:history`, the design is wrong, not the scope list
- **Anything that would take automated action** on a message or a member
- **Storing more content than Section 4 allows**, including any "just in case" logging of unflagged messages
- **Adding a paid dependency**, or anything requiring a billing account. The project is deliberately built to need neither
- **Changing the archive destination** away from the Harvard-owned Shared Drive
- **Any change to anonymity handling**

**Known unresolved items**

- Whether modal file upload for screenshots is workable. Omit it rather than shipping something partial
- Whether the Google Cloud project can run with billing disabled. This is being tested separately; if Drive API calls fail with a billing error, report it and stop rather than working around it
- Incident ID generation under concurrent submissions is best-effort for now

**Context you should have.** Two companion documents exist: the build spec (full design, phases 2 to 4, classifier design) and the moderation policy (severity tiers, escalation matrix, what happens to a report after an alert fires). If a design question is not answered here, check the build spec before improvising.

**Tone check for anything user-facing.** Every string a member reads — modal labels, confirmations, error text — is read by students who may be upset. Plain, calm, and non-accusatory. No jokes, no bot personality. Someone filing a report about being harassed should not meet a chatty interface.
