import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {VERBS} from './verbs.js';

const SLOTS = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'accounts']);
const SCRIPT = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'claude-account']);
const TRACK_WIDTH = 44;
const POLL_SECONDS = 60;
// claude-busy keeps one file per working Claude Code session here.
const BUSY_DIR = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'claude-busy']);
const NEEDS_DIR = GLib.build_filenamev([BUSY_DIR, 'needs']);
const ASK_DIR = GLib.build_filenamev([BUSY_DIR, 'ask']);
const BUSY_CMD = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'claude-busy']);
const TABS_CMD = GLib.getenv('CLAUDE_TABS_CMD') || GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'claude-tabs']);  // tests use a stand-in
// "Needs you": the white dot blinks twice and pauses, [opacity, ms] steps. The ThinkPad lights
// play the same (claude-busy's patterns, repeated here to re-align them with the top bar).
const NEEDS_STEPS = [[255, 150], [90, 150], [255, 150], [90, 1800]];
const LEDS = GLib.getenv('CLAUDE_BUSY_LEDS') || '/sys/class/leds';  // tests use stand-ins
const LED_PATTERNS = {
    working: '0 360 0 0 255 720 255 0 0 360 0 0',
    needs: '255 150 255 0 0 150 0 0 255 150 255 0 0 1800 0 0',
};
const REALIGN_MS = 30000;
const NAME_CHARS = 20;
const FLASH_OPACITY = 180;   // the orange frame at its brightest (of 255): slightly see-through
const MAX_TIP_WIDTH = 460;   // longer chat names in the mascot's box end in "…"
const TITLE_TAIL = 512 * 1024;  // bytes at the end of a chat's transcript searched for its title
// Claude Code's spinner, as it looks in a terminal on Linux: the glyph runs forward then back,
// and a three-letter glimmer sweeps over the word. One light timer drives both.
const SPINNER = ['·', '✢', '*', '✶', '✻', '✽'];
const SPINNER_FRAMES = [...SPINNER, ...[...SPINNER].reverse()];
const SPINNER_MS = 120;
const GLIMMER_PAUSE = 8;   // frames between two sweeps
const WORD_SECONDS = 180;  // on long work a new word now and then, between two sweeps
const ORANGE = '#d77757';
const SHIMMER = '#eb9f7f';
// Claude Code's mascot in its own terminal art, " ▐▛███▜▌ / ▝▜█████▛▘ /   ▘▘ ▝▝ ", as
// [x, y, width, height] in quarter-character cells (twice as tall as wide on screen).
const MASCOT = [[2, 0, 12, 4], [0, 2, 16, 1], [3, 4, 1, 1], [5, 4, 1, 1], [10, 4, 1, 1], [12, 4, 1, 1]];
const MASCOT_EYES = [[4, 1], [11, 1]];
// Pixel sizes of those cells at 30x19 (the stylesheet's size): the arm tips and the legs are a
// pixel shorter, so every eye and leg stays the same size.
const MASCOT_COLS = [1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1];
const MASCOT_ROWS = [4, 4, 4, 4, 3];
// Terminals tried, in order, to run the browser sign-in.
const TERMINALS = [
    ['xdg-terminal-exec'],
    ['ptyxis', '--new-window', '--'],
    ['kgx', '--'],
    ['gnome-terminal', '--'],
    ['konsole', '-e'],
    ['xterm', '-e'],
];

const DAY = 86400;
const HOUR = 3600;
const WINDOW_JITTER = 600;  // the API's reset time wobbles by a second or so between readings
const ORANGE_RGB = [0xd9 / 255, 0x77 / 255, 0x57 / 255];

function resetTime(reset) {
    return reset ? GLib.DateTime.new_from_iso8601(reset, null)?.to_unix() ?? null : null;
}

// 5-hour windows from the readings, newest first: {end (unix), peak}. Readings of one window
// differ by a second or so in reset time; windows are hours apart.
function windowsOf(hist, since) {
    const ends = hist.filter(e => e.t >= since && resetTime(e.reset))
        .map(e => [resetTime(e.reset), e.pct]).sort((x, y) => x[0] - y[0]);
    const groups = [];
    for (const [end, pct] of ends) {
        const g = groups.at(-1);
        if (g && end - g.end < WINDOW_JITTER)
            g.peak = Math.max(g.peak, pct);
        else
            groups.push({end, peak: pct});
    }
    return groups.map(g => ({end: Math.round(g.end / 60) * 60, peak: g.peak})).reverse();
}

// How much of the 5-hour limit was used in each of the last 24 hours (oldest first): the rises
// between readings, a new window counting from 0.
function hourlyUse(hist, firstHour) {
    const hours = new Array(24).fill(0);
    let prev = null;
    for (const e of hist) {
        if (typeof e.pct !== 'number')
            continue;
        if (prev) {
            const sameWindow = Math.abs((resetTime(e.reset) ?? 0) - (resetTime(prev.reset) ?? 0)) < WINDOW_JITTER;
            const used = sameWindow ? Math.max(0, e.pct - prev.pct) : e.pct;
            const i = Math.floor((e.t - firstHour) / HOUR);
            if (i >= 0 && i < 24)
                hours[i] += used;
        }
        prev = e;
    }
    return hours;
}

function readHistory() {
    try {
        const [ok, bytes] = GLib.file_get_contents(GLib.build_filenamev([SLOTS, 'history.jsonl']));
        if (!ok)
            return [];
        return new TextDecoder().decode(bytes).split('\n').flatMap(l => {
            try { return l ? [JSON.parse(l)] : []; } catch { return []; }
        });
    } catch {
        return [];
    }
}

// tokens.cache from `claude-account usage`: tokens per account in 10-minute steps.
function readTokens() {
    try {
        const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([SLOTS, 'tokens.cache']));
        const data = JSON.parse(new TextDecoder().decode(bytes));
        return {step: data.step ?? 600, accounts: data.accounts ?? {}};
    } catch {
        return {step: 600, accounts: {}};
    }
}

function tokensBetween(tokens, name, start, end) {
    let sum = 0;
    for (const [at, [n]] of Object.entries(tokens.accounts[name] ?? {})) {
        if (+at >= start && +at < end)
            sum += n;
    }
    return sum;
}

// 2400000 -> '2.4M', 888800 -> '889k'
function short(n) {
    for (const [div, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) {
        if (n >= div) {
            const v = n / div;
            return `${v < 10 ? +v.toFixed(1) : Math.round(v)}${unit}`;
        }
    }
    return String(Math.round(n));
}

function dayName(d) {
    const today = GLib.DateTime.new_now_local();
    const diff = today.get_day_of_year() - d.get_day_of_year() + 365 * (today.get_year() - d.get_year());
    return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.format('%a %e %b');
}

// A top-bar button that answers to the pointer over the bar's whole height, so a pointer pushed
// up against the screen's edge (or down to the bar's bottom) still counts as on it. It's drawn
// exactly as before: only where it can be pointed at grows.
const TallButton = GObject.registerClass(
class TallButton extends St.Button {
    // [top, bottom] of the bar in this button's coordinates.
    _barSpan() {
        const [, panelY] = Main.panel.get_transformed_position();
        const [, y] = this.get_transformed_position();
        return [Math.min(0, panelY - y), Math.max(this.height, panelY + Main.panel.height - y)];
    }

    vfunc_pick(context) {
        super.vfunc_pick(context);
        if (!this.reactive || !this.mapped)
            return;
        const [top, bottom] = this._barSpan();
        this.pick_box(context, new Clutter.ActorBox({x1: 0, y1: top, x2: this.width, y2: bottom}));
    }

    // Clutter only looks for the pointer where an actor paints; this one "paints" the bar's
    // height (nothing more is drawn: the box only covers where it can be pointed at).
    vfunc_get_paint_volume(volume) {
        if (!super.vfunc_get_paint_volume(volume))
            return false;
        const [top, bottom] = this._barSpan();
        const origin = volume.get_origin();
        origin.y = Math.min(origin.y, top);
        volume.set_origin(origin);
        volume.set_height(Math.max(volume.get_height(), bottom - origin.y));
        return true;
    }
});

// What hovering a chat's bar says.
function barText(chat) {
    return `${chat.title} · ${{idle: 'idle', working: 'working', needs: 'needs you'}[chat.state]}`;
}

function label(n) {
    return n === '-' ? '−' : n;
}

function readText(path) {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(path)[1]);
    } catch {
        return null;
    }
}

