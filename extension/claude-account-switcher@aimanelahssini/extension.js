import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
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
// Claude Code's spinner, as it looks in a terminal on Linux: the glyph runs forward then back,
// and a three-letter glimmer sweeps over the word. One light timer drives both.
const SPINNER = ['·', '✢', '*', '✶', '✻', '✽'];
const SPINNER_FRAMES = [...SPINNER, ...[...SPINNER].reverse()];
const SPINNER_MS = 120;
const GLIMMER_PAUSE = 8;   // frames between two sweeps
const ORANGE = '#d77757';
const SHIMMER = '#eb9f7f';
// Claude Code's mascot in its own terminal art, " ▐▛███▜▌ / ▝▜█████▛▘ /   ▘▘ ▝▝ ", as
// [x, y, width, height] in quarter-character cells (twice as tall as wide on screen).
const MASCOT = [[2, 0, 12, 4], [0, 2, 16, 1], [3, 4, 1, 1], [5, 4, 1, 1], [10, 4, 1, 1], [12, 4, 1, 1]];
const MASCOT_EYES = [[4, 1], [11, 1]];
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

function dayName(d) {
    const today = GLib.DateTime.new_now_local();
    const diff = today.get_day_of_year() - d.get_day_of_year() + 365 * (today.get_year() - d.get_year());
    return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.format('%a %e %b');
}

function label(n) {
    return n === '-' ? '−' : n;
}

