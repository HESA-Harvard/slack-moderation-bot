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

**Event subscriptions:** `reaction_added`, `channel_created`, and
`message.channels`. Phase 1 deliberately didn't subscribe to
`message.channels` — see CLAUDE.md Section 3 — but cross-post detection
(below) needs it. `channel_created` exists solely so the bot auto-joins new
public channels (see "Auto-join" below) — it carries only the channel's id
and name, nothing else. `message.channels` is scoped to public channels only
(there's no `message.im`/`message.mpim`/`message.groups` subscription), so
this still can't reach DMs or private channels.

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

## Cross-post detection (shadow mode)

The two most common real problems in this community, per HESA's own
observation, are unsolicited promotion cross-posted across channels and the
dogpiling that follows it — not sneaky one-on-one harassment, which mostly
happens in DMs this app can't see anyway. This is a narrow, rule-based
detector for the cross-post half of that. It is **not** the classifier
described in `docs/build-spec.md` Section 4 (no Perspective API, no LLM, no
new paid dependency) — that's deliberately deferred; see "What's deliberately
not here" below.

**What it does.** Every public-channel message (`message.channels`) is
checked: same author, same message text (normalized and hashed — the text
itself is never stored), posted in 3 or more distinct channels within 10
minutes. When that threshold is crossed, one alert posts to a private shadow
channel — not `#mod-alerts` — with the message text, author, and a permalink
to each occurrence. See `src/patterns/crossPost.ts` for the exact mechanics
and `src/handlers/messageEvent.ts` for the event filtering (subtype/bot
messages/short messages are all skipped before anything is hashed). Alert
messages set `unfurl_links: false` (see `src/slack/api.ts`) so Slack doesn't
turn every permalink into its own preview card — otherwise an author hitting
many channels would produce an enormous alert.

**Repeat-flag count.** Alongside the burst detector above, `recordRepeatFlag`
tracks how many times each author has *triggered an alert* (not just posted
a message) over a rolling 30 days. When an author's count is 2 or higher,
the alert gets an extra line: "Repeat pattern — Nth cross-post flag for this
author in the last 30 days." This is deliberately just visible context for
a human, never an automated escalation — see "What's deliberately not here"
for why that boundary matters here specifically, not just as a general rule.

**Why shadow mode, not live.** Per `docs/build-spec.md`'s own phasing, running
silently in a channel only the Director of Technology (and maybe one
moderator) can see — with nothing acted on — is what lets the 3-channels/
10-minutes thresholds get tuned against HESA's actual traffic instead of
guessed at. Going live also triggers a community disclosure obligation per
`docs/moderation-policy.md` Section 3 ("HESA discloses its monitoring rather
than conducting it quietly") that shadow mode doesn't, since nothing here is
acted on or shown to moderators generally.

**Data minimization.** KV stores a SHA-256 hash of the normalized message
text plus channel/timestamp pairs, never the text itself, on a TTL fixed to
the detection window — it expires whether or not a threshold is ever
crossed. The message text that *does* appear in an alert comes from the live
event that triggered it, not from anything persisted. Nothing is written to
the Drive archive in shadow mode.

**What's deliberately not here.** Pile-on/dogpile detection was designed
(reply-volume spikes in a thread) and deliberately cut: at 2,000 members, a
popular thread can organically pull in several replies within minutes, and a
purely volume-based heuristic can't tell that apart from an actual pile-on
without some read on tone or intent — which means real language analysis,
not a bigger version of this same rule-based approach. That's a different,
harder problem, likely bundled with a future classifier phase rather than
built standalone.

Also deliberately not here: any kind of automated "N strikes" escalation for
repeat offenders — CLAUDE.md's "no automated enforcement, ever" rules out an
automated action, but this specifically isn't a fit even as a severity bump.
`docs/moderation-policy.md` Section 5 already defines repeat-offender
handling ("a prior *finding* at any tier within 12 months" as an aggravating
factor), and a finding is a moderator's adjudicated decision, not a raw
detector flag — conflating the two would let this heuristic quietly drive
outcomes the policy reserves for humans. Unsolicited-promotion posting is
also explicitly a Tier 0 example in that same section, HESA's mildest
category, handled with an informal redirect or DM. The repeat-flag count
above is as far as this goes: visible context for a human, nothing more.

**Setup:**
- Create a private shadow-alerts channel and invite the bot (not covered by
  public-channel auto-join), then set `SHADOW_ALERTS_CHANNEL` in
  `wrangler.toml`.
- Add `message.channels` under Event Subscriptions (see "Slack app setup"
  above).

## Stage 1 moderation scoring (shadow mode)

`docs/build-spec.md` Section 4 specifies Google's Perspective API for Stage
1 scoring — but Perspective API stops serving requests December 31, 2026
with no Google-provided migration path, so this uses **OpenAI's free
Moderation API** (`omni-moderation-latest`) instead. It's free, run by an
established vendor, and — the specific thing `docs/build-spec.md` Section 9
requires checking before launch — its API data is not used to train
OpenAI's models by default, with a bounded 30-day retention window. See
`src/patterns/moderationScoring.ts` for the client.

**Scoped categories: `harassment`, `harassment/threatening`, `hate`,
`hate/threatening` only.** OpenAI's endpoint also scores `self-harm` and
`sexual` categories, both deliberately excluded here, not just left for
later:
- `self-harm` needs the specialized crisis-resource routing the build spec
  calls for — never a sanction, involving the Dean of Students office — and
  that's a distinct feature requiring its own careful design, not a side
  effect of a generic harassment filter.
- `sexual` (non-threatening) risks flagging exactly the good-faith trauma
  disclosure CLAUDE.md is explicit is a context mismatch, not misconduct
  ("members occasionally post heavy personal trauma... nothing in this
  system should flag, remove, or record it as a violation").

The scoped `flagged` check is computed from those four categories only —
**not** OpenAI's own top-level `flagged` field, which also covers the
excluded categories.

**No Stage 2.** The build spec pairs Stage 1 with an LLM call (Stage 2) that
reads surrounding context and assigns a policy tier — deliberately not
built yet. Shipping Stage 1 alone risks the same failure mode already ruled
out for pile-on detection above: a bare score with no read on intent will
flag reclaimed language, jokes, and quoted speech at a real rate. Two
mitigations while Stage 2 doesn't exist: this stays in shadow mode (nothing
reaches `#mod-alerts` or a moderator generally), and a flagged message's
alert includes 3 preceding messages of context (`fetchMessageWithContext`,
the same helper the flag-emoji handler uses) so a human has something to
read instead of just a raw score. Shadow-mode results are the actual
evidence for whether Stage 2 turns out to be necessary, rather than
assuming it upfront.

**Failure handling.** Unlike the archive writer, a moderation-scoring
failure (API down, timeout) fails open — the message is skipped and logged,
never blocking ordinary message processing. This is a best-effort shadow
calibration signal, not the archive's "never drop evidence silently"
guarantee, so a quiet skip is the proportionate response here.

**Setup:** `wrangler secret put OPENAI_API_KEY` — from an OpenAI Platform
account (no card required to create one, as of this writing). No new
channel or event subscription needed; this runs inside the same
`message.channels` handler as cross-post detection.

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
| `SHADOW_ALERTS_CHANNEL` | var | `wrangler.toml` | Channel ID (`C…`) for the private shadow-mode channel (cross-post + moderation scoring) |
| `OPENAI_API_KEY` | secret | `wrangler secret put` | OpenAI API key, for Stage 1 moderation scoring |
| `DEDUPE` | KV namespace | `wrangler.toml` | Event dedup, alert dedup, incident-id counter, cached Google access token, cross-post tracking |

Rotating any secret is `wrangler secret put NAME` again — no code change
required.

## What's deliberately not here

Per `CLAUDE.md` and later scoping decisions: no Perspective API or LLM
classifier, no tier assignment, no pile-on/dogpile detection (see "Cross-post
detection" above for why — it needs real language analysis, not a bigger
version of the rule-based cross-post detector), no action buttons or triage
state on `#mod-alerts` itself (the access-queue and cross-post-warning alerts
do have buttons — that's a separate, later decision), and no digests. These
are open per `docs/build-spec.md`'s later phases. Screenshot upload in
`/report` is also omitted for now — reporters are told they can share an
image with a moderator directly instead of a half-working upload flow.

Message content *is* now read (`message.channels`, for cross-post detection
only, shadow mode only) — this was true from early on in this repo's history
but is worth restating here since Phase 1's original design explicitly
didn't do this; see "Cross-post detection" above for the full reasoning and
scope of what changed.

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
    messageEvent.ts             message.channels dispatch (cross-post + moderation scoring)
  archive/
    schema.ts               incident record types
    drive.ts                  Google auth + Drive writes, with failure fallback
  verification/
    schema.ts                access-request types
    blocks.ts                  #access-queue alert + status-line Block Kit
    formsClient.ts              callback to the Apps Script Web App
    inviteLinkGuard.ts            use-count tracking + refresh warning
  patterns/
    crossPost.ts              hashing + KV tracking + threshold logic
    moderationScoring.ts        OpenAI Moderation API client (Stage 1)
    blocks.ts                     shadow-mode alert Block Kit
  crypto.ts                  toHex — shared by request verification and cross-post hashing
  dedupe.ts                  KV helpers: event dedup, alert dedup, incident ids
test/                       unit tests + recorded Slack payload fixtures
google-apps-script/         Apps Script source (not deployed by wrangler — see
                             "Access requests" above)
```
