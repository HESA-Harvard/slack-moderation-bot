# HESA Moderation Bot

A Slack app for the Harvard Extension Student Association: report intake (`/report`
and a flag emoji), moderator alerts, and evidence archiving to a Google Shared
Drive. Built for Slack's Free plan on Cloudflare Workers.

Read `CLAUDE.md` first — it's the authoritative scope document for what's built
and, just as importantly, what's deliberately left out. `docs/build-spec.md` and
`docs/moderation-policy.md` cover the full multi-phase design and the
moderation rules this app supports; this repo currently implements Phase 1
only (reporting + archiving, no classifier, no action buttons).

This document is written for a successor with no prior context — HESA's
leadership turns over every year, and there is no dedicated IT staff.

## Prerequisites

- Node.js 20+ and npm
- A [Cloudflare account](https://dash.cloudflare.com) (free tier is sufficient) and the `wrangler` CLI (installed via `npm install`, no separate setup)
- A Slack app already created in the HESA workspace at api.slack.com/apps (see "Slack app setup" below)
- A Google Cloud service account with access to a folder in a Harvard-owned Google Shared Drive (see "Google Drive setup" below)

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in real values, this file is gitignored
npm run typecheck
npm test
npm run dev                       # wrangler dev; use a tunnel (e.g. cloudflared) for Slack to reach it
```

`npm test` runs the full suite against a real Workers runtime via
`@cloudflare/vitest-pool-workers` — no live Slack workspace or Google project
needed; Slack and Drive calls are mocked. `test/fixtures/` holds recorded
Slack payload shapes for `url_verification`, `reaction_added`, the slash
command, and a `view_submission`.

## Deploying

```bash
wrangler login                    # one-time, links this machine to the Cloudflare account
wrangler kv namespace create DEDUPE
# paste the returned id into wrangler.toml's [[kv_namespaces]] block

wrangler secret put SLACK_SIGNING_SECRET
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put GOOGLE_SA_KEY   # the full service-account JSON key, as one line

npm run deploy
```

After deploying, set the Slack app's Request URLs (see below) to the
deployed Worker's `*.workers.dev` URL (or a custom domain if one is set up).

## Slack app setup

Create the app at api.slack.com/apps, scoped to the HESA workspace only, and
do **not** list it in the Slack Marketplace.

**Bot token scopes:** `channels:history`, `channels:read`, `channels:join`,
`users:read`, `chat:write`, `commands`, `reactions:read`. Do not add
`im:history`, `mpim:history`, or any user token scope — the moderation
policy tells members DMs are not monitored, and the app must be technically
incapable of it. `channels:join` only lets the bot join *public* channels it's
told about via `channel_created` (see below) — Slack doesn't fire that event
for private channels, so it can't be used to reach into one.

**Event subscriptions:** `reaction_added` and `channel_created`. This app
does not subscribe to `message.channels` in Phase 1 — see CLAUDE.md Section 3
for why. `channel_created` exists solely so the bot auto-joins new public
channels (see "Auto-join" below) — it carries only the channel's id and name,
nothing else.

**Slash commands:** register `/report`.

**Interactivity:** enable it; handles `view_submission` (the `/report` modal)
and `block_actions` (the Approve/Request info/Deny buttons on access-queue
alerts — see "Access requests" below). Phase 1's own alerts are still
read-only; only the access-queue alerts have buttons.

**Request URLs**, all pointing at the deployed Worker:
- Event Subscriptions: `https://<worker-url>/slack/events`
- Slash Commands (`/report`): `https://<worker-url>/slack/commands`
- Interactivity: `https://<worker-url>/slack/interactivity`

Note `https://<worker-url>/forms/verification-submit` is a *separate*
endpoint, not a Slack Request URL — see "Access requests" below.

**Custom emoji:** create a `:flag-for-review:` emoji in workspace settings
(Settings → Customize → Emoji) so it's distinct from ordinary reactions. If a
different name is used, update `FLAG_EMOJI` in `wrangler.toml` to match.

**Channel membership (auto-join):** the bot joins new public channels
automatically via the `channel_created` event and `conversations.join` — see
`src/handlers/channelCreated.ts`. This only covers channels created *after*
the app is installed; invite it to any pre-existing channels once, manually
(`/invite @HESA Moderation Bot`). It receives no events for channels it
hasn't joined.

## Google Drive (archive) setup

1. Create a Google Cloud project under a HESA-controlled account (not a
   personal one), then immediately add a second officer as an IAM Owner.
2. Enable the Drive API, create a service account, and generate a JSON key
   for it. That key's full contents (as one line) is the `GOOGLE_SA_KEY`
   secret.
3. In the HESA Google Shared Drive, create a folder for the archive and add
   the service account's email as a **Content Manager** on that folder only
   — never on the whole Shared Drive.
4. Put that folder's ID (from its URL) into `ARCHIVE_FOLDER_ID` in
   `wrangler.toml`.

Keep a break-glass copy of the service-account key in HESA's password vault.
Rotate it, along with the Slack secrets, at every leadership transition.

## Access requests (membership verification)

The Slack workspace is open to current HES students only — degree-seeking
students, or students registered for a course in the current academic year.
There's no way to verify that automatically (no integration with Harvard's
registrar), so a human always makes the actual call; this feature only
removes the toil around getting them what they need to decide.

