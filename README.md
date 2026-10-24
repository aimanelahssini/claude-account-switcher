<p align="center"><img src="logo.svg" width="110" alt="Claude Account Switcher logo"></p>

<h1 align="center">Claude Account Switcher</h1>

<p align="center">Switch <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> between two (or more) accounts with one click in the GNOME top bar,<br>
without restarting, and see how much of each account's 5-hour limit is used.</p>

<p align="center"><img src="docs/topbar.svg" alt="Top bar with two accounts: the selected one at 53% with an orange usage bar, the other at 11% with a grey bar, and a tooltip saying the limit resets in 1 h 12 min"></p>

> **Unofficial.** This project is not made by, affiliated with, or endorsed by Anthropic.
> It relies on how Claude Code stores its login on Linux, which can change in any release.
> Make sure the way you use multiple accounts complies with Anthropic's terms.

## What it does

- **One-click switching.** Click an account in the top bar. A Claude Code session that is
  already running picks up the new login on its next message, so you keep the same chat
  with its full history. No `/login`, no restart.
- **Live usage.** Each account shows its 5-hour usage in percent, refreshed every minute.
  The selected account has an orange bar, the other a grey one.
- **Reset time.** Hover an account to see when its limit resets.
- **% or tokens.** The history panel switches between both with one click: the 5-hour
  window, each hour of the last 24 and each recent window, in percent of the limit or in tokens.
- **Automatic switch at 100%.** When the account you're on reaches its 5-hour limit, it
  switches to the signed-in account with the most room left and tells you in a notification.
- **Usage history.** Click the account you're on (or right-click any account) for how much
  each of the last 24 hours used (hover a bar for its numbers) and its recent 5-hour windows
  with how high each one went.
- **Add accounts from the top bar.** Click **+**, type a name (anything short: `2`, `work`,
  `-`), and sign in in a **private window**, so your browser can't quietly reuse the Claude
  account it's already logged in to. Once you're in, that account becomes active.
- **Shows when Claude is working.** Claude Code's mascot sits in the top bar while Claude is
  idle; while it works, Claude Code's own spinner takes its place (see below).
- **No sleep while Claude works.** Close the lid mid-task and the laptop keeps going until
  Claude is done, then does what closing the lid normally does.