// Claude Code titles its terminal "✳ <chat title>" (a spinner instead of ✳ while it works);
// Ptyxis adds " — claude" when Claude runs under a shell.
function bareTitle(title) {
    return (title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

function showsTitle(windowTitle, title) {
    return !!title && (windowTitle === title || windowTitle.startsWith(`${title} — `));
}

// A chat's current title, from the end of its transcript (Claude rewrites it often).
function readChatTitle(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const size = file.query_info('standard::size', 0, null).get_size();
        const stream = file.read(null);
        stream.seek(Math.max(0, size - TITLE_TAIL), GLib.SeekType.SET, null);
        const parts = [];
        let bytes;
        while ((bytes = stream.read_bytes(65536, null)).get_size() > 0)
            parts.push(new TextDecoder().decode(bytes.toArray()));
        stream.close(null);
        const text = parts.join('');
        const last = key => [...text.matchAll(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, 'g'))].pop();
        const m = last('customTitle') ?? last('aiTitle');
        return m ? JSON.parse(`"${m[1]}"`) : null;
    } catch {
        return null;
    }
}

function shorten(text, n) {
    return text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text;
}

// A permission prompt in plain words: [question, detail].
function describeRequest(tool, input = {}) {
    const name = path => GLib.path_get_basename(path || '');
    switch (tool) {
    case 'Bash':
        return [input.description ? `${input.description.replace(/\.$/, '')}?` : 'Run a command?', `$ ${input.command ?? ''}`];
    case 'Edit':
    case 'MultiEdit':
        return [`Edit ${name(input.file_path)}?`, input.file_path ?? ''];
    case 'Write':
        return [`Write ${name(input.file_path)}?`, input.file_path ?? ''];
    case 'NotebookEdit':
        return [`Edit ${name(input.notebook_path)}?`, input.notebook_path ?? ''];
    case 'Read':
        return [`Read ${name(input.file_path)}?`, input.file_path ?? ''];
    case 'WebFetch':
        try {
            return [`Open ${GLib.Uri.parse(input.url, 0).get_host()}?`, input.url];
        } catch {
            return ['Open a web page?', input.url ?? ''];
        }
    case 'WebSearch':
        return [`Search the web for “${input.query ?? ''}”?`, ''];
    default: {
        const mcp = /^mcp__(.+?)__(.+)$/.exec(tool ?? '');
        const what = mcp ? `${mcp[2].replace(/_/g, ' ')} (${mcp[1].replace(/_/g, ' ')})` : tool ?? 'a tool';
        return [`Use ${what}?`, shorten(JSON.stringify(input), 160)];
    }
    }
}