**Why this isn't a single system.** Slack's bot-token API has no method to
invite someone to a non-Enterprise workspace — `admin.users.invite` is
Enterprise Grid only, and the old `users.admin.invite` needs a legacy token
type Slack no longer issues. So sending the actual invite has to happen
somewhere else: a Google Apps Script project, `google-apps-script/access-queue.gs`,
sends applicant emails via `MailApp` (free, no new account). It is **not**
deployed by `wrangler` — copy it into script.google.com per the setup
comment at the top of that file.

**Flow:**
1. Applicant submits the Google Form (HESA-controlled account, not personal).
   Required question titles and options are listed in `access-queue.gs`'s
   header comment — Apps Script looks them up by exact title/option text, so
   the Form's "Which best describes you?" options must match
   `STATUS_OPTION_TO_CODE` there exactly (and `ApplicantStatus`/
   `STATUS_LABELS` in `src/verification/schema.ts` — the two must stay in
   sync by hand, there's no shared source of truth across the Apps
   Script/TypeScript boundary). The Form does **not** ask for email as a
   typed question; Form Settings → Responses → "Collect email addresses" →
   **Verified** is turned on instead, so the email is tied to the
   respondent's signed-in Google account rather than being self-typed text.
   (Only admitted degree candidates reliably have a `g.harvard.edu` account
   — other categories often use a personal Gmail — so the Form is not
   domain-restricted; the alert instead flags a mismatch for the reviewer on
   the two degree-candidate options only, see below.) The multiple-choice
   question also means the Form's own "Responses" summary tab gives HESA a
   free breakdown of applicant categories — no extra plumbing needed for
   that. The Form also has a required "Community guidelines & access"
   checkbox; that one is Form-only, never read by Apps Script or the Worker
   — its record is the Form's own response log.
2. Apps Script's `onFormSubmit` trigger relays the row to the Worker's
   `POST /forms/verification-submit`, authenticated with a shared secret
   (`FORM_INTEGRATION_SECRET`) — not a Slack signature, since this request
   doesn't come from Slack.
3. The Worker posts an alert to `#access-queue` (`ACCESS_QUEUE_CHANNEL`)
   with **Approve / Request info / Deny** buttons. A degree-seeking claim
   paired with a non-`g.harvard.edu` email gets a visible warning on the
   alert — a hint for the reviewer, never an automatic block, since a
   legitimate course-taker commonly lacks that domain.
4. A moderator clicks one of the three buttons. None of them are terminal —
   clicking one appends a status line to the alert (`chat.update`) but
   leaves all three buttons live, since a "Request info" reply might lead to
   Approve days later on the same message.
5. The Worker calls back into the Apps Script Web App (same shared secret,
   sent in the JSON body this time — Apps Script's `doPost` can't read
   custom request headers, only the body and query string), which emails
   the applicant: the Slack invite link on Approve, a request for further
   proof on Request info, or a decline with appeal instructions on Deny.
   All three emails set Reply-To to `hesa@g.harvard.edu` (not the individual
   moderator) so replies land somewhere durable across officer turnover.