- **Tells you when Claude needs you.** A white blinking dot and the chat's name in the top
  bar (click: that chat's window), and permission prompts as notifications with **Yes**,
  **Always** and **No**. On ThinkPads, the lid logo and the power light blink too.
- **A CLI too.** Everything works from the terminal with `claude-account`.

<p align="center"><img src="docs/history.png" width="380" alt="History panel in percent: 53% of the 5-hour limit, orange hourly bars for the last 24 hours, and recent 5-hour windows with their peak"> <img src="docs/history-tokens.png" width="380" alt="The same panel switched to tokens: 13M tokens in the last 24 hours, hourly bars in tokens with the busiest hour, and tokens per window"></p>

## Options

Click the mascot (or right-click it) to turn any of these off or back on. All are on by default.

<p align="center"><img src="docs/options.png" width="409" alt="Menu under the mascot: Claude is working, with switches for Stay awake while Claude works, Switch accounts at 100%, Permission prompts as notifications and Blink the ThinkPad lights"></p>

- **Stay awake while Claude works:** see [While Claude works](#while-claude-works).
- **Switch accounts at 100%:** checked with every usage update (once a minute). It only moves
  to an account that is signed in and under its limit; if they're all full, it stays. The
  chat you're in continues on the new account with your next message.

- **Permission prompts as notifications** and **Blink the ThinkPad lights:** see
  [When Claude needs you](#when-claude-needs-you). The lights switch shows on ThinkPads only.

From the terminal: `claude-account keep-awake|auto-switch|ask|lights on|off`.

## While Claude works

<p align="center"><img src="docs/working.gif" width="343" alt="The grey mascot is replaced by Claude Code's spinner: a cycling star and the word Choreographing… with a light glimmer moving across it"></p>

As soon as you send Claude Code a message, the spinner from your terminal takes the
mascot's place: the same cycling star, the same orange with its moving glimmer, and a word
from Claude Code's own list of 187, a new one each time Claude starts working and every
3 minutes on long work (your `spinnerVerbs` setting counts too). They come in random order,
and you see every word once before any comes back; the order carries on after a restart. When Claude is done, or waiting for you, the mascot
comes back.

The word is picked separately from the one in your terminal, so the two usually differ:
Claude Code doesn't tell other programs which word it chose. The terminal also shows states
only Claude Code itself can see, from the reply as it streams in: amber and "thinking" while
Claude thinks, red when the reply stalls. The top bar shows the part that is known from
outside: whether Claude is working at all.

Meanwhile the computer doesn't go to sleep:

- **Idle:** GNOME's automatic suspend waits. The screen can still dim and lock as usual.
- **Lid closed:** the laptop stays on and Claude keeps working, however long that takes.
- **When Claude is done**, it waits one more minute. If Claude starts again meanwhile, it
  waits for that to finish too, then another minute, and so on. After that the lid's normal
  action runs (suspend, by default), so a laptop in a bag doesn't stay awake for nothing.
- Choosing **Suspend** or **Power Off** yourself still works right away.

<p align="center"><img src="docs/working-tooltip.png" width="452" alt="Tooltip under the mascot: Claude is working: no sleep until it's done, lid closed or not"></p>

This comes from `claude-busy`, a small shell script that Claude Code's
[hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) call: when you send a message
and around each tool call it marks the session as working (one tiny file per session in
`$XDG_RUNTIME_DIR/claude-busy`), and when Claude stops, or has been waiting for you for a
minute, it clears it. While any session is working, one background `claude-busy hold` keeps
two inhibitors (`systemd-inhibit --what=handle-lid-switch` and
`gnome-session-inhibit --inhibit suspend`) and checks every 5 seconds whether it's still
needed. There's no time limit while a session works. A session whose `claude` process is gone
counts as done right away; one you stop with Esc counts as done once Claude Code reports it's
waiting for you. After the last one, the inhibitors stay for the waiting minute.
`claude-busy status` shows what's working, and when it's in the waiting minute.
`tests/test_busy.sh` checks all of this with a fake `claude` in a few seconds.

It's light: a hook call takes about 5 ms, nothing runs while Claude is idle, and the top bar
reacts to files appearing and disappearing instead of polling. The spinner redraws a short
label every 120 ms only while Claude works.

## When Claude needs you

When a chat stops for a permission prompt, a question or a plan to approve:

<p align="center"><img src="docs/needs.png" width="377" alt="Top bar: a white dot and the chat's name, Fix the poster uplo…, where the spinner was"></p>

- **Top bar:** a white dot that blinks twice and pauses, and the chat's name (its title, as in
  its window). It comes before the spinner of another chat that's still working, since it's
  the one you can do something about. **Click it** to bring that chat's terminal window to the
  front, on whatever desktop it's on; right-click for the menu. With several chats waiting it
  says **2 chats**, and a click opens the one that has waited longest. Hover for their names.
- **Your chats at a glance:** hover the mascot (or the spinner, or the dot) and under the text
  there's a row of rounded rectangles, one per Claude chat, in the order of your terminal
  tabs: desktop by desktop, windows left to right, then each window's tabs. **Grey** is idle,
  **orange** (breathing) is working, **white** is waiting for you. Hover one for its chat's
  name; **click** it to go there: its desktop, its window, and its tab (with the terminal's own
  "go to tab" shortcut), and an orange frame flashes around the window so you see where you
  landed. `claude-tabs` reads the terminals' tabs through the accessibility bus (as screen
  readers do), only while you hover.

<p align="center"><img src="docs/tabs.png" width="376" alt="Hover box under the top bar: Claude needs you in Charlie, click to open it, and below it four rounded rectangles: grey, orange, white, grey"></p>

- **Notification**, for permission prompts: the project as its title, the request in plain
  words and the exact command, and **Yes**, **Always** (when Claude Code offers "don't ask
  again") and **No**. The prompt stays open in the terminal too; whichever you answer first
  counts, and the other goes away by itself. No notification for the chat you're looking at.
  **No** stops Claude like the terminal's No does, so you can tell it what to do instead.

<p align="center"><img src="docs/notification.png" width="520" alt="Notification titled listr: Delete pezei.py? — $ rm -f pezei.py, with Yes, Always and No buttons"></p>

- **Sleep:** a chat that waits for you keeps the computer awake 15 minutes (plus the waiting
  minute), so the lights can tell you; then the lid's normal action runs as usual.

**ThinkPad lights** (after a one-time setup, below):

| | Lid logo dot | Power button light |
|---|---|---|
| Claude works | blinks with the spinner's star (on while it's big), **lid closed only** | as usual |
| A chat needs you | blink, blink, pause, **lid closed only** | blink, blink, pause |
| Otherwise | as usual: on while the laptop is on, a slow blink while it sleeps | as usual |

The dot only speaks with the lid closed: open, it faces the people across from you, and the
top bar says it already. The lights and the top bar move together: they start at the same
moment and the top bar puts them back in step every 30 seconds. The kernel plays the blinking
by itself (its LED pattern trigger), so it costs no CPU.

The setup lets your user drive these two lights and nothing else. It needs your password once:

```bash
pkexec ./install-lights.sh     # or sudo; undo with uninstall-lights.sh
```

It loads the kernel's `ledtrig-pattern` module at boot and adds a udev rule that switches the
two lights to it, steady on as usual, with their `pattern` writable by your group.

**How:** Claude Code's hooks tell `claude-busy` when a chat waits for you (`Notification`
for prompts and questions, `PreToolUse` for `AskUserQuestion` and `ExitPlanMode`). Its
`PermissionRequest` hook offers the prompt to the top bar and waits for an answer on a pipe,
without using the CPU; Claude Code shows the same prompt in the terminal meanwhile, and the
next hook of that chat (the prompt was answered there) ends the wait. `tests/test_needs.sh`
and `TEST_ONLY=needs tests/shell/run.sh` check it all with a fake `claude`, fake lights and a
throwaway GNOME Shell.

