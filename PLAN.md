# opencode-rc — Remote Control for opencode

> Control your coding agent from your phone. Start with Telegram, then Discord, then a mobile app.

## 1. The problem in plain English

opencode is a coding helper that lives in your terminal. It can read files, edit code, and run commands for you.

The problem: you have to sit at your computer to use it. If you go for coffee, travel, or just move to your phone, you lose control.

If opencode needs your permission to do something, it stops and waits. You are not there, so work stops.

What we want: message opencode from Telegram or Discord like you message a friend, and later from a simple phone app. Say "run the tests and fix what fails" from the train, and your computer at home does it and replies back.

## 2. What Claude Code already does

Claude Code solved this with two ideas. We will copy them because they are simple and proven.

**Remote Control:** Your session keeps running on your computer. You open the same session from your phone or browser. Same files, same memory, just a different screen.

**Channels:** Your session connects to Telegram or Discord through a small bridge. You send a message to a bot. The bridge gives it to the coding session. The session works and replies back in the same chat.

Three rules from Claude we must copy:

1. Only you can talk to your bot. Strangers are ignored. This is called an allowlist.
2. First time you connect, you pair with a code, like pairing Bluetooth.
3. The computer must stay on. If you close the laptop, the bot goes quiet.

## 3. What already exists for opencode? Honest review

Yes, this idea already exists for opencode, but only as community projects. There is no official Telegram, Discord, or phone app from the opencode team.

I checked all of them:

**For Discord (best one):**
kimaki (1,400 stars). You run `npx -y kimaki@latest`. Each Discord channel becomes one project. Each thread becomes one coding session. It has queue, worktrees, diff links, voice messages, and model switching. It needs OpenCode v2. This is the model to learn from.

**For Telegram (many small ones, no clear winner):**
- opencode-channel-adapters — clean set of Telegram, Discord, and Feishu adapters with one shared core. Simple polling, session file, config check. Best code to start from.
- opencode-telegram-bridge — Telegram bridge with setup wizard and background service support.
- grinev bot, artickc bot, remote-opencode-telegram — more commands like projects, models, worktrees, scheduled tasks, but heavier and harder to change.
- opencode-tbot and teleprompt — run inside opencode as a plugin. They die when you close opencode. Not good for always-on remote.

**For phone (web pages, not real apps yet):**
- portal (813 stars). Run `bunx openportal`. A mobile-friendly website for opencode. You connect through Tailscale VPN.
- CodeNomad (2,600 stars). Desktop + browser workspace for opencode. Has password login, HTTPS, and remote access through a relay so you do not open ports. Needs OpenCode v2.

**The gap:** No single project gives you Telegram + Discord + phone app with the same simple quality. Most Telegram bots are old, built for opencode v1, and break on v2. Most are built by one person for themselves. None has the clean pairing, allowlist, and permission buttons that Claude has.

That is why it still makes sense to build opencode-rc.

## 4. Our solution in one paragraph

We will build one small bridge server. It sits next to opencode on your computer. On one side it talks to opencode. On the other side it talks to Telegram first, Discord second, and a phone app third. You message the bot, the bridge passes it to opencode, opencode does the work, the bridge sends the answer back. You stay in control with Approve and Deny buttons on your phone.

We will not fork opencode. We will use its official door: `opencode serve` + SDK.

```
Your phone (Telegram / Discord / App)
        |
        |  internet (Telegram/Discord servers)
        v
Bridge bot (our code, runs on your computer)
        |
        |  local only: http://127.0.0.1:4096 + live events
        v
opencode serve (your files, your models, your keys)
```

## 5. How it works, step by step, no jargon

1. You start opencode in server mode on your computer. It waits on port 4096, only for programs on the same computer.
2. You start our bridge program on the same computer. It connects to opencode.
3. You send "fix the login bug" to your Telegram bot from your phone.
4. Telegram sends it to the bridge.
5. Bridge checks: is this really you? If not, it ignores it.
6. Bridge asks opencode: start or continue a session for this chat, and send this message.
7. opencode reads code, edits files, runs tests.
8. If opencode needs permission ("can I run rm -rf?"), bridge sends you buttons: Approve once / Always / Deny.
9. When done, bridge sends the result back to Telegram in short pieces. Long answers are split because Telegram allows only about 4,000 characters per message.
10. Same chat always maps to same session, so you can continue the work later.

Discord works the same, except a Discord channel is a project and a thread is a session. Phone app later will talk to the same bridge through a simple web API.

### Does it stream? Yes, but differently on each platform

Short answer: yes. opencode gives us a live feed, and our bridge forwards it. But Telegram and Discord do not allow true letter-by-letter streaming like ChatGPT. Only the phone app can do that.

