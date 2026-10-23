// Test driver for the top-bar extension in a throwaway headless shell (tests/shell/run.sh).
// Marks a made-up Claude session as working the way claude-busy does, checks the mascot turns
// orange with Claude Code's spinner next to it, and saves screenshots of the top bar to $TEST_OUT.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_area');
const OUT = GLib.getenv('TEST_OUT');
const UUID = 'claude-account-switcher@aimanelahssini';
const BUSY = `${GLib.get_user_runtime_dir()}/claude-busy`;
const lines = [];
const out = s => {
    lines.push(s);
    GLib.file_set_contents(`${OUT}/results.txt`, lines.join('\n') + '\n');
};
const check = (name, ok, extra = '') => out(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`);
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

// The extension's part of the top bar, with some room for the tooltip under it.
async function shot(name, ext, withTooltip = false, menu = null) {
    let [x, y] = ext._indicator.get_transformed_position();
    let [w, h] = ext._indicator.get_transformed_size();
    if (menu) {
        const [mx, my] = menu.get_transformed_position();
        const [mw, mh] = menu.get_transformed_size();
        x = Math.min(x, mx);
        w = Math.max(x + w, mx + mw) - x;
        h = my + mh - y;
    }
    let x2 = x + w + 12;
    x -= 12;
    if (withTooltip) {
        const [tx, ty] = ext._tooltip.get_transformed_position();
        const [tw, th] = ext._tooltip.get_transformed_size();
        x = Math.min(x, tx - 12);
        x2 = Math.max(x2, tx + tw + 12);
        h = ty + th + 12 - y;
    }
    const stream = Gio.File.new_for_path(`${OUT}/${name}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot_area(Math.max(0, x), y, x2 - Math.max(0, x), h, stream);
    stream.close(null);
}

const color = actor => actor.get_theme_node().get_foreground_color().to_string();