export default class ClaudeAccountExtension extends Extension {
    enable() {
        this._indicator = new PanelMenu.Button(0.0, 'Claude Account', true);
        this._box = new St.BoxLayout({style_class: 'claude-acct-box'});
        // Claude Code's mascot; Claude Code's spinner in its place while Claude works, and a white
        // blinking dot with the chat's name while a chat waits for you (click: open that chat).
        // Click or right-click: the options menu.
        const tagBox = new St.BoxLayout({style_class: 'claude-acct-tag-box'});
        this._tag = new TallButton({style_class: 'claude-acct-btn claude-acct-tag', child: tagBox,
            y_align: Clutter.ActorAlign.CENTER, button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE});
        this._tag.connect('clicked', (btn, mouse) => {
            if (this._needs?.length && mouse !== 3)
                this._openChat(this._needs[0]);
            else
                this._toggleOptions();
        });
        this._mascot = new St.DrawingArea({style_class: 'claude-acct-mascot', y_align: Clutter.ActorAlign.CENTER});
        this._mascot.connect('repaint', area => this._drawMascot(area));
        tagBox.add_child(this._mascot);
        this._spinner = new St.BoxLayout({style_class: 'claude-acct-spinner', visible: false,
            y_align: Clutter.ActorAlign.CENTER});
        // The glyphs come from different fonts; a fixed-width box keeps the word still.
        this._glyph = new St.Label({style_class: 'claude-acct-spinner-glyph', y_align: Clutter.ActorAlign.CENTER});
        this._verb = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._spinner.add_child(this._glyph);
        this._spinner.add_child(this._verb);
        tagBox.add_child(this._spinner);
        this._needsBox = new St.BoxLayout({style_class: 'claude-acct-needs', visible: false,
            y_align: Clutter.ActorAlign.CENTER});
        this._needsDot = new St.Label({text: '●', style_class: 'claude-acct-needs-dot', y_align: Clutter.ActorAlign.CENTER});
        this._needsName = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._needsBox.add_child(this._needsDot);
        this._needsBox.add_child(this._needsName);
        tagBox.add_child(this._needsBox);
        this._tag.connect('notify::hover', () => this._showTooltip(this._tag));
        this._box.add_child(this._tag);
        this._indicator.add_child(this._box);
        this._buttons = [];
        this._addBtn = new TallButton({label: '+', style_class: 'claude-acct-btn claude-acct-add',
            y_align: Clutter.ActorAlign.CENTER});
        this._addBtn.connect('clicked', () => this._askNewAccount());
        this._addBtn.connect('notify::hover', () => this._showTooltip(this._addBtn));
        this._box.add_child(this._addBtn);
        // The hover box: a line of text, and for the mascot a row of your Claude chats.
        this._tip = new St.BoxLayout({style_class: 'claude-acct-tooltip', vertical: true, visible: false,
            reactive: true, track_hover: true});
        this._tip.connect('notify::hover', () => {
            if (!this._tip.hover && this._tipFor === this._tag)
                this._showTooltip(this._tag);
        });
        this._tooltip = new St.Label({style_class: 'claude-acct-tooltip-text'});
        this._tabsRow = new St.BoxLayout({style_class: 'claude-acct-tabs', x_align: Clutter.ActorAlign.CENTER,
            visible: false});
        this._tip.add_child(this._tooltip);
        this._tip.add_child(this._tabsRow);
        Main.layoutManager.uiGroup.add_child(this._tip);
        this._tabsKey = '';

        GLib.mkdir_with_parents(SLOTS, 0o700);
        this._monitor = Gio.File.new_for_path(SLOTS).monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', () => this._refresh());
        this._refresh();
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // What Claude Code is doing, from claude-busy's files: working sessions, sessions waiting
        // for you, and permission prompts to offer as notifications.
        this._busy = null;
        this._needs = [];
        this._needsKey = '';
        this._titles = new Map();   // transcript -> chat title
        this._asks = new Map();     // session -> notification
        this._dirMonitors = [];
        for (const [dir, sync] of [[BUSY_DIR, () => this._syncBusy()], [NEEDS_DIR, () => this._syncBusy()],
            [ASK_DIR, () => this._syncAsks()]]) {
            GLib.mkdir_with_parents(dir, 0o700);
            const monitor = Gio.File.new_for_path(dir).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            monitor.connect('changed', (m, f, o, event) => {
                // Each tool call rewrites its session's file; only files coming and going matter.
                if (event !== Gio.FileMonitorEvent.CHANGED && event !== Gio.FileMonitorEvent.CHANGES_DONE_HINT &&
                    event !== Gio.FileMonitorEvent.ATTRIBUTE_CHANGED)
                    sync();
            });
            this._dirMonitors.push(monitor);
        }
        this._syncBusy();
        this._syncAsks();
        this._watchSessions();
        // Our banners open expanded, with their Yes / Always / No buttons showing.
        Main.messageTray.connectObject('queue-changed', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            const tray = Main.messageTray;
            if (tray._banner && !tray._banner.expanded && [...this._asks?.values() ?? []].includes(tray._notification))
                tray._banner.expand(false);
            return GLib.SOURCE_REMOVE;
        }), this);

        this._fetchUsage();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._fetchUsage();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = null;
        Main.messageTray.disconnectObject(this);
        this._dirMonitors?.forEach(m => m.cancel());
        this._dirMonitors = [];
        this._spin(false);
        this._blink(false);
        for (const n of this._asks?.values() ?? [])
            n.destroy();
        this._asks = new Map();
        this._source?.destroy();
        this._source = null;
        this._monitor?.cancel();
        this._monitor = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._sessionsMonitor?.cancel();
        this._sessionsMonitor = null;
        if (this._sessionsTimer)
            GLib.source_remove(this._sessionsTimer);
        this._sessionsTimer = null;
        this._tabsProc = null;
        this._tabsAgain = null;
        if (this._tipTimer)
            GLib.source_remove(this._tipTimer);
        this._tipTimer = null;
        this._flashActor?.destroy();
        this._flashActor = null;
        this._tip?.destroy();
        this._tip = null;
        this._tooltip = null;
        this._tabsRow = null;
        this._buttons?.forEach(b => b._menu?.destroy());
        this._options?.destroy();
        this._options = null;
        this._menuManager = null;
        this._buttons = [];
    }

    // Sessions: files named by session id, regular files only (needs/ and ask/ are folders).
    _sessionFiles(dir) {
        const names = [];
        try {
            const en = Gio.File.new_for_path(dir).enumerate_children('standard::name,standard::type', 0, null);
            let info;
            while ((info = en.next_file(null))) {
                if (info.get_file_type() === Gio.FileType.REGULAR && !info.get_name().startsWith('.'))
                    names.push(info.get_name());
            }
            en.close(null);
        } catch {}
        return names;
    }

    // Chats waiting for you, longest waiting first: {id, pid, since, kind, cwd, transcript}.
    _readNeeds() {
        return this._sessionFiles(NEEDS_DIR).map(id => {
            const [pid, since, kind, cwd, transcript] = (readText(GLib.build_filenamev([NEEDS_DIR, id])) ?? '').split('\n');
            return {id, pid: +pid || 0, since: +since || 0, kind, cwd, transcript};
        }).filter(e => !e.pid || GLib.file_test(`/proc/${e.pid}`, GLib.FileTest.EXISTS))
            .sort((x, y) => x.since - y.since);
    }

    _syncBusy() {
        const busy = this._sessionFiles(BUSY_DIR).length > 0;
        const needs = this._readNeeds();
        const needsKey = needs.map(e => e.id).join();
        if (busy === this._busy && needsKey === this._needsKey)
            return;
        const wasNeeding = this._needs.length > 0;
        this._needs = needs;
        this._needsKey = needsKey;
        // Waiting for you comes first: it's the one you can do something about.
        if (needs.length) {
            this._needsName.text = needs.length > 1 ? `${needs.length} chats` : shorten(this._chatName(needs[0]), NAME_CHARS);
            if (!wasNeeding)
                this._blink(true);
        } else {
            this._blink(false);
        }
        const spin = busy && !needs.length;
        if (busy !== this._busy || spin !== !!this._spinTimer) {
            this._busy = busy;
            if (busy)
                this._tag.add_style_class_name('busy');
            else
                this._tag.remove_style_class_name('busy');
            this._mascot.queue_repaint();
            this._spin(spin);
        }
        this._mascot.visible = !spin && !needs.length;
        if (this._tag.hover)
            this._showTooltip(this._tag);
    }

    // The chat's title (as in its window's title), else its project folder.
    _chatName(entry) {
        let title = this._titles.get(entry.transcript);
        if (title === undefined && entry.transcript) {
            title = readChatTitle(entry.transcript);
            this._titles.set(entry.transcript, title);
        }
        if (title)
            return title;
        const home = GLib.get_home_dir();
        return entry.cwd && entry.cwd !== home ? GLib.path_get_basename(entry.cwd) : 'Claude';
    }

    // The project, for a notification's title: its folder, or the chat's title in the home folder.
    _projectName(entry) {
        return entry.cwd && entry.cwd !== GLib.get_home_dir() ? GLib.path_get_basename(entry.cwd) : this._chatName(entry);
    }

    // The terminal window a chat runs in: the one showing its title, else the terminal that
    // started its claude process.
    _chatWindow(entry) {
        const windows = global.get_window_actors().map(a => a.meta_window)
            .filter(w => w.get_window_type() === Meta.WindowType.NORMAL);
        if (entry.transcript)
            this._titles.delete(entry.transcript);  // titles change; read it fresh for a click
        const title = this._chatName(entry);
        const byTitle = windows.find(w => showsTitle(bareTitle(w.get_title()), title));
        if (byTitle)
            return byTitle;
        let pid = entry.pid;
        for (let i = 0; i < 8 && pid > 1; i++) {
            const mine = windows.filter(w => w.get_pid() === pid);
            if (mine.length)
                return mine.sort((x, y) => y.get_user_time() - x.get_user_time())[0];
            const stat = readText(`/proc/${pid}/stat`);
            pid = stat ? +stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1] : 0;
        }
        return null;
    }

    _openChat(entry) {
        const win = this._chatWindow(entry);
        if (win) {
            Main.activateWindow(win);
            this._flash(win);
        }
        this._hideTip();
    }

    // A bar's chat: its window to the front, and its tab when the window has several.
    _openTab(chat) {
        const win = chat.window && global.get_window_actors().map(a => a.meta_window)
            .find(m => (m.get_title() ?? '').trim() === chat.window);
        if (!win) {
            this._openChat(chat);
            return;
        }
        Main.activateWindow(win);
        // The tab isn't the one showing: press the terminal's own "go to tab N" shortcut.
        if (chat.tabCount > 1 && chat.tab !== chat.window) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                if (global.display.focus_window === win)
                    this._pressTabShortcut(chat.tabIndex + 1);
                return GLib.SOURCE_REMOVE;
            });
        }
        this._flash(win);
        this._hideTip();
    }

    // Ptyxis's focus-tab-N shortcut, as set in its preferences (e.g. Ctrl+& on AZERTY).
    _pressTabShortcut(n) {
        const source = Gio.SettingsSchemaSource.get_default();
        if (n > 10 || !source.lookup('org.gnome.Ptyxis.Shortcuts', true))
            return;
        const accel = new Gio.Settings({schema_id: 'org.gnome.Ptyxis.Shortcuts'}).get_string(`focus-tab-${n}`);
        const mods = {ctrl: Clutter.KEY_Control_L, control: Clutter.KEY_Control_L, primary: Clutter.KEY_Control_L,
            alt: Clutter.KEY_Alt_L, shift: Clutter.KEY_Shift_L, super: Clutter.KEY_Super_L};
        const keys = [...accel.matchAll(/<(\w+)>/g)].map(m => mods[m[1].toLowerCase()]).filter(Boolean);
        const key = Clutter[`KEY_${accel.replace(/<\w+>/g, '')}`];
        if (!key)
            return;
        this._pressed = [...keys, key];   // tests read it
        this._keyboard ??= Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const time = () => GLib.get_monotonic_time();
        for (const k of this._pressed)
            this._keyboard.notify_keyval(time(), k, Clutter.KeyState.PRESSED);
        for (const k of [...this._pressed].reverse())
            this._keyboard.notify_keyval(time(), k, Clutter.KeyState.RELEASED);
    }

    // An orange frame around the window it led to: shows, then fades away. Slightly see-through,
    // so it marks the spot without being hard on the eyes.
    _flash(win) {
        this._flashActor?.destroy();
        const frame = new St.Widget({style_class: 'claude-acct-flash', opacity: 0, reactive: false});
        this._flashActor = frame;
        Main.layoutManager.uiGroup.add_child(frame);
        // On another desktop, wait for the switch so the window is where it will be shown.
        const elsewhere = win.get_workspace() !== global.workspace_manager.get_active_workspace();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, elsewhere ? 280 : 40, () => {
            if (this._flashActor !== frame)
                return GLib.SOURCE_REMOVE;
            const r = win.get_frame_rect();
            frame.set_position(r.x - 3, r.y - 3);
            frame.set_size(r.width + 6, r.height + 6);
            frame.ease({opacity: FLASH_OPACITY, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => frame.ease({opacity: 0, delay: 500, duration: 700, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (this._flashActor === frame)
                            this._flashActor = null;
                        frame.destroy();
                    }})});
            return GLib.SOURCE_REMOVE;
        });
    }

    // The white dot: blink, blink, pause, in step with the lights.
    _blink(on) {
        if (this._blinkTimer)
            GLib.source_remove(this._blinkTimer);
        this._blinkTimer = null;
        if (!this._needsBox)
            return;
        this._needsBox.visible = on;
        if (!on)
            return;
        let step = 0, lastAlign = 0;
        const next = () => {
            const [opacity, ms] = NEEDS_STEPS[step % NEEDS_STEPS.length];
            this._needsDot.opacity = opacity;
            if (step % NEEDS_STEPS.length === 0 && GLib.get_monotonic_time() - lastAlign >= REALIGN_MS * 1000) {
                lastAlign = GLib.get_monotonic_time();
                this._alignLights('needs');
            }
            step++;
            this._blinkTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, next);
            return GLib.SOURCE_REMOVE;
        };
        next();
    }

    // Restart the lights' pattern in step with the top bar, if they show this state now.
    _alignLights(state) {
        for (const led of ['lid_logo_dot', 'power']) {
            if (readText(GLib.build_filenamev([BUSY_DIR, `.light-${led}`]))?.trim() !== state)
                continue;
            try {
                const stream = Gio.File.new_for_path(`${LEDS}/tpacpi::${led}/pattern`).append_to(Gio.FileCreateFlags.NONE, null);
                stream.write_all(new TextEncoder().encode(LED_PATTERNS[state]), null);
                stream.close(null);
            } catch {}
        }
    }

    // ---- permission prompts as notifications ----------------------------------------
    _syncAsks() {
        const ids = new Set(this._sessionFiles(ASK_DIR).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)));
        for (const [id, n] of this._asks) {
            if (!ids.has(id)) {
                this._asks.delete(id);
                n.destroy();   // answered in the terminal, or the chat went away
            }
        }
        for (const id of ids) {
            if (!this._asks.has(id))
                this._notifyAsk(id);
        }
    }

    _notifyAsk(id) {
        let input;
        try {
            input = JSON.parse(readText(GLib.build_filenamev([ASK_DIR, `${id}.json`])));
        } catch {
            return;
        }
        const entry = this._readNeeds().find(e => e.id === id) ??
            {id, cwd: input.cwd, transcript: input.transcript_path, pid: 0};
        // You're looking at that chat already: its own prompt is right there.
        const focus = global.display.focus_window;
        if (focus && focus === this._chatWindow(entry))
            return;
        const [question, detail] = describeRequest(input.tool_name, input.tool_input);
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Claude Code',
                icon: Gio.FileIcon.new(this.dir.get_child('icons').get_child('claude-code.svg'))});
            this._source.connect('destroy', () => { this._source = null; });
            Main.messageTray.add(this._source);
        }
        const n = new MessageTray.Notification({source: this._source, title: this._projectName(entry),
            // GNOME shows a notification's text on one line.
            body: detail ? `${question} — ${shorten(detail, 300)}` : question,
            // Claude is stuck until you answer: it stays until then (or until the terminal's answer).
            urgency: MessageTray.Urgency.CRITICAL});
        const decide = decision => this._answer(id, {hookSpecificOutput: {hookEventName: 'PermissionRequest', decision}});
        n.addAction('Yes', () => decide({behavior: 'allow'}));
        const always = (input.permission_suggestions ?? []).filter(x => x.type !== 'setMode');
        if (always.length)
            n.addAction('Always', () => decide({behavior: 'allow', updatedPermissions: always}));
        n.addAction('No', () => decide({behavior: 'deny', message: 'The user said no (from a notification).', interrupt: true}));
        n.connect('activated', () => this._openChat(entry));
        n.connect('destroy', () => {
            if (this._asks.get(id) === n)
                this._asks.delete(id);
        });
        this._asks.set(id, n);
        this._source.addNotification(n);
    }

    _answer(id, decision) {
        try {
            const proc = Gio.Subprocess.new([BUSY_CMD, 'answer', id],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(`${JSON.stringify(decision)}\n`, null, () => {});
        } catch (e) {
            console.log(`claude-account-switcher: answer failed: ${e.message}`);
        }
    }

    _drawMascot(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        // Cell edges in device pixels, so the pixel art stays sharp at any scale.
        const edges = (sizes, total) => {
            const sum = sizes.reduce((a, b) => a + b, 0);
            let at = 0;
            return [0, ...sizes.map(v => Math.round((at += v) * total / sum))];
        };
        const xs = edges(MASCOT_COLS, w), ys = edges(MASCOT_ROWS, h);
        const cell = (x, y, cw, ch) => cr.rectangle(xs[x], ys[y], xs[x + cw] - xs[x], ys[y + ch] - ys[y]);
        const c = area.get_theme_node().get_foreground_color();
        cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255);
        for (const [x, y, cw, ch] of MASCOT)
            cell(x, y, cw, ch);
        cr.fill();
        cr.setOperator(0);  // CLEAR: the eyes are holes
        for (const [x, y] of MASCOT_EYES)
            cell(x, y, 1, 1);
        cr.fill();
        cr.$dispose();
    }

    // Like Claude Code: a verb for this stretch of work, then glyph and glimmer every frame.
    _spin(on) {
        if (this._spinTimer)
            GLib.source_remove(this._spinTimer);
        this._spinTimer = null;
        if (!this._spinner)
            return;
        // The spinner takes the mascot's place while Claude works.
        this._spinner.visible = on;
        this._mascot.visible = !on;
        if (!on)
            return;
        const verbs = this._verbs();
        let word = null, chars, since, sweep = 0, frame = 0, lastAlign = 0;
        const pick = () => {
            word = `${this._nextVerb(verbs)}…`;
            chars = [...word];
            since = GLib.get_monotonic_time();
            sweep = 0;
        };
        pick();
        const draw = () => {
            if (sweep >= chars.length + GLIMMER_PAUSE) {
                sweep = 0;
                if (GLib.get_monotonic_time() - since >= (this._wordSeconds ?? WORD_SECONDS) * 1e6)  // tests shorten it
                    pick();
            }
            const glimmer = sweep++ - 1;
            const text = chars.map((ch, i) => Math.abs(i - glimmer) <= 1
                ? `<span foreground="${SHIMMER}">${GLib.markup_escape_text(ch, -1)}</span>`
                : GLib.markup_escape_text(ch, -1)).join('');
            // The lid dot blinks with the star (claude-busy); keep the two in step.
            if (frame % SPINNER_FRAMES.length === 0 && GLib.get_monotonic_time() - lastAlign >= REALIGN_MS * 1000) {
                lastAlign = GLib.get_monotonic_time();
                this._alignLights('working');
            }
            this._glyph.text = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
            this._verb.clutter_text.set_markup(text);
            frame++;
        };
        draw();
        this._spinTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SPINNER_MS, () => {
            draw();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Every word once, in random order, before any comes back: a shuffled deck, kept in a
    // dotfile so it carries on after a restart. A new shuffle never starts with the last word.
    _nextVerb(verbs) {
        const path = GLib.build_filenamev([SLOTS, '.spinner-deck']);
        let deck = [];
        try {
            deck = JSON.parse(this._readFile('.spinner-deck'));
        } catch {}
        const known = new Set(verbs);
        let left = Array.isArray(deck.left) ? deck.left.filter(v => known.has(v)) : [];
        if (!left.length) {
            left = [...verbs];
            for (let i = left.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [left[i], left[j]] = [left[j], left[i]];
            }
            if (left.length > 1 && left[0] === deck.last)
                left.push(left.shift());
        }
        const word = left.shift();
        try {
            GLib.file_set_contents(path, JSON.stringify({left, last: word}));
        } catch {}
        return word;
    }

    // Claude Code's own list, with the spinnerVerbs setting applied the same way.
    _verbs() {
        try {
            const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'settings.json']));
            const custom = JSON.parse(new TextDecoder().decode(bytes)).spinnerVerbs;
            const words = (custom?.verbs ?? []).filter(v => typeof v === 'string' && v);
            if (words.length)
                return custom.mode === 'replace' ? words : [...VERBS, ...words];
        } catch {}
        return VERBS;
    }

    _readFile(name) {
        try {
            const [ok, bytes] = GLib.file_get_contents(GLib.build_filenamev([SLOTS, name]));
            return ok ? new TextDecoder().decode(bytes) : '';
        } catch {
            return '';
        }
    }

    _readUsage() {
        try {
            return JSON.parse(this._readFile('usage.cache'));
        } catch {
            return {};
        }
    }

    // Names from the names file first (accounts can be listed before anyone signs in),
    // then any other saved account. Sets this._signedIn.
    _slots() {
        const saved = [];
        const en = Gio.File.new_for_path(SLOTS).enumerate_children('standard::name', 0, null);
        let info;
        while ((info = en.next_file(null))) {
            const n = info.get_name();
            if (n.endsWith('.json') && !n.startsWith('.')) saved.push(n.slice(0, -5));
        }
        this._signedIn = new Set(saved);
        const listed = this._readFile('names').split('\n').map(l => l.trim()).filter(Boolean);
        return [...listed, ...saved.sort().filter(n => !listed.includes(n))];
    }

    _makeButton(n) {
        const b = new TallButton({style_class: 'claude-acct-btn', y_align: Clutter.ActorAlign.CENTER,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE});
        const inner = new St.BoxLayout({style_class: 'claude-acct-inner', vertical: true,
            y_align: Clutter.ActorAlign.CENTER});
        const row = new St.BoxLayout({style_class: 'claude-acct-row', x_align: Clutter.ActorAlign.CENTER});
        row.add_child(new St.Label({text: label(n), style_class: 'claude-acct-name'}));
        b._pct = new St.Label({text: '…', style_class: 'claude-acct-pct',
            y_align: Clutter.ActorAlign.CENTER});
        row.add_child(b._pct);
        b._track = new St.Widget({style_class: 'claude-acct-track', x_align: Clutter.ActorAlign.CENTER});
        b._fill = new St.Widget({style_class: 'claude-acct-fill', width: 0});
        b._track.add_child(b._fill);
        inner.add_child(row);
        inner.add_child(b._track);
        b.set_child(inner);
        b._slot = n;
        // Click: switch to it (or show its history if it's already the active one).
        // Right-click: history of any account.
        b.connect('clicked', (btn, mouse) => {
            if (!this._signedIn.has(n))
                this._askSignIn(n);
            else if (mouse === 3 || n === this._readFile('active').trim())
                this._toggleHistory(b);
            else
                this._switch(n);
        });
        b.connect('notify::hover', () => this._showTooltip(b));
        return b;
    }

    _refresh() {
        let slots = [];
        try { slots = this._slots(); } catch {}
        if (slots.join() !== this._buttons.map(b => b._slot).join()) {
            this._buttons.forEach(b => b.destroy());
            this._buttons = slots.map(n => {
                const b = this._makeButton(n);
                this._box.insert_child_below(b, this._addBtn);
                return b;
            });
        }
        const active = this._readFile('active').trim();
        for (const b of this._buttons) {
            const signedIn = this._signedIn.has(b._slot);
            b._track.opacity = signedIn ? 255 : 0;
            if (signedIn) b.remove_style_class_name('signed-out');
            else b.add_style_class_name('signed-out');
            if (!signedIn) {
                b._pct.text = 'sign in';
                b.remove_style_class_name('active');
                continue;
            }
            const pct = this._pct(b._slot);
            const known = typeof pct === 'number';
            b._pct.text = known ? `${Math.round(pct)}%` : '?';
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            b._fill.width = known ? Math.round(TRACK_WIDTH * scale * Math.min(pct, 100) / 100) : 0;
            const isActive = b._slot === active;
            if (isActive) b.add_style_class_name('active');
            else b.remove_style_class_name('active');
        }
    }

    // ---- options menu (the mascot) ---------------------------------------------------
    _option(name) {
        return !GLib.file_test(GLib.build_filenamev([SLOTS, `${name}-off`]), GLib.FileTest.EXISTS);
    }

    // Same files as `claude-account auto-switch|keep-awake on|off`.
    _setOption(name, on) {
        const path = GLib.build_filenamev([SLOTS, `${name}-off`]);
        if (on)
            GLib.unlink(path);
        else
            GLib.file_set_contents(path, '');
    }

    _toggleOptions() {
        if (!this._options) {
            this._menuManager ??= new PopupMenu.PopupMenuManager(this._indicator);
            this._options = new PopupMenu.PopupMenu(this._tag, 0.5, St.Side.TOP);
            this._options.actor.add_style_class_name('claude-acct-menu');
            Main.uiGroup.add_child(this._options.actor);
            this._options.actor.hide();
            this._menuManager.addMenu(this._options);
        }
        const menu = this._options;
        if (!menu.isOpen) {
            menu.removeAll();
            const status = new PopupMenu.PopupMenuItem(this._needs.length ? 'Claude needs you'
                : this._busy ? 'Claude is working' : 'Claude is idle', {reactive: false, can_focus: false});
            status.label.add_style_class_name('claude-acct-menu-status');
            menu.addMenuItem(status);
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const awake = new PopupMenu.PopupSwitchMenuItem('Stay awake while Claude works', this._option('keep-awake'));
            awake.connect('toggled', (item, on) => this._setOption('keep-awake', on));
            menu.addMenuItem(awake);
            menu.addMenuItem(this._hint('No sleep until it\'s done, even with the lid closed'));
            const auto = new PopupMenu.PopupSwitchMenuItem('Switch accounts at 100%', this._option('auto-switch'));
            auto.connect('toggled', (item, on) => {
                this._setOption('auto-switch', on);
                if (on)
                    this._fetchUsage();
            });
            menu.addMenuItem(auto);
            menu.addMenuItem(this._hint('To the account with the most room left'));
            const ask = new PopupMenu.PopupSwitchMenuItem('Permission prompts as notifications', this._option('ask'));
            ask.connect('toggled', (item, on) => this._setOption('ask', on));
            menu.addMenuItem(ask);
            menu.addMenuItem(this._hint('Yes, Always or No without going to the terminal'));
            // ThinkPads only; claude-busy can drive them once install-lights.sh has run.
            if (GLib.file_test(`${LEDS}/tpacpi::lid_logo_dot`, GLib.FileTest.IS_DIR)) {
                const ready = GLib.access(`${LEDS}/tpacpi::lid_logo_dot/pattern`, 2) === 0;
                const lights = new PopupMenu.PopupSwitchMenuItem('Blink the ThinkPad lights', ready && this._option('lights'));
                lights.setSensitive(ready);
                lights.connect('toggled', (item, on) => {
                    this._setOption('lights', on);
                    this._runBusy('lights');
                });
                menu.addMenuItem(lights);
                menu.addMenuItem(this._hint(ready ? 'Lid logo while Claude works, both lights when it needs you'
                    : 'Needs a one-time setup: install-lights.sh'));
            }
        }
        this._hideTip();
        menu.toggle();
    }

    // claude-busy for a change made here (the lights follow a switch at once).
    _runBusy(...args) {
        try {
            Gio.Subprocess.new([BUSY_CMD, ...args], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {}
    }

    _hint(text) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false});
        item.add_style_class_name('claude-acct-menu-hint-item');
        item.label.add_style_class_name('claude-acct-menu-hint');
        return item;
    }

    // `claude-account usage` switched accounts because the active one hit its limit.
    _notifyAutoSwitch(before) {
        const after = this._readFile('active').trim();
        const last = readHistory().at(-1);
        if (!before || after === before || last?.switch !== after || last?.auto !== before)
            return;
        const reset = this._resetText(before).replace(/^Resets in .* \(at (.*)\)$/, 'resets at $1');
        Main.notify(`Switched to Claude account ${label(after)}`,
            `Account ${label(before)} reached its 5-hour limit${reset.startsWith('resets') ? ` (${reset})` : ''}. ` +
            'A running chat continues on the new account with your next message.');
    }

    // ---- usage history panel -------------------------------------------------------
    _toggleHistory(b) {
        if (!b._menu) {
            this._menuManager ??= new PopupMenu.PopupMenuManager(this._indicator);
            b._menu = new PopupMenu.PopupMenu(b, 0.5, St.Side.TOP);
            b._menu.actor.add_style_class_name('claude-acct-menu');
            Main.uiGroup.add_child(b._menu.actor);
            b._menu.actor.hide();
            this._menuManager.addMenu(b._menu);
            b.connect('destroy', () => b._menu?.destroy());
        }
        if (!b._menu.isOpen)
            this._fillHistory(b);
        this._hideTip();
        b._menu.toggle();
    }

    _fillHistory(b) {
        const n = b._slot;
        const menu = b._menu;
        menu.removeAll();
        const active = n === this._readFile('active').trim();
        let account = {};
        try {
            account = JSON.parse(this._readFile(`${n}.json`)).oauthAccount ?? {};
        } catch {}
        const hist = readHistory().filter(e => e.a === n);

        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false,
            style_class: 'claude-acct-history'});
        const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'claude-acct-history-box'});
        item.add_child(box);
        menu.addMenuItem(item);

        // Header: name, who, and the current reading
        const head = new St.BoxLayout({style_class: 'claude-acct-history-head'});
        head.add_child(new St.Label({text: label(n), style_class: `claude-acct-history-name${active ? ' active' : ''}`}));
        head.add_child(new St.Label({text: [account.emailAddress, account.organizationName].filter(Boolean).join(' · ') ||
            'Claude account', style_class: 'claude-acct-history-who', y_align: Clutter.ActorAlign.CENTER,
            x_expand: true}));
        // % or tokens for everything below; the choice is remembered.
        const inTokens = this._unit() === 'tokens';
        const unit = new St.BoxLayout({style_class: 'claude-acct-unit', y_align: Clutter.ActorAlign.CENTER});
        for (const [key, text] of [['pct', '%'], ['tokens', 'Tokens']]) {
            const btn = new St.Button({label: text, style_class: 'claude-acct-unit-btn', can_focus: true,
                checked: (key === 'tokens') === inTokens});
            btn.connect('clicked', () => {
                if ((key === 'tokens') === inTokens)
                    return;
                this._setUnit(key);
                // Rebuild once this click is over; the button goes with it.
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (b._menu?.isOpen)
                        this._fillHistory(b);
                    return GLib.SOURCE_REMOVE;
                });
            });
            unit.add_child(btn);
        }
        head.add_child(unit);
        box.add_child(head);
        const tokens = readTokens();
        const win = this._window(n);
        const pct = this._pct(n);
        const now = Date.now() / 1000;
        const firstHour = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
        const hours = hourlyUse(hist.filter(e => e.t >= firstHour - 6 * HOUR), firstHour);
        const hourTokens = hours.map((_, i) => tokensBetween(tokens, n, firstHour + i * HOUR, firstHour + (i + 1) * HOUR));
        const totalTokens = hourTokens.reduce((a, b) => a + b, 0);
        // In tokens the window that's running is the Now row below, so the header shows the day.
        let current;
        if (inTokens)
            current = totalTokens ? `${short(totalTokens)} tokens in the last 24 hours` : 'No tokens in the last 24 hours';
        else
            current = typeof pct === 'number' ? `${Math.round(pct)}% of the 5-hour limit` : 'Usage unknown';
        box.add_child(new St.Label({text: current, style_class: 'claude-acct-history-now'}));
        box.add_child(new St.Label({text: this._resetText(n), style_class: 'claude-acct-history-reset'}));

        // Chart: what each of the last 24 hours used, hover a bar for its numbers
        box.add_child(new St.Label({text: 'Last 24 hours', style_class: 'claude-acct-history-title'}));
        const chart = new St.DrawingArea({style_class: 'claude-acct-chart', width: 320, height: 84,
            reactive: true, track_hover: true});
        const detail = new St.Label({style_class: 'claude-acct-chart-detail'});
        const total = Math.round(hours.reduce((a, b) => a + b, 0));
        const busiest = hourTokens.indexOf(Math.max(...hourTokens));
        const hourName = i => {
            const from = GLib.DateTime.new_from_unix_local(firstHour + i * HOUR);
            return `${from.format('%H:00')}–${from.add_hours(1).format('%H:00')}`;
        };
        const summary = () => {
            // The day's total is in the header already; under the chart, its busiest hour.
            if (inTokens)
                detail.text = totalTokens ? `Busiest hour ${hourName(busiest)}  ·  ${short(hourTokens[busiest])} tokens`
                    : 'Hover a bar for its hour';
            else
                detail.text = total ? `${total}% of the limit used in the last 24 hours` : 'Nothing used in the last 24 hours';
        };
        summary();
        chart._hovered = -1;
        chart.connect('repaint', area => inTokens ? this._drawChart(area, hourTokens, 1) : this._drawChart(area, hours, 20));
        chart.connect('motion-event', (area, event) => {
            const [x] = area.transform_stage_point(...event.get_coords()).slice(1);
            const i = Math.max(0, Math.min(23, Math.floor(x / area.width * 24)));
            if (i !== area._hovered) {
                area._hovered = i;
                detail.text = `${hourName(i)}  ·  ` +
                    (inTokens ? `${short(hourTokens[i])} tokens` : `${Math.round(hours[i])}% used`);
                area.queue_repaint();
            }
            return Clutter.EVENT_PROPAGATE;
        });
        chart.connect('leave-event', area => {
            area._hovered = -1;
            summary();
            area.queue_repaint();
            return Clutter.EVENT_PROPAGATE;
        });
        box.add_child(chart);
        const axis = new St.BoxLayout({style_class: 'claude-acct-chart-axis'});
        const hourLabel = h => GLib.DateTime.new_from_unix_local(firstHour + h * HOUR).format('%H:00');
        axis.add_child(new St.Label({text: hourLabel(0), x_expand: true}));
        axis.add_child(new St.Label({text: hourLabel(12)}));
        axis.add_child(new St.Label({text: 'now', x_expand: true, x_align: Clutter.ActorAlign.END}));
        box.add_child(axis);
        box.add_child(detail);

        // Recent 5-hour windows with their peak
        box.add_child(new St.Label({text: 'Recent 5-hour windows', style_class: 'claude-acct-history-title'}));
        const windows = windowsOf(hist, now - 7 * DAY).slice(0, 6).map(w => {
            const end = GLib.DateTime.new_from_unix_local(w.end);
            return {end, start: end.add_hours(-5), peak: w.peak, now: w.end - 5 * HOUR <= now && now < w.end,
                tokens: tokensBetween(tokens, n, w.end - 5 * HOUR, w.end)};
        });
        const mostTokens = Math.max(1, ...windows.map(w => w.tokens));
        if (!windows.length)
            box.add_child(new St.Label({text: 'Nothing recorded yet. Usage is saved every minute from now on.',
                style_class: 'claude-acct-history-empty'}));
        for (const w of windows) {
            const row = new St.BoxLayout({style_class: `claude-acct-window${w.now ? ' now' : ''}`});
            row.add_child(new St.Label({text: `${w.now ? 'Now' : dayName(w.start)}  ${w.start.format('%H:%M')}–${w.end.format('%H:%M')}`,
                style_class: 'claude-acct-window-when', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
            const track = new St.Widget({style_class: 'claude-acct-window-track', y_align: Clutter.ActorAlign.CENTER});
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            // Tokens: bars against the window that used the most.
            const share = inTokens ? w.tokens / mostTokens : Math.min(w.peak, 100) / 100;
            track.add_child(new St.Widget({style_class: `claude-acct-window-fill${active ? ' active' : ''}`,
                width: Math.round(90 * scale * share)}));
            row.add_child(track);
            row.add_child(new St.Label({text: inTokens ? (w.tokens ? short(w.tokens) : '–') : `${Math.round(w.peak)}%`,
                style_class: 'claude-acct-window-pct', y_align: Clutter.ActorAlign.CENTER}));
            box.add_child(row);
        }

        const since = hist.length ? GLib.DateTime.new_from_unix_local(hist[0].t) : null;
        box.add_child(new St.Label({text: since ? `Recorded since ${dayName(since).replace(/^(Today|Yesterday)$/, d => d.toLowerCase())} ${since.format('%H:%M')}` +
            ' · claude-account history' : 'claude-account history', style_class: 'claude-acct-history-foot'}));
        if (inTokens)
            box.add_child(new St.Label({text: 'Input, output and cache writes, on this computer',
                style_class: 'claude-acct-history-foot'}));
    }

    // 24 orange bars, one per hour, scaled to the busiest hour (at least `floor`).
    _drawChart(area, hours, floor) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const pad = 4 * scale;
        const top = Math.max(floor, ...hours);
        const slot = (w - 2 * pad) / 24;
        const gap = Math.max(1, Math.round(slot * 0.25));
        cr.setSourceRGBA(1, 1, 1, 0.08);
        cr.setLineWidth(1);
        cr.moveTo(pad, h - pad + 0.5);
        cr.lineTo(w - pad, h - pad + 0.5);
        cr.stroke();
        hours.forEach((used, i) => {
            const x = Math.round(pad + i * slot);
            const bw = Math.round(pad + (i + 1) * slot) - x - gap;
            const bh = used > 0 ? Math.max(2 * scale, Math.round((h - 2 * pad) * used / top)) : 0;
            const [r, g, b] = ORANGE_RGB;
            const dim = area._hovered >= 0 && area._hovered !== i;
            if (bh) {
                cr.setSourceRGBA(r, g, b, dim ? 0.45 : 1);
                cr.rectangle(x, h - pad - bh, bw, bh);
                cr.fill();
            } else if (area._hovered === i) {
                cr.setSourceRGBA(1, 1, 1, 0.15);
                cr.rectangle(x, h - pad - 2 * scale, bw, 2 * scale);
                cr.fill();
            }
        });
        cr.$dispose();
    }

    // The account's current 5-hour window from its last reading: {end (unix), ended}.
    _window(slot) {
        const end = resetTime(this._readUsage()[slot]?.resets_at);
        return end ? {end, ended: end <= Date.now() / 1000} : null;
    }

    // A window that has ended means the limit is back to 0, even before the next reading.
    _pct(slot) {
        const pct = this._readUsage()[slot]?.pct;
        return typeof pct === 'number' && this._window(slot)?.ended ? 0 : pct;
    }

    _resetText(slot) {
        const u = this._readUsage()[slot];
        if (!u || typeof u.pct !== 'number')
            return 'Usage unknown';
        if (!u.resets_at)
            return 'No 5-hour window running: the next one starts with your next message';
        const reset = GLib.DateTime.new_from_iso8601(u.resets_at, null);
        if (!reset)
            return 'Usage unknown';
        if (this._window(slot).ended)
            return `Limit reset at ${reset.to_local().format('%H:%M')}: the next window starts with your next message`;
        const mins = Math.max(0, Math.ceil(reset.difference(GLib.DateTime.new_now_utc()) / 60e6));
        const left = mins >= 60 ? `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min`
            : `${mins} min`;
        return `Resets in ${left} (at ${reset.to_local().format('%H:%M')})`;
    }

    // The history panel's % or tokens, kept in a dotfile next to the accounts.
    _unit() {
        return this._readFile('.panel-unit').trim() === 'tokens' ? 'tokens' : 'pct';
    }

    _setUnit(unit) {
        GLib.file_set_contents(GLib.build_filenamev([SLOTS, '.panel-unit']), `${unit}\n`);
    }

    _tagText() {
        if (this._needs.length > 1)
            return `Claude needs you in ${this._needs.map(e => `“${this._chatName(e)}”`).join(', ')}. Click to open the first`;
        if (this._needs.length)
            return `Claude needs you in “${this._chatName(this._needs[0])}”. Click to open it`;
        return this._busy ? 'Claude is working: no sleep until it\'s done, lid closed or not' : 'Claude is idle';
    }

    _hideTip() {
        if (this._tipTimer)
            GLib.source_remove(this._tipTimer);
        this._tipTimer = null;
        this._tip?.remove_all_transitions();
        this._tip?.hide();
        this._showTabs(false);
    }

    _showTooltip(b) {
        if (this._tipTimer)
            GLib.source_remove(this._tipTimer);
        this._tipTimer = null;
        if (!b.hover) {
            // The mascot's box stays while the pointer is on it, so its bars can be clicked.
            if (b === this._tag) {
                this._tipTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                    this._tipTimer = null;
                    if (!this._tip.hover && !this._tag.hover)
                        this._hideTip();
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            this._hideTip();
            return;
        }
        if (b === this._tag)
            this._tooltip.text = this._tagText();
        else if (b === this._addBtn)
            this._tooltip.text = 'Add a Claude account';
        else
            this._tooltip.text = this._signedIn.has(b._slot)
                ? this._resetText(b._slot) : 'Not signed in. Click to sign in.';
        if (b !== this._tag)
            this._tooltip.width = -1;   // the other buttons' hover text fits its own width
        this._tipFor = b;
        this._showTabs(b === this._tag);
        if (!this._tip.visible) {
            // Fades in like GNOME's own hover labels.
            this._tip.opacity = 0;
            this._tip.show();
            this._tip.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        if (b === this._tag)
            this._breathe();
        this._placeTip(b);
    }

    _placeTip(b) {
        const [x, y] = b.get_transformed_position();
        const [w, h] = b.get_transformed_size();
        const [, tw] = this._tip.get_preferred_width(-1);
        // Centred under the button, but kept on the screen.
        const monitor = Main.layoutManager.findMonitorForActor(b) ?? Main.layoutManager.primaryMonitor;
        const left = Math.max(monitor.x + 4, Math.min(x + w / 2 - tw / 2, monitor.x + monitor.width - tw - 4));
        this._tip.set_position(Math.round(left), Math.round(y + h + 6));
    }

    // ---- your chats, under the mascot's hover text ------------------------------------
    // One rounded rectangle per Claude chat, in the order of your terminal tabs: desktop by
    // desktop, windows left to right, tabs in their order. Grey: idle; orange and breathing:
    // working; white: waiting for you. No names or numbers, only where they are.
    _showTabs(on) {
        if (!on) {
            this._tabsRow.visible = false;
            this._tabsRow.get_children().forEach(c => c.remove_all_transitions());
            return;
        }
        // The last known tab layout, with each chat's state as it is now; then a fresh look at
        // the tabs, redrawn only if they changed (it's usually fresh already, see _watchSessions).
        this._redrawTabs();
        this._refreshTabs(() => this._redrawTabs());
    }

    _redrawTabs() {
        this._tabsCache = this._orderChats(this._tabsWindows ?? []);
        this._drawTabs(this._tabsCache);
    }

    // claude-tabs reads the terminals' tabs from the accessibility bus (about 0.2 s), one run at
    // a time; onChange runs when the layout differs from the last one.
    _refreshTabs(onChange) {
        if (this._tabsProc) {
            this._tabsAgain = onChange;
            return;
        }
        try {
            const proc = Gio.Subprocess.new([TABS_CMD], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._tabsProc = proc;
            proc.communicate_utf8_async(null, null, (p, res) => {
                let text = null;
                try {
                    text = p.communicate_utf8_finish(res)[1];
                } catch {}
                if (this._tabsProc !== proc)
                    return;   // disabled meanwhile
                this._tabsProc = null;
                let windows = null;
                try {
                    windows = JSON.parse(text);
                } catch {}
                if (Array.isArray(windows) && JSON.stringify(windows) !== JSON.stringify(this._tabsWindows)) {
                    this._tabsWindows = windows;
                    if (this._tip?.visible && this._tipFor === this._tag)
                        onChange?.();
                }
                const again = this._tabsAgain;
                this._tabsAgain = null;
                if (again)
                    this._refreshTabs(again);
            });
        } catch {
            this._tabsProc = null;
        }
    }

    // A chat starting or ending changes the tabs: look again in the background (twice, as Claude
    // titles its terminal a moment after it starts), so the box opens with them right.
    _watchSessions() {
        const dir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'sessions']));
        try {
            this._sessionsMonitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        } catch {
            return;
        }
        this._sessionsMonitor.connect('changed', (m, f, o, event) => {
            if (event === Gio.FileMonitorEvent.CHANGED || event === Gio.FileMonitorEvent.CHANGES_DONE_HINT)
                return;
            if (this._sessionsTimer)
                GLib.source_remove(this._sessionsTimer);
            let runs = 0;
            this._sessionsTimer = GLib.timeout_add(GLib.PRIORITY_LOW, 1500, () => {
                this._refreshTabs(() => this._redrawTabs());
                if (++runs < 2)
                    return GLib.SOURCE_CONTINUE;   // and once more after Claude titled its tab
                this._sessionsTimer = null;
                return GLib.SOURCE_REMOVE;
            });
        });
        this._refreshTabs(null);
    }

    // Claude's live chats with their state, [{id, title, state}], in your tab order.
    _orderChats(windows) {
        const busy = new Set(this._sessionFiles(BUSY_DIR));
        const needs = new Set(this._readNeeds().map(e => e.id));
        const chats = [];
        const sessions = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'sessions']);
        for (const name of this._sessionFiles(sessions).filter(n => n.endsWith('.json'))) {
            let info;
            try {
                info = JSON.parse(readText(GLib.build_filenamev([sessions, name])));
            } catch {
                continue;
            }
            if (!info?.sessionId || !GLib.file_test(`/proc/${info.pid}`, GLib.FileTest.EXISTS))
                continue;
            const transcript = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'projects',
                (info.cwd ?? '').replace(/[^A-Za-z0-9]/g, '-'), `${info.sessionId}.jsonl`]);
            chats.push({id: info.sessionId, pid: info.pid, cwd: info.cwd, transcript,
                title: this._chatName({transcript, cwd: info.cwd}),
                state: needs.has(info.sessionId) ? 'needs' : busy.has(info.sessionId) ? 'working' : 'idle'});
        }
        // Windows desktop by desktop, then left to right (then top to bottom).
        const metaWindows = global.get_window_actors().map(a => a.meta_window);
        const place = title => {
            const w = metaWindows.find(m => (m.get_title() ?? '').trim() === title);
            if (!w)
                return [99, 0, 0];
            const r = w.get_frame_rect();
            return [w.get_workspace()?.index() ?? 0, r.x, r.y];
        };
        const before = (a, b) => {
            for (let k = 0; k < a.length; k++) {
                if (a[k] !== b[k])
                    return a[k] - b[k];
            }
            return 0;
        };
        const ordered = windows.map((w, i) => ({...w, at: [...place(w.window), i]})).sort((a, b) => before(a.at, b.at));
        // A tab is a chat when it names the chat's session (claude --resume ID) or shows its title.
        const placed = [];
        for (const w of ordered) {
            (w.tabs ?? []).forEach((tab, i) => {
                const title = bareTitle(tab).replace(/ — .*$/, '');
                const chat = chats.find(c => !placed.includes(c) && tab.includes(c.id)) ??
                    chats.find(c => !placed.includes(c) && c.title === title);
                if (chat) {
                    // Where to find it: its window, and its tab there (when the window has several).
                    Object.assign(chat, {window: w.window, tab, tabIndex: i, tabCount: w.tabs.length});
                    placed.push(chat);
                }
            });
        }
        // Chats in other terminals come last.
        return [...placed, ...chats.filter(c => !placed.includes(c))];
    }

    _drawTabs(chats) {
        const key = chats.map(c => `${c.id}:${c.state}`).join();
        if (key !== this._tabsKey) {
            this._tabsKey = key;
            this._tabsRow.destroy_all_children();
            for (const c of chats) {
                const bar = new St.Button({style_class: `claude-acct-tab ${c.state}`, y_align: Clutter.ActorAlign.CENTER,
                    can_focus: true, accessible_name: c.title});
                // A hand over it: it can be clicked.
                bar.set_cursor_type?.(Clutter.CursorType.POINTER);
                // The chat as last seen (its tab's place can be learnt after the bar was made).
                const chat = () => this._tabsCache?.find(x => x.id === c.id) ?? c;
                // Hovering a bar names its chat in the text above.
                bar.connect('notify::hover', () => {
                    this._tooltip.text = bar.hover ? barText(chat()) : this._tagText();
                });
                bar.connect('clicked', () => this._openTab(chat()));
                this._tabsRow.add_child(bar);
            }
        }
        this._tabsRow.visible = chats.length > 0;
        this._fitTagText(chats);
        if (this._tip.visible) {
            this._breathe();
            this._placeTip(this._tag);
        }
    }

    // Orange ones breathe while the box is open (GNOME only animates what's on screen, so this
    // runs once the box shows).
    _breathe() {
        for (const r of this._tabsRow.get_children()) {
            r.remove_all_transitions();
            r.opacity = 255;
            if (r.has_style_class_name('working'))
                r.ease({opacity: 90, duration: 900, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE, repeatCount: -1, autoReverse: true});
        }
    }

    // The mascot's box keeps one width while it's open: as wide as the longest text it can show
    // (its line, or any chat's name). Hovering a bar only swaps the text, so the bars never move
    // under the pointer.
    _fitTagText(chats) {
        const label = this._tooltip;
        const shown = label.text;
        label.width = -1;
        let widest = 0;
        for (const text of [this._tagText(), ...chats.map(barText)]) {
            label.text = text;
            widest = Math.max(widest, label.get_preferred_width(-1)[1]);
        }
        label.text = shown;
        label.width = Math.min(widest, MAX_TIP_WIDTH * St.ThemeContext.get_for_stage(global.stage).scale_factor);
    }

    _run(args, onDone) {
        try {
            const p = Gio.Subprocess.new([SCRIPT, ...args], Gio.SubprocessFlags.STDOUT_SILENCE |
                Gio.SubprocessFlags.STDERR_PIPE);
            p.communicate_utf8_async(null, null, (proc, res) => {
                let err = '';
                try { [, , err] = proc.communicate_utf8_finish(res); } catch {}
                onDone?.(proc.get_successful(), err);
                this._refresh();
            });
        } catch (e) {
            onDone?.(false, e.message);
        }
    }

    _fetchUsage() {
        if (this._fetching)
            return;
        this._fetching = true;
        const before = this._readFile('active').trim();
        this._run(['usage'], () => {
            this._fetching = false;
            this._notifyAutoSwitch(before);
        });
    }

    _askSignIn(n) {
        const dialog = new ModalDialog.ModalDialog();
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: `Sign in to Claude account ${label(n)}`,
            description: 'Your browser opens the Claude sign-in page. A private window makes sure ' +
                'it doesn\'t reuse an account you\'re already signed in to. Once you\'re in, ' +
                'this account becomes the active one.',
        }));
        dialog.setButtons([
            {label: 'Cancel', action: () => dialog.close(), key: Clutter.KEY_Escape},
            {label: 'Normal window', action: () => { dialog.close(); this._signIn(n, false); }},
            {label: 'Private window', action: () => { dialog.close(); this._signIn(n, true); }, default: true},
        ]);
        dialog.open();
    }

    // Name a new account, then sign in to it.
    _askNewAccount() {
        const taken = new Set(this._slots());
        let suggestion = 1;
        while (taken.has(String(suggestion)))
            suggestion++;
        const dialog = new ModalDialog.ModalDialog();
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: 'Add a Claude account',
            description: 'Give it a short name for the top bar, like 2, work or −. Then sign in. ' +
                'A private window makes sure your browser doesn\'t reuse an account you\'re ' +
                'already signed in to.',
        }));
        const entry = new St.Entry({style_class: 'claude-acct-entry', text: String(suggestion),
            can_focus: true, x_expand: true});
        dialog.contentLayout.add_child(entry);
        const error = new St.Label({style_class: 'claude-acct-error', text: ''});
        dialog.contentLayout.add_child(error);
        const go = privateWindow => {
            const raw = entry.get_text().trim();
            const name = raw === '−' ? '-' : raw;
            if (!name || name.includes('/') || name.startsWith('.')) {
                error.text = 'Pick a name without "/" that doesn\'t start with "."';
                return;
            }
            if (taken.has(name)) {
                error.text = `There's already an account named ${label(name)}`;
                return;
            }
            dialog.close();
            this._signIn(name, privateWindow);
        };
        dialog.setButtons([
            {label: 'Cancel', action: () => dialog.close(), key: Clutter.KEY_Escape},
            {label: 'Normal window', action: () => go(false)},
            {label: 'Private window', action: () => go(true), default: true},
        ]);
        dialog.setInitialKeyFocus(entry.clutter_text);
        entry.clutter_text.connect('activate', () => go(true));
        dialog.open();
        entry.clutter_text.set_selection(0, -1);
    }

    // The sign-in runs in a terminal so the login can fall back to pasting a code.
    _signIn(n, privateWindow) {
        const cmd = `export PATH="$HOME/.local/bin:$PATH"; ${GLib.shell_quote(SCRIPT)} add ${GLib.shell_quote(n)}` +
            `${privateWindow ? ' --private' : ''} --switch && { echo; echo 'Done, this window closes in 3 seconds.'; sleep 3; } ` +
            '|| { echo; read -rp "Sign-in did not finish. Press Enter to close."; }';
        const terminal = TERMINALS.find(t => GLib.find_program_in_path(t[0]));
        if (!terminal) {
            Main.notify('Claude account sign-in', `No terminal found. Run: claude-account add ${n}`);
            return;
        }
        try {
            Gio.Subprocess.new([...terminal, 'bash', '-c', cmd], Gio.SubprocessFlags.NONE);
        } catch (e) {
            Main.notify('Claude account sign-in failed', e.message);
        }
    }

    _switch(n) {
        this._run(['switch', n], (ok, err) => {
            if (!ok)
                Main.notify('Claude account switch failed', err || '');
            this._fetchUsage();
        });
    }
}