Where the stream comes from:
- opencode has a live event feed at `GET /event` (SSE). We use `POST /session/:id/prompt_async` so opencode starts work without waiting, then we listen to events: text chunks, tool calls like read, edit, bash, permission asks, and done.
- Our bridge listens once and forwards to you.

Telegram (fake streaming, good enough):
- Telegram has no real stream. We send one message saying `working...` with typing indicator, then edit that same message every 1 to 2 seconds or every 200 characters.
- Long answers are split because Telegram allows only about 4,000 characters per message. We escape MarkdownV2 so code does not break.
- Tool calls show as a simple status line: `reading file...`, `editing...`, then the final diff.
- Rule: never edit faster than 1 edit per second or Telegram will temporarily block the bot. So it looks like chunks, not smooth typing.

Discord (same idea, threads help):
- Same edit-the-message trick, limit is 2,000 characters. Rate limit is about 5 edits per 5 seconds per channel, so we throttle the same way.
- We use a thread per session (like kimaki). Long runs stay in the thread and do not spam the main channel. Diffs and images go as follow-up messages.

Phone app (true streaming):
- The app can open `GET /api/events` on our bridge, which re-exposes the opencode feed. Chunks render instantly, like ChatGPT. No 4k limit, no edit bans.
- This is why Phase 3 matters: bots are for quick control with notifications, phone app is for smooth reading.

What we will build in code: `prompt_async` + SSE subscribe, throttle to 1 edit/sec for Telegram/Discord, raw pass-through for mobile. Blocking `prompt` only as fallback.

## 6. What we will build and what we will not

**MVP Phase 1 — Telegram only, just for you:**
New session, send message, see reply live, stop task, check status, switch project and model, approve permissions with buttons, queue a follow-up.

**Phase 2 — Discord:**
Reuse 80% of the same code. Add slash commands, channel-to-project binding, threads for sessions.

**Phase 3 — Phone:**
Do not build native app yet. First make a tiny web API on top of the same bridge, reuse it from a mobile-friendly page like portal does. Native app comes only after that works.

**We will NOT build in MVP:** multi-user teams, voice messages, scheduled cron jobs, image understanding, public bot store, cloud hosting. Keep it single-user and simple.

## 7. Fork or build from scratch?

For single-user Telegram first, fork, do not start from zero.

Winner: fork `silent-night-no-trace/opencode-channel-adapters`.

Why:
- It already has a shared core plus Telegram, Discord, and Feishu adapters.
- It uses polling, so you need no public URL for MVP.
- It has session file (`sessions.json`), allowlist (`TELEGRAM_ALLOWED_CHAT_IDS`), and `--check-config`.
- It is MIT licensed, published on npm, and can be used as a library.
- Easiest to extend to Discord and phone later.

Runner-up `opencode-telegram-bridge` is good if you want the install wizard and background service example. The rich bots like `grinev` and `artickc` look tempting but are too big to change. Plugin bots like `tbot` and `teleprompt` die with the TUI, so skip them.

We will copy ideas from kimaki (channel = project, thread = session) and CodeNomad (password + relay for phone) but not their code yet.

## 8. Simple tech choices and why

- Language: TypeScript, Node.js 22+. Same language as opencode SDK, easiest to hire for, works for bot and later phone API.
- Telegram library: grammY. Modern, simple polling, good button support.
- Discord library: discord.js. Standard, supports slash commands and threads.
- opencode access: `@opencode-ai/sdk` with `createOpencodeClient({ baseUrl })`. Official, type-safe, survives opencode updates better than direct HTTP.
- Live updates: Server-Sent Events from `GET /event`. One open stream, throttled message edits.
- Storage for MVP: simple JSON file `sessions.json` mapping chat ID to session ID, project, model. Move to SQLite only when file gets messy.
- Secrets: `.env` file, never committed. `TELEGRAM_BOT_TOKEN`, `OPENCODE_BASE_URL`, `ALLOWED_CHAT_IDS`.
- Keep-alive: `tmux` now, `systemd` on Linux / `launchd` on Mac later.

Proposed folder:

```
opencode-rc/
  PLAN.md
  packages/core/         # allowlist, sessions, opencode calls, formatter
  apps/telegram-bot/     # polling + commands + buttons
  apps/discord-bot/      # later, reuses core
  apps/api/              # later for phone, reuses core
```

## 9. Detailed build plan