## The 5-hour window, and tokens

A 5-hour window starts with the first message you send after the previous one has ended,
and lasts 5 hours. The percentage is how much of that window's limit you've used; at the
end it goes back to 0. If you haven't used an account since its window ended, there is no
window running: the next one starts with your next message, so the last window listed can
have ended a while ago. The panel marks the window that's running as **Now**, and
an account whose window has ended shows 0% and *Limit reset at …*.

Anthropic only reports the percentage; switch the history panel to **Tokens** to see those
instead (it remembers your choice). Tokens are counted from Claude Code's own
transcripts on this computer (`~/.claude/projects`): input, output and cache writes, without
cache reads, which are cheap and would dwarf everything else. Each message counts toward the
account that was active when it was sent. Claude Code on other computers isn't included, and
tokens are only known from the first usage check after installing. They're saved in
`~/.claude/accounts/tokens.cache` (8 days, per 10 minutes); reading the transcripts takes
about a second the first time, then a few milliseconds a minute.

## How it works

Claude Code on Linux keeps its login in `~/.claude/.credentials.json`, and a running
session reloads that file when it changes. `claude-account` keeps a copy of each account's
login in `~/.claude/accounts/` and swaps the right one into place when you switch. Any
tokens Claude Code refreshed in the meantime are saved back first.

Usage numbers come from the same endpoint Claude Code's `/usage` command reads. The first
message after a switch costs a bit more on the new account, because it has to read the
whole conversation once. After that, usage is normal.

## Install

Needs Linux, `python3`, Claude Code, and GNOME Shell 45 or newer for the top-bar part
(tested on GNOME 50 / Fedora 44). The CLI works without GNOME.

```bash
git clone https://github.com/aimanelahssini/claude-account-switcher
cd claude-account-switcher
./install.sh
```

The installer also adds the `claude-busy` hooks to `~/.claude/settings.json` (your other
settings and hooks stay as they are); Claude Code sessions started after that use them.

On a ThinkPad, `pkexec ./install-lights.sh` once more for the lights (see
[When Claude needs you](#when-claude-needs-you)); everything else works without it.

If Claude Code is already logged in, the installer saves that login as account **1**
(rename it with `claude-account rename 1 NAME`). Log out and back in once so GNOME loads the
extension, then click **+** in the top bar to add your other account under any name.
Accounts listed but not signed in yet say *sign in*; clicking one opens the same choice:

<p align="center"><img src="docs/sign-in.svg" alt="Clicking an account that isn't signed in opens a dialog offering a private or a normal browser window"></p>

From the terminal, `claude-account add NAME --private` does the same with the name you type.

## Usage

| Command | What it does |
|---|---|
| `claude-account switch 2` | Make account `2` active (same as clicking it) |
| `claude-account current` | Print the active account |
| `claude-account list` | List saved accounts |
| `claude-account usage` | Fetch 5-hour usage for every account |
| `claude-account history [NAME]` | Recent 5-hour windows, how high each went, and their tokens |
| `claude-account auto-switch on\|off` | Switch accounts automatically at 100% (on by default) |
| `claude-account keep-awake on\|off` | Keep the computer awake while Claude works (on by default) |
| `claude-account ask on\|off` | Permission prompts as notifications too (on by default) |
| `claude-account lights on\|off` | Blink the ThinkPad lights (on by default, after `install-lights.sh`) |
| `claude-busy status` | Which Claude Code chats are working or waiting for you |
| `claude-account add NAME --private` | Sign in to an account in a private browser window |
| `claude-account add NAME --current` | Save the login Claude Code is using right now |
| `claude-account rename OLD NEW` | Rename an account |
| `claude-account remove NAME` | Forget an account's login |

Avoid running `/login` inside Claude Code after setup: it changes the login behind the
switcher's back. If an account stops working, run `claude-account add NAME` again.

## Privacy

Everything stays on your machine. Usage history is a small file,
`~/.claude/accounts/history.jsonl` (a reading per account at most every 10 minutes unless it
changes, kept 30 days). Anthropic only reports the current number, so history starts when
you install. Saved logins live in `~/.claude/accounts/` with
owner-only permissions (`0600`). The only network calls go to Anthropic: the usage endpoint,
and the token endpoint to renew an account that hasn't been used for a while.

## Uninstall

```bash
./uninstall.sh
```

It removes the extension, `claude-account`, `claude-busy` and their Claude Code hooks, and
leaves every other setting alone. If you set up the lights, `pkexec ./uninstall-lights.sh`
gives them back to the laptop. Your saved logins stay in `~/.claude/accounts`; delete
that folder too to forget them.

## License

MIT