async function run() {
    let ext;
    for (let i = 0; i < 40 && !ext?._tag; i++) {
        await sleep(500);
        ext = Main.extensionManager.lookup(UUID)?.stateObj;
    }
    check('extension loaded', !!ext?._tag);
    Main.overview.hide();
    await sleep(1500);
    const tag = ext._tag;
    const mascot = ext._mascot;
    const idle = color(mascot);
    check('idle: not busy', ext._busy === false && !tag.has_style_class_name('busy'));
    check('idle: no spinner', !ext._spinTimer && !ext._spinner.visible);
    check('idle: mascot 30x19', mascot.width === 30 && mascot.height === 19, `${mascot.width}x${mascot.height}`);
    await shot('idle', ext);

    GLib.file_set_contents(`${BUSY}/0a1b2c3d-test`, '1\n');
    await sleep(600);
    check('busy: tag marked', ext._busy === true && tag.has_style_class_name('busy'));
    check('busy: orange mascot', color(mascot) === '#d77757ff', `${idle} -> ${color(mascot)}`);
    check('busy: spinner shown', ext._spinner.visible && !!ext._spinTimer);
    check('busy: mascot makes room', !mascot.visible);
    // run.sh sets spinnerVerbs to replace Claude Code's words with one
    check('busy: spinnerVerbs setting', ext._verb.text === 'Choreographing…', ext._verb.text);
    // Frames every 120 ms, two glyph cycles (for docs/working.gif).
    const glyphs = new Set(), glimmers = new Set(), widths = new Set();
    const t0 = GLib.get_monotonic_time();
    for (let i = 0; i < 24; i++) {
        while (GLib.get_monotonic_time() - t0 < i * 120000 + 60000)
            await sleep(5);
        glyphs.add(ext._glyph.text);
        widths.add(`${ext._verb.get_transformed_position()[0]}/${ext._tag.width}`);
        glimmers.add(ext._verb.clutter_text.get_layout().get_attributes()?.to_string());
        await shot(`spin-${String(i).padStart(2, '0')}`, ext);
    }
    check('busy: glyph cycles', glyphs.size === 6, [...glyphs].join(''));
    check('busy: glimmer moves', glimmers.size > 10, `${glimmers.size} looks`);
    check('busy: word stays put', widths.size === 1, [...widths].join());
    tag.hover = true;
    await sleep(300);
    check('busy: tooltip', ext._tooltip.visible && ext._tooltip.text.startsWith('Claude is working'), ext._tooltip.text);
    await shot('busy-tooltip', ext, true);
    tag.hover = false;

    // A heartbeat rewrites the file; that alone mustn't rescan or restart anything.
    const timer = ext._spinTimer;
    GLib.file_set_contents(`${BUSY}/0a1b2c3d-test`, '1\n');
    await sleep(400);
    check('heartbeat: same timer', ext._spinTimer === timer);

    // Holder files are ignored; removing the last session goes back to grey.
    GLib.file_set_contents(`${BUSY}/.holder`, '1\n');
    GLib.unlink(`${BUSY}/0a1b2c3d-test`);
    await sleep(600);
    check('done: grey again', ext._busy === false && color(mascot) === idle && !ext._spinner.visible && mascot.visible, color(mascot));
    check('done: timer stopped', !ext._spinTimer);

    // Disable / enable keeps working.
    GLib.file_set_contents(`${BUSY}/second`, '1\n');
    await sleep(400);
    ext.disable();
    check('disable: no timer left', !ext._spinTimer);
    ext.enable();
    await sleep(600);
    check('re-enable: busy picked up', ext._busy === true && ext._tag.has_style_class_name('busy'));
    GLib.unlink(`${BUSY}/second`);
    await sleep(600);
    check('re-enable: grey again', ext._busy === false);

    // Options menu on the mascot: the switches write the same files as the CLI.
    const accounts = `${GLib.get_home_dir()}/.claude/accounts`;
    ext._tag.emit('clicked', 3);
    await sleep(1200);
    const items = ext._options._getMenuItems();
    const switches = items.filter(i => i._switch);
    check('options: menu open', ext._options.isOpen && switches.length === 2,
        items.map(i => i.label?.text).filter(Boolean).join(' | '));
    check('options: both on by default', switches.every(i => i.state));
    await shot('options', ext, false, ext._options.actor);
    switches[0].toggle();
    check('options: keep-awake off file', GLib.file_test(`${accounts}/keep-awake-off`, GLib.FileTest.EXISTS));
    switches[0].toggle();
    check('options: keep-awake on again', !GLib.file_test(`${accounts}/keep-awake-off`, GLib.FileTest.EXISTS));
    switches[1].toggle();
    check('options: auto-switch off file', GLib.file_test(`${accounts}/auto-switch-off`, GLib.FileTest.EXISTS));
    switches[1].toggle();
    ext._options.close();
    await sleep(400);

    // An automatic switch (as claude-account usage records it) gets a notification.
    const tray = Main.messageTray;
    const before = tray.getSources().length;
    GLib.file_set_contents(`${accounts}/active`, '2\n');
    const hist = new TextDecoder().decode(GLib.file_get_contents(`${accounts}/history.jsonl`)[1]);
    GLib.file_set_contents(`${accounts}/history.jsonl`,
        `${hist}{"t":${Math.floor(Date.now() / 1000)},"switch":"2","auto":"1"}\n`);
    ext._notifyAutoSwitch('1');
    await sleep(400);
    const note = tray.getSources().flatMap(src => src.notifications).find(n => n.title?.startsWith('Switched'));
    check('auto-switch: notification', !!note, `${note?.title} / ${note?.body}`);
    ext._notifyAutoSwitch('2');
    check('auto-switch: none for a manual switch', tray.getSources().flatMap(src => src.notifications)
        .filter(n => n.title?.startsWith('Switched')).length === 1);
    GLib.file_set_contents(`${accounts}/active`, '1\n');
    await sleep(400);

    // History panel: hourly bars, and one row per 5-hour window despite the wobbling resets.
    const b1 = ext._buttons.find(b => b._slot === '1');
    ext._toggleHistory(b1);
    await sleep(700);
    const all = a => [a, ...a.get_children().flatMap(all)];
    const find = cls => all(b1._menu.box).filter(c => c.has_style_class_name?.(cls));
    const rowTexts = () => find('claude-acct-window').map(r => r.get_children().map(c => c.text).filter(Boolean).join(' '));
    let rows = find('claude-acct-window');
    check('history: three windows', rows.length === 3, rowTexts().join(' | '));
    check('history: current window says Now', rows[0].get_children()[0].text.startsWith('Now') && !rows[1].get_children()[0].text.startsWith('Now'));
    check('history: % by default', rows.every(r => /^\d+%$/.test(r.get_children().at(-1).text)));
    let chart = find('claude-acct-chart')[0], detail = find('claude-acct-chart-detail')[0];
    check('history: chart in %', !!chart && /% of the limit used in the last 24 hours$/.test(detail?.text), detail?.text);
    await shot('history', ext, false, b1._menu.actor);
    // Hover a bar: the line under the chart shows that hour.
    const [cx, cy] = chart.get_transformed_position();
    const ev = Clutter.get_default_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    ev.notify_absolute_motion(GLib.get_monotonic_time(), cx + chart.width * 0.9, cy + chart.height / 2);
    await sleep(400);
    check('history: hover shows an hour', /^\d\d:00–\d\d:00  ·  \d+% used$/.test(detail.text), detail.text);
    ev.notify_absolute_motion(GLib.get_monotonic_time(), 5, 600);
    await sleep(300);

    // Switch to tokens: everything below the header follows, and the choice is remembered.
    const tokBtn = find('claude-acct-unit-btn').find(btn => btn.label === 'Tokens');
    tokBtn.emit('clicked', 1);
    await sleep(600);
    check('tokens: menu still open', b1._menu.isOpen);
    check('tokens: remembered', new TextDecoder().decode(GLib.file_get_contents(`${accounts}/.panel-unit`)[1]).trim() === 'tokens');
    rows = find('claude-acct-window');
    check('tokens: per window', rows.length === 3 && rows.every(r => /^[\d.]+[kM]$/.test(r.get_children().at(-1).text)), rowTexts().join(' | '));
    check('tokens: switch shows it', find('claude-acct-unit-btn').find(btn => btn.label === 'Tokens').checked);
    detail = find('claude-acct-chart-detail')[0];
    check('tokens: chart', /^[\d.]+[kM] tokens in the last 24 hours$/.test(detail.text), detail.text);
    check('tokens: header', /tokens in this 5-hour window$/.test(find('claude-acct-history-now')[0].text), find('claude-acct-history-now')[0].text);
    await shot('history-tokens', ext, false, b1._menu.actor);
    b1._menu.close();
    await sleep(400);
    ext._toggleHistory(b1);
    await sleep(600);
    check('tokens: still tokens next time', find('claude-acct-unit-btn').find(btn => btn.label === 'Tokens').checked);
    find('claude-acct-unit-btn').find(btn => btn.label === '%').emit('clicked', 1);
    await sleep(500);
    check('tokens: back to %', /^\d+%$/.test(find('claude-acct-window')[0].get_children().at(-1).text));
    b1._menu.close();
    await sleep(400);

    // Tooltip: only the reset time.
    b1.hover = true;
    await sleep(300);
    check('tooltip: reset time only', /^Resets in [\d h]+min \(at \d\d:\d\d\)$/.test(ext._tooltip.text), ext._tooltip.text);
    b1.hover = false;

    // A window that has ended: 0%, and says so, before the next reading comes in.
    const cache = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${accounts}/usage.cache`)[1]));
    cache['2'] = {pct: 100, resets_at: GLib.DateTime.new_now_utc().add_minutes(-16).format_iso8601()};
    GLib.file_set_contents(`${accounts}/usage.cache`, JSON.stringify(cache));
    await sleep(600);
    const b2 = ext._buttons.find(b => b._slot === '2');
    check('ended window: 0%', b2._pct.text === '0%', b2._pct.text);
    check('ended window: says so', ext._resetText('2').startsWith('Limit reset at'), ext._resetText('2'));
    out('DONE');
}

export default class TestDriver extends Extension {
    enable() {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            run().catch(e => out(`ERROR ${e}\n${e.stack}`)).finally(() => {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => global.context.terminate());
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {}
}