### Phase 0 — Host ready (half day)
1. Install opencode, run `opencode --version`.
2. Run `opencode serve --hostname 127.0.0.1 --port 4096`. Open `http://localhost:4096/doc` to confirm it answers.
3. Create Telegram bot with `@BotFather` (`/newbot`), save token. Get your user ID from `@userinfobot`.
4. Keep computer awake, use `tmux` so closing terminal does not kill server.

Done when: server answers, you have token and ID.

### Phase 1 — Telegram MVP (2 to 3 days)
1. Scaffold `apps/telegram-bot` with grammY + SDK. Load token and allowlist from `.env`. Reject all other users silently.
2. Commands: `/start` (pairing check), `/new [title]`, `/status`, `/sessions`, `/projects`, `/model`, `/abort`, `/diff`, `/help`. Plain text = prompt to current session.
3. Bridge logic: `chatId -> { sessionId, project, model }` in `sessions.json`. `prompt_async` for no-wait sends, poll result, stream edits.
4. Permission buttons: when opencode asks, send inline buttons Approve once / Always / Deny, call `POST /session/:id/permissions/:permissionID`.
5. Formatting: escape Telegram MarkdownV2, split over 4,000 chars, show typing indicator, throttle edits to avoid bans.
6. Queue: if busy, `/queue` or `btw` stores follow-up, `/cancel` clears.
7. Test from phone on home network: new session, ask to edit a file, approve, see diff, abort mid-run, restart server and resume.
8. Daemonize with systemd/launchd, add logs.

Done when: you can leave home, message bot, approve, and get code change back.

### Phase 2 — Discord MVP (2 days, after Telegram works)
1. Create Discord app, bot token, enable Message Content Intent, invite with bot scope + View, Send, Read History, Attach, React.
2. New `apps/discord-bot` reusing `packages/core`. Add `/use` to bind channel to project folder, auto-thread per session, `/resume /model /abort /diff /queue`.
3. Copy kimaki rule: channel = project, thread = session. Same permission buttons as Telegram.
4. Test with two threads in parallel.

Done when: same computer answers both Telegram and Discord at same time.

### Phase 3 — Phone path (1 week, after bots stable)
1. Add tiny `apps/api`: `POST /api/prompt`, `GET /api/events`, `POST /api/approve`, password check.
2. Test with `portal` (`bunx openportal`) over Tailscale before writing any native code.
3. Only then start Expo React Native app calling that API. Reuse login and session list.

Done when: phone browser can list sessions and approve without Telegram.

## 10. Security rules, non-negotiable

1. Never commit tokens. `.env` only, rotate if leaked.
2. Allowlist first. Empty allowlist means anyone can use your computer. Always set `ALLOWED_CHAT_IDS` to your ID.
3. Never expose `opencode serve` directly to the internet. Keep `127.0.0.1`, use Tailscale, SSH tunnel, or CodeNomad-style relay with password + HTTPS.
4. If you must bind `0.0.0.0`, set `OPENCODE_SERVER_PASSWORD` and `--cors` to your domain only.
5. Keep permissions on `ask`. Do not use `--auto` or `--dangerously-skip-permissions` on your main machine. Only allowlist people you trust with Approve power.
6. Remember replies go through Telegram/Discord servers. Do not paste secrets or customer code you would not share.

## 11. What success looks like

- You send one message from phone, get correct code edit + diff back in under 2 minutes.
- Permission prompt arrives as buttons, tap Approve, work continues without touching laptop.
- Restart laptop, bot reconnects, old session resumes with `/sessions`.
- Same session visible in opencode TUI and in Telegram.
- No stranger can trigger your bot. Logs prove drops.

Test list: pairing, new session, long output split, abort, queue, permission approve/deny, server restart, two chats isolated, Discord parallel, Tailscale phone test.

## 12. Risks and limits in plain words

- Computer must stay on. Closed laptop = silent bot. This is same limit as Claude Channels. Fix: always-on mini PC or VPS later.
- Permission pause. If you miss the Approve message, work waits. Fix: narrow `ask` rules, allow safe commands like `git status`.
- Telegram has no history pull. Missed messages while offline are lost. Discord can catch up a little.
- opencode v1 vs v2 API differs. Pin your opencode version, test after every update.
- Community code rots fast. Our fork must stay small so we can update SDK quickly.
- Cost: Telegram/Discord are free, but models still bill to your provider. Phone notifications can spam you if agent loops. Set abort + limits.

Timeline guess: 0.5 day host, 3 days Telegram MVP, 2 days Discord, 1 week phone web. Single person, part-time.

## 13. Next action

1. Confirm: single-user, laptop host, TypeScript, OpenCode v2.
2. I scaffold `packages/core + apps/telegram-bot` from the channel-adapters pattern in this repo.
3. You give Telegram token + user ID privately, we run first `/start` test together.
