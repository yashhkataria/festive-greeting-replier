# Festive greeting replier agent

A WhatsApp agent that answers greetings for you. When a saved contact wishes
you for a festival (Diwali, Holi, Eid, Christmas, New Year, any festival, in any
language, including greeting images and stickers), it sends back a fresh
greeting for that festival. When they wish you a happy birthday, it thanks them.
Everything else is left alone. Claude writes each reply.

It's meant to run on your own computer during festival season. It can also run
on a server if you want it on all the time.

> **Read this first.** This uses WhatsApp Web through the unofficial
> [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js) library,
> the only way to automate a personal number. WhatsApp's terms don't allow
> unofficial clients, and accounts that send many automated messages can be
> banned. The agent keeps its activity low and human-like, but the risk is not zero.

## Run it on your computer

Requires Node.js 22.9+ and Google Chrome.

1. `npm install`
2. Copy `.env.example` to `.env` and add your
   [Anthropic API key](https://console.anthropic.com), your name and time zone.
3. `npm run dry-run` prints the replies it would send without sending anything.
   Link WhatsApp by scanning the QR code: WhatsApp → Settings → Linked devices →
   Link a device. You only scan once; the login is saved in `.data/`.
4. `npm start` goes live. On a Mac, use `npm run start:awake` instead (see below).

### Keeping it running on a Mac

`npm run start:awake` runs the agent and:

- **stops your Mac from sleeping on its idle timeout** while the agent runs. The
  screen still turns off and locks as usual; only the system stays awake. It
  goes back to normal as soon as you stop the agent.
- **restarts the agent if it stops unexpectedly**, for example when WhatsApp
  disconnected during a sleep.

A sleeping Mac can't run anything, so the agent only answers while the Mac is
awake. Closing the lid on battery still puts the Mac to sleep; when it wakes,
the agent restarts itself if needed. Greetings that arrived during sleep may not
be answered. Press Ctrl+C to stop.

The agent only answers while it's running. Scheduled replies are saved, so if
you stop it and start it again later the same day, they still go out.

> **Run only one copy.** Each running copy is a separate linked device, and
> they don't share their reply history, so two copies would both reply.

## Optional: run it on a server

To keep it running without your computer, run it as a Docker container on any
host with a persistent disk. Always-on hosting usually costs a few euros a month.
Serverless platforms such as Vercel can't run it: it needs a browser that stays
connected to WhatsApp and a disk that keeps its data. Stop any local copy before
deploying.

### Railway

1. Push this repository to GitHub. A private repository is recommended.
2. In Railway: **New Project → Deploy from GitHub repo**, then pick the
   repository. It builds from the `Dockerfile` automatically.
3. Attach a **volume** to the service with mount path **`/app/.data`**. This
   keeps your WhatsApp login, scheduled replies and history across redeploys.
   Without it you would have to link WhatsApp again after every deploy.
4. Under **Variables**, add at least:
   - `ANTHROPIC_API_KEY`: your [Anthropic API key](https://console.anthropic.com)
   - `PAIR_PHONE_NUMBER`: your WhatsApp number with country code, digits only (e.g. `919876543210`)
   - `MY_NAME` and `TIMEZONE` (e.g. `Asia/Kolkata`)
   - optionally `CLOSE_CONTACTS`, `IGNORE_CONTACTS` and any other setting below
5. Deploy and open the service's **logs**. You'll see a line like
   `Pairing code: ABCD-EFGH`.
6. On your phone: **WhatsApp → Settings → Linked devices → Link a device →
   Link with phone number instead**, then enter the code. The logs then show `Ready.`
7. Send yourself `greeter status` in WhatsApp to check it's running.

Railway restarts the agent if it crashes. Check Railway's current pricing: the
agent runs a headless Chrome and needs about 1 GB of memory.

### Any Linux server (VPS)

On a server with Docker, copy the repository there, create `.env` from
`.env.example` (set `PAIR_PHONE_NUMBER`), then run:

```bash
docker compose up -d --build
```
```bash
docker compose logs -f
```

The pairing code shows in the logs. Data is kept in `./.data` next to the files.

## Kill switch and model switcher

Send these in your WhatsApp **"Message yourself"** chat. This works wherever the
agent runs:

| Message | Effect |
|---|---|
| `greeter pause` | Kill switch: stop all replies and cancel every scheduled one |
| `greeter resume` | Start replying again |
| `greeter status` | On/off, model, today's replies and what's scheduled |
| `greeter model opus` / `sonnet` / `haiku` | Switch the Claude model |

When running locally you can also use `npm run pause`, `npm run resume`,
`npm run status` and `npm run model -- haiku`. Changes survive restarts.

| Model | Notes |
|---|---|
| `opus` (default) | Claude Opus 5.5: most careful judgment |
| `sonnet` | Claude Sonnet 5.5: cheaper, still very capable |
| `haiku` | Claude Haiku 5.5: cheapest and fastest |

## Who gets a reply

- **Saved contacts only.** Numbers not in your phone's contacts are skipped and
  their messages aren't sent to Claude. Set `REPLY_TO_UNKNOWN=1` to change that.
- **Never in groups.** Group messages are dropped before they're opened.
- **Ignore list.** These people's messages aren't opened, downloaded or sent to
  Claude, and they never get a reply.
- **Close people.** When they greet you, the agent doesn't reply. It sends you a
  reminder in "Message yourself" to answer them personally.
- Never your own messages, status updates or channels.
- Messages older than 24 hours are skipped. If the sender can't be identified,
  the message is skipped.

Lists take phone numbers (any format) or names exactly as saved in your phone.
Set them as comma-separated `IGNORE_CONTACTS` / `CLOSE_CONTACTS`, or locally in
`ignore-contacts.txt` / `close-contacts.txt` (see the `.example.txt` files). The
ignore list wins if someone is on both.

## How it replies

- **Random delay.** Each reply waits a random 15 seconds to 5 minutes, then shows
  "typing…" for a few seconds.
- **Quiet hours.** Nothing is sent between 23:00 and 08:00 (your time zone).
  Greetings that arrive then are answered at a random moment between 08:00 and 08:45.
- **Daily limit.** At most 40 automatic replies a day. Greetings beyond that are
  left for you, and you get one notice in "Message yourself".
- **You stay in charge.** If you reply to someone yourself before the agent
  does, it stays quiet.
- **No repeats.** Each person gets one reply per occasion per year, and never
  two automatic replies within 12 hours.
- **Survives restarts.** Scheduled replies are saved and sent after a restart or
  redeploy. If the agent was down for more than 24 hours, stale replies are dropped
  rather than sent late. A reply is never sent twice, even if a send fails.
- **Daily summary.** At 21:30 you get a summary in "Message yourself": who was
  answered, who is waiting for your personal reply, and anything skipped. Days
  with no activity get no summary.
- **Unread stays unread.** Replies don't mark the chat as read on your phone.
- **Fails silent.** Questions about festivals, business promotions, "thanks for
  the wishes" replies and anything uncertain get no reply. Errors from Claude,
  refusals and unreadable answers also mean no reply.

## Settings

Set these as environment variables on your host, or in `.env` locally (see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | required | Claude API key |
| `PAIR_PHONE_NUMBER` | none | Your number (digits, with country code) to link with a pairing code instead of a QR code |
| `MY_NAME` | none | Your name, so birthday wishes meant for others aren't treated as yours |
| `TIMEZONE` | `Asia/Kolkata` | Your time zone, for quiet hours, the summary and "today" |
| `CLAUDE_MODEL` | `opus` | Starting model; switch later with `greeter model ...` |
| `OCCASIONS` | all | Only reply for these, e.g. `diwali,holi,birthday,new-year` |
| `IGNORE_CONTACTS` | none | Comma-separated people to never read or reply to |
| `CLOSE_CONTACTS` | none | Comma-separated people to answer yourself (you get a reminder) |
| `MIN_DELAY_SECONDS` | `15` | Shortest wait before a reply |
| `MAX_DELAY_SECONDS` | `300` | Longest wait before a reply |
| `QUIET_HOURS` | `23:00-08:00` | No replies in this window; `off` to disable |
| `DAILY_REPLY_LIMIT` | `40` | Automatic replies per day; `0` for no limit |
| `SUMMARY_TIME` | `21:30` | Daily summary time; `off` to disable |
| `COOLDOWN_HOURS` | `12` | Minimum gap between two automatic replies to the same person |
| `MAX_MESSAGE_AGE_HOURS` | `24` | Skip greetings older than this |
| `REPLY_TO_UNKNOWN` | `0` | `1` to also reply to numbers not in your contacts |
| `DRY_RUN` | `0` | `1` to print replies instead of sending them |
| `IGNORE_FILE` / `CLOSE_CONTACTS_FILE` | `ignore-contacts.txt` / `close-contacts.txt` | Contact list files |
| `CHROME_PATH` | installed Chrome | Browser used to run WhatsApp Web (set automatically in Docker) |
| `DATA_DIR` | `.data` | Where the login, history and scheduled replies are stored |

Each text, image or sticker from a saved contact who isn't on the ignore list is
sent to Claude, costing a fraction of a cent.

## Privacy

`.data/` (your WhatsApp login), `.env` (your API key) and your contact lists are
git-ignored. Never commit them: the session folder gives full access to your
WhatsApp account. To unlink the agent, remove it under Linked devices on your phone.

## Project layout

| Path | What it does |
|---|---|
| `src/index.js` | Connects to WhatsApp, reads settings, handles phone commands |
| `src/agent.js` | Decides which messages to answer and schedules replies |
| `src/scheduler.js` | Sends scheduled replies; daily limit, kill switch and summary |
| `src/classifier.js` | Asks Claude whether a message is a greeting and writes the reply |
| `src/control.js` | Kill switch and model switcher |
| `src/queue.js`, `src/activity.js` | Saved scheduled replies and the daily activity log |
| `src/time.js` | Time zone, quiet hours and summary-time helpers |
| `scripts/control.js` | Terminal commands for the kill switch and model |
| `scripts/keep-running.js` | `npm run start:awake`: keeps a Mac awake and restarts the agent if it stops |
| `Dockerfile`, `railway.json`, `docker-compose.yml` | Cloud deployment |
| `test/agent.test.js` | Tests, run with `npm test` (no WhatsApp or API calls) |