export default class ClaudeAccountExtension extends Extension {
    enable() {
        this._indicator = new PanelMenu.Button(0.0, 'Claude Account', true);
        this._box = new St.BoxLayout({style_class: 'claude-acct-box'});
        // Claude Code's mascot: grey, orange with its spinner next to it while Claude works.
        this._tag = new St.BoxLayout({style_class: 'claude-acct-tag', reactive: true, track_hover: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._mascot = new St.DrawingArea({style_class: 'claude-acct-mascot', y_align: Clutter.ActorAlign.CENTER});
        this._mascot.connect('repaint', area => this._drawMascot(area));
        this._tag.add_child(this._mascot);
        this._spinner = new St.BoxLayout({style_class: 'claude-acct-spinner', visible: false,
            y_align: Clutter.ActorAlign.CENTER});
        // The glyphs come from different fonts; a fixed-width box keeps the word still.
        this._glyph = new St.Label({style_class: 'claude-acct-spinner-glyph', y_align: Clutter.ActorAlign.CENTER});
        this._verb = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._spinner.add_child(this._glyph);
        this._spinner.add_child(this._verb);
        this._tag.add_child(this._spinner);
        this._tag.connect('notify::hover', () => this._showTooltip(this._tag));
        this._box.add_child(this._tag);
        this._indicator.add_child(this._box);
        this._buttons = [];
        this._addBtn = new St.Button({label: '+', style_class: 'claude-acct-btn claude-acct-add',
            y_align: Clutter.ActorAlign.CENTER});
        this._addBtn.connect('clicked', () => this._askNewAccount());
        this._addBtn.connect('notify::hover', () => this._showTooltip(this._addBtn));
        this._box.add_child(this._addBtn);
        this._tooltip = new St.Label({style_class: 'claude-acct-tooltip', visible: false});
        Main.layoutManager.uiGroup.add_child(this._tooltip);

        GLib.mkdir_with_parents(SLOTS, 0o700);
        this._monitor = Gio.File.new_for_path(SLOTS).monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', () => this._refresh());
        this._refresh();
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Orange while Claude Code is working (see claude-busy), grey otherwise.
        this._busy = null;
        GLib.mkdir_with_parents(BUSY_DIR, 0o700);
        this._busyMonitor = Gio.File.new_for_path(BUSY_DIR).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._busyMonitor.connect('changed', (m, f, o, event) => {
            // Each tool call rewrites its session's file; only files coming and going matter.
            if (event !== Gio.FileMonitorEvent.CHANGED && event !== Gio.FileMonitorEvent.CHANGES_DONE_HINT &&
                event !== Gio.FileMonitorEvent.ATTRIBUTE_CHANGED)
                this._syncBusy();
        });
        this._syncBusy();

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
        this._busyMonitor?.cancel();
        this._busyMonitor = null;
        this._spin(false);
        this._monitor?.cancel();
        this._monitor = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._tooltip?.destroy();
        this._tooltip = null;
        this._buttons?.forEach(b => b._menu?.destroy());
        this._menuManager = null;
        this._buttons = [];
    }

    _syncBusy() {
        let busy = false;
        try {
            const en = Gio.File.new_for_path(BUSY_DIR).enumerate_children('standard::name', 0, null);
            let info;
            while (!busy && (info = en.next_file(null)))
                busy = !info.get_name().startsWith('.');
            en.close(null);
        } catch {}
        if (busy === this._busy)
            return;
        this._busy = busy;
        if (busy)
            this._tag.add_style_class_name('busy');
        else
            this._tag.remove_style_class_name('busy');
        this._mascot.queue_repaint();
        this._spin(busy);
        if (this._tag.hover)
            this._showTooltip(this._tag);
    }

    _drawMascot(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const sx = w / 16, sy = h / 5;
        const c = area.get_theme_node().get_foreground_color();
        cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255);
        for (const [x, y, cw, ch] of MASCOT)
            cr.rectangle(x * sx, y * sy, cw * sx, ch * sy);
        cr.fill();
        cr.setOperator(0);  // CLEAR: the eyes are holes
        for (const [x, y] of MASCOT_EYES)
            cr.rectangle(x * sx, y * sy, sx, sy);
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
        this._spinner.visible = on;
        if (!on)
            return;
        const verbs = this._verbs();
        const word = `${verbs[Math.floor(Math.random() * verbs.length)]}…`;
        const chars = [...word];
        let frame = 0;
        const draw = () => {
            const glimmer = frame % (chars.length + GLIMMER_PAUSE) - 1;
            const text = chars.map((ch, i) => Math.abs(i - glimmer) <= 1
                ? `<span foreground="${SHIMMER}">${GLib.markup_escape_text(ch, -1)}</span>`
                : GLib.markup_escape_text(ch, -1)).join('');
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
            if (n.endsWith('.json')) saved.push(n.slice(0, -5));
        }
        this._signedIn = new Set(saved);
        const listed = this._readFile('names').split('\n').map(l => l.trim()).filter(Boolean);
        return [...listed, ...saved.sort().filter(n => !listed.includes(n))];
    }

    _makeButton(n) {
        const b = new St.Button({style_class: 'claude-acct-btn', y_align: Clutter.ActorAlign.CENTER,
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
        const usage = this._readUsage();
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
            const pct = usage[b._slot]?.pct;
            const known = typeof pct === 'number';
            b._pct.text = known ? `${Math.round(pct)}%` : '?';
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            b._fill.width = known ? Math.round(TRACK_WIDTH * scale * Math.min(pct, 100) / 100) : 0;
            const isActive = b._slot === active;
            if (isActive) b.add_style_class_name('active');
            else b.remove_style_class_name('active');
        }
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
        this._tooltip.hide();
        b._menu.toggle();
    }

    _fillHistory(b) {
        const n = b._slot;
        const menu = b._menu;
        menu.removeAll();
        const active = n === this._readFile('active').trim();
        const usage = this._readUsage()[n] ?? {};
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
            'Claude account', style_class: 'claude-acct-history-who', y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(head);
        const pct = typeof usage.pct === 'number' ? `${Math.round(usage.pct)}% of the 5-hour limit` : 'Usage unknown';
        box.add_child(new St.Label({text: `${pct} · ${this._resetText(n).replace(/^R/, 'r')}`,
            style_class: 'claude-acct-history-now'}));

        // Chart: the last 24 hours
        box.add_child(new St.Label({text: 'Last 24 hours', style_class: 'claude-acct-history-title'}));
        const now = Date.now() / 1000;
        const points = hist.filter(e => e.t >= now - DAY).map(e => [e.t, e.pct, e.reset]);
        const chart = new St.DrawingArea({style_class: 'claude-acct-chart', width: 320, height: 84});
        chart.connect('repaint', area => this._drawChart(area, points, now, active));
        box.add_child(chart);
        const axis = new St.BoxLayout({style_class: 'claude-acct-chart-axis'});
        axis.add_child(new St.Label({text: '24 h ago', x_expand: true}));
        axis.add_child(new St.Label({text: '12 h'}));
        axis.add_child(new St.Label({text: 'now', x_expand: true, x_align: Clutter.ActorAlign.END}));
        box.add_child(axis);

        // Recent 5-hour windows with their peak
        box.add_child(new St.Label({text: 'Recent 5-hour windows', style_class: 'claude-acct-history-title'}));
        const peaks = new Map();
        for (const e of hist)
            if (e.reset && e.t >= now - 7 * DAY)
                peaks.set(e.reset, Math.max(peaks.get(e.reset) ?? 0, e.pct));
        const windows = [...peaks].map(([reset, peak]) => {
            const end = GLib.DateTime.new_from_iso8601(reset, null)?.to_local();
            return end ? {end, start: end.add_hours(-5), peak} : null;
        }).filter(Boolean).sort((x, y) => y.end.to_unix() - x.end.to_unix()).slice(0, 6);
        if (!windows.length)
            box.add_child(new St.Label({text: 'Nothing recorded yet. Usage is saved every minute from now on.',
                style_class: 'claude-acct-history-empty'}));
        for (const w of windows) {
            const row = new St.BoxLayout({style_class: 'claude-acct-window'});
            row.add_child(new St.Label({text: `${dayName(w.start)}  ${w.start.format('%H:%M')}–${w.end.format('%H:%M')}`,
                style_class: 'claude-acct-window-when', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
            const track = new St.Widget({style_class: 'claude-acct-window-track', y_align: Clutter.ActorAlign.CENTER});
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            track.add_child(new St.Widget({style_class: `claude-acct-window-fill${active ? ' active' : ''}`,
                width: Math.round(90 * scale * Math.min(w.peak, 100) / 100)}));
            row.add_child(track);
            row.add_child(new St.Label({text: `${Math.round(w.peak)}%`, style_class: 'claude-acct-window-pct',
                y_align: Clutter.ActorAlign.CENTER}));
            box.add_child(row);
        }

        const since = hist.length ? GLib.DateTime.new_from_unix_local(hist[0].t) : null;
        box.add_child(new St.Label({text: since ? `Recorded since ${dayName(since).replace(/^(Today|Yesterday)$/, d => d.toLowerCase())} ${since.format('%H:%M')}` +
            ' · claude-account history' : 'claude-account history', style_class: 'claude-acct-history-foot'}));
    }

    _drawChart(area, points, now, active) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const pad = 4;
        const x = t => pad + (w - 2 * pad) * (1 - (now - t) / DAY);
        const y = p => h - pad - (h - 2 * pad) * Math.min(p, 100) / 100;
        // guide lines at 50% and 100%
        cr.setSourceRGBA(1, 1, 1, 0.08);
        cr.setLineWidth(1);
        for (const p of [0, 50, 100]) {
            cr.moveTo(pad, Math.round(y(p)) + 0.5);
            cr.lineTo(w - pad, Math.round(y(p)) + 0.5);
        }
        cr.stroke();
        const [r, g, bl] = active ? [0xd9 / 255, 0x77 / 255, 0x57 / 255] : [0.62, 0.62, 0.62];
        // one segment per 5-hour window, so a reset shows as a drop, and gaps stay gaps
        let prev = null;
        for (const [t, p, reset] of points) {
            const gap = prev && (t - prev[0] > 1800 || reset !== prev[2]);
            if (!prev || gap)
                cr.moveTo(x(t), y(p));
            else
                cr.lineTo(x(t), y(p));
            prev = [t, p, reset];
        }
        cr.setSourceRGBA(r, g, bl, 1);
        cr.setLineWidth(2);
        cr.stroke();
        if (prev) {
            cr.arc(x(prev[0]), y(prev[1]), 3, 0, 2 * Math.PI);
            cr.fill();
        }
        cr.$dispose();
    }

    _resetText(slot) {
        const u = this._readUsage()[slot];
        if (!u || typeof u.pct !== 'number')
            return 'Usage unknown';
        if (!u.resets_at)
            return 'No usage in this window yet';
        const reset = GLib.DateTime.new_from_iso8601(u.resets_at, null);
        if (!reset)
            return 'Usage unknown';
        const mins = Math.max(0, Math.ceil(reset.difference(GLib.DateTime.new_now_utc()) / 60e6));
        const left = mins >= 60 ? `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min`
            : `${mins} min`;
        return `Resets in ${left} (at ${reset.to_local().format('%H:%M')})`;
    }

    _showTooltip(b) {
        if (!b.hover) {
            this._tooltip.hide();
            return;
        }
        if (b === this._tag)
            this._tooltip.text = this._busy ? 'Claude is working: no sleep until it\'s done, lid closed or not'
                : 'Claude is idle';
        else if (b === this._addBtn)
            this._tooltip.text = 'Add a Claude account';
        else
            this._tooltip.text = this._signedIn.has(b._slot)
                ? this._resetText(b._slot) : 'Not signed in. Click to sign in.';
        this._tooltip.show();
        const [x, y] = b.get_transformed_position();
        const [w, h] = b.get_transformed_size();
        const [, tw] = this._tooltip.get_preferred_width(-1);
        this._tooltip.set_position(Math.round(x + w / 2 - tw / 2), Math.round(y + h + 6));
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
        this._run(['usage'], () => { this._fetching = false; });
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
