import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const SLOTS = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'accounts']);
const SCRIPT = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'claude-account']);
const TRACK_WIDTH = 44;
const POLL_SECONDS = 60;
// Terminals tried, in order, to run the browser sign-in.
const TERMINALS = [
    ['xdg-terminal-exec'],
    ['ptyxis', '--new-window', '--'],
    ['kgx', '--'],
    ['gnome-terminal', '--'],
    ['konsole', '-e'],
    ['xterm', '-e'],
];

function label(n) {
    return n === '-' ? '−' : n;
}

export default class ClaudeAccountExtension extends Extension {
    enable() {
        this._indicator = new PanelMenu.Button(0.0, 'Claude Account', true);
        this._box = new St.BoxLayout({style_class: 'claude-acct-box'});
        this._box.add_child(new St.Label({text: 'Claude', style_class: 'claude-acct-tag',
            y_align: Clutter.ActorAlign.CENTER}));
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
        this._monitor?.cancel();
        this._monitor = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._tooltip?.destroy();
        this._tooltip = null;
        this._buttons = [];
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
        const b = new St.Button({style_class: 'claude-acct-btn', y_align: Clutter.ActorAlign.CENTER});
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
        b.connect('clicked', () => this._signedIn.has(n) ? this._switch(n) : this._askSignIn(n));
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
        if (b === this._addBtn)
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