**Invite-link expiry, and the use-count warning.** Slack's shared invite
link supports two independent limits — a use count and a time-based expiry
— either of which kills the link. This app's invite link is set to **Never
expires** in Slack's own admin settings (Settings & administration → Invite
people), deliberately, so the 400-use cap (fixed, not adjustable) is the
*only* limit in play — because that's the one limit this app can actually
see coming. There is no Slack API to read a shared invite link's real
remaining uses, so `src/verification/inviteLinkGuard.ts` tracks its own
count instead: it increments a KV counter on every Approve (a reasonable
proxy, since this flow is the link's only distribution channel) and, once
that count crosses 350, posts a warning to `#access-queue` with a **"Mark
link refreshed"** button. Clicking it resets the counter for the next cycle.
If expiry is ever turned back on, this tracking becomes blind to it again —
there's no scheduled check for time-based expiry, so a quiet week could let
the link go dead with no warning. Leave expiry off unless there's a specific
reason to turn it on.

**Setup, beyond what's in `access-queue.gs`'s own header:**
- Create `#access-queue` as a private channel and invite the bot — same as
  any private channel, it isn't covered by the public-channel auto-join.
- Set `ACCESS_QUEUE_CHANNEL` and `FORM_CALLBACK_URL` in `wrangler.toml`.
- `wrangler secret put FORM_INTEGRATION_SECRET` — generate a random value,
  and set the *same* value as a Script Property in the Apps Script project.
- In the Slack workspace's admin settings, generate a shareable invite link
  set to **Never expires**, then put it in the Apps Script project's
  `SLACK_INVITE_LINK` Script Property. When `#access-queue` warns that it's
  running low, regenerate it the same way (still Never expires) and click
  "Mark link refreshed."

## Configuration reference

| Name | Kind | Where set | What it is |
| --- | --- | --- | --- |
| `SLACK_SIGNING_SECRET` | secret | `wrangler secret put` | Verifies inbound Slack requests |
| `SLACK_BOT_TOKEN` | secret | `wrangler secret put` | `xoxb-…`, used for all Slack Web API calls |
| `GOOGLE_SA_KEY` | secret | `wrangler secret put` | Service-account JSON key, as one line |
| `MOD_ALERTS_CHANNEL` | var | `wrangler.toml` | Channel ID (`C…`) for `#mod-alerts` |
| `ARCHIVE_FOLDER_ID` | var | `wrangler.toml` | Google Drive folder ID for the archive |
| `FLAG_EMOJI` | var | `wrangler.toml` | Reaction emoji name, without colons |
| `ACCESS_QUEUE_CHANNEL` | var | `wrangler.toml` | Channel ID (`C…`) for `#access-queue` |
| `FORM_CALLBACK_URL` | var | `wrangler.toml` | Apps Script Web App URL (ends in `/exec`) |
| `FORM_INTEGRATION_SECRET` | secret | `wrangler secret put` | Shared secret with Apps Script — both directions, see "Access requests" |
| `DEDUPE` | KV namespace | `wrangler.toml` | Event dedup, alert dedup, incident-id counter, cached Google access token |

Rotating any secret is `wrangler secret put NAME` again — no code change
required.

## What's deliberately not here

Per `CLAUDE.md`: no message classifier, no LLM tier assignment, no cross-post
or pile-on detection, no alert action buttons or triage state, no digests,
and no subscription to ordinary channel messages. These are Phase 2+ in
`docs/build-spec.md`. Screenshot upload in `/report` is also omitted for now
— reporters are told they can share an image with a moderator directly
instead of a half-working upload flow.

## Dependency risk

| Dependency | What happens if it disappears / changes |
| --- | --- |
| Cloudflare Workers | Free tier limits (100K requests/day) are far above this workload; a pricing or policy change would require re-evaluating hosting per `docs/build-spec.md` Section 3 |
| Slack Web API / Events API | Core to the app; a breaking API change would require handler updates |
| Google Drive API | Archive writes fail loudly (a notice lands in `#mod-alerts` with the full record) rather than silently — see `src/archive/drive.ts` — but a sustained outage or API change needs a human fix |
| Hono | Thin routing layer; swappable without touching business logic in `src/handlers/` |

## Architecture

```
src/
  index.ts            Hono app: routing, signature-verify middleware, fast ack
  slack/
    verify.ts          HMAC-SHA256 request verification
    api.ts              Slack Web API fetch wrappers
    blocks.ts            Block Kit builders for alerts
    modal.ts              /report modal definition
  handlers/
    report.ts             /report slash command + modal submission
    reaction.ts             flag-emoji reaction handling
    channelCreated.ts        auto-joins new public channels
    verification.ts           access-queue submit + button handling
  archive/
    schema.ts               incident record types
    drive.ts                  Google auth + Drive writes, with failure fallback
  verification/
    schema.ts                access-request types
    blocks.ts                  #access-queue alert + status-line Block Kit
    formsClient.ts              callback to the Apps Script Web App
    inviteLinkGuard.ts            use-count tracking + refresh warning
  dedupe.ts                  KV helpers: event dedup, alert dedup, incident ids
test/                       unit tests + recorded Slack payload fixtures
google-apps-script/         Apps Script source (not deployed by wrangler — see
                             "Access requests" above)
```
