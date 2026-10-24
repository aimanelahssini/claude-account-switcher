// Test driver for the top-bar extension in a throwaway headless shell (tests/shell/run.sh).
// Marks a made-up Claude session as working the way claude-busy does, checks the mascot turns
// orange with Claude Code's spinner next to it, and saves screenshots of the top bar to $TEST_OUT.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
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

    const accounts0 = `${GLib.get_home_dir()}/.claude/accounts`;
    // On long work the word changes now and then (every 3 minutes; 1 second here), never to
    // the same word.
    GLib.unlink(`${BUSY}/0a1b2c3d-test`);
    await sleep(400);
    const settings = `${GLib.get_home_dir()}/.claude/settings.json`;
    const savedSettings = new TextDecoder().decode(GLib.file_get_contents(settings)[1]);
    GLib.file_set_contents(settings, JSON.stringify({spinnerVerbs: {mode: 'replace', verbs: ['Choreographing', 'Composing']}}));
    ext._wordSeconds = 1;
    GLib.file_set_contents(`${BUSY}/0a1b2c3d-test`, '1\n');
    await sleep(300);
    const words = [ext._verb.text];
    for (let i = 0; i < 60; i++) {
        const before = ext._verb.text;
        await sleep(120);
        if (ext._verb.text !== before)
            words.push(ext._verb.text);
    }
    check('word: changes on long work', words.length >= 3 && words.every((w, i) => i === 0 || w !== words[i - 1]), words.join(' > '));
    delete ext._wordSeconds;
    GLib.file_set_contents(settings, savedSettings);

    // Words come from a shuffled deck: every word once before any comes back.
    const deckWords = Array.from({length: 187}, (_, i) => `Word${i}`);
    const first = Array.from({length: 187}, () => ext._nextVerb(deckWords));
    const second = Array.from({length: 187}, () => ext._nextVerb(deckWords));
    check('deck: all 187 before a repeat', new Set(first).size === 187 && new Set(second).size === 187);
    check('deck: shuffled', first.join() !== deckWords.join() && first.join() !== second.join());
    check('deck: no repeat across shuffles', first.at(-1) !== second[0]);
    ext._nextVerb(deckWords);
    const saved = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${accounts0}/.spinner-deck`)[1]));
    check('deck: kept across restarts', saved.left.length === 186);
    check('deck: follows the word list', ext._nextVerb(['Only']) === 'Only');

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
    check('options: menu open', ext._options.isOpen && switches.length === 4,
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
    check('tokens: busiest hour under the chart', /^Busiest hour \d\d:00–\d\d:00  ·  [\d.]+[kM] tokens$/.test(detail.text), detail.text);
    check('tokens: header is the last 24 hours', /^[\d.]+[kM] tokens in the last 24 hours$/.test(find('claude-acct-history-now')[0].text), find('claude-acct-history-now')[0].text);
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

// TEST_ONLY=flashdemo: not a test, a recording for the README: hover the mascot, hover a chat's
// bar, click it; its window comes forward and the orange frame closes in on it. Frames and a
// timeline (with where the pointer is) go to $TEST_OUT/demo/.
async function flashDemo() {
    let ext;
    for (let i = 0; i < 40 && !ext?._tabsRow; i++) {
        await sleep(500);
        ext = Main.extensionManager.lookup(UUID)?.stateObj;
    }
    Main.overview.hide();
    const home = GLib.get_home_dir();
    const busy = `${GLib.get_user_runtime_dir()}/claude-busy`;
    const write = (path, text) => GLib.file_set_contents(path, text);
    const spawn = (...argv) => GLib.spawn_async(null, argv, null, GLib.SpawnFlags.SEARCH_PATH, null)[1];
    const windowTitled = t => global.get_window_actors().map(a => a.meta_window).find(w => w.get_title() === t);
    GLib.mkdir_with_parents(`${home}/.claude/sessions`, 0o700);
    GLib.mkdir_with_parents(`${home}/.claude/projects/-home-u-p`, 0o700);
    const titles = {a: 'Fix the poster upload', b: 'Weekly report', c: 'Tidy the photos'};
    for (const [k, title] of Object.entries(titles)) {
        const pid = spawn('sleep', '300');
        write(`${home}/.claude/sessions/${pid}.json`, JSON.stringify({pid, sessionId: `s-${k}`, cwd: '/home/u/p'}));
        write(`${home}/.claude/projects/-home-u-p/s-${k}.jsonl`, `${JSON.stringify({type: 'summary', aiTitle: title})}\n`);
    }
    write(`${busy}/s-b`, '\n');
    const stub = `${home}/tabs-stub`;
    write(stub, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify([
        {window: '✳ Fix the poster upload — claude', tabs: ['✳ Fix the poster upload — claude']},
        {window: '✳ Weekly report — claude', tabs: ['✳ Weekly report — claude', '✳ Tidy the photos — claude']},
    ])}\nEOF\n`);
    GLib.chmod(stub, 0o755);
    for (const t of ['✳ Fix the poster upload — claude', '✳ Weekly report — claude']) {
        spawn('python3', GLib.getenv('TEST_WINDOW'), t);
        for (let i = 0; i < 40 && !windowTitled(t); i++) await sleep(250);
    }
    await sleep(800);
    windowTitled('✳ Fix the poster upload — claude').move_resize_frame(true, 760, 150, 520, 330);
    windowTitled('✳ Weekly report — claude').move_resize_frame(true, 880, 230, 520, 330);
    Main.activateWindow(windowTitled('✳ Weekly report — claude'));
    ext._refreshTabs(null);
    await sleep(1500);

    const dir = `${OUT}/demo`;
    GLib.mkdir_with_parents(dir, 0o755);
    const area = [640, 0, 800, 520];
    const pointer = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    let at = [1100, 700];
    const move = async (x, y, ms) => {
        const [x0, y0] = at;
        const steps = Math.max(1, Math.round(ms / 16));
        for (let i = 1; i <= steps; i++) {
            const k = i / steps, e = k * k * (3 - 2 * k);
            at = [x0 + (x - x0) * e, y0 + (y - y0) * e];
            pointer.notify_absolute_motion(GLib.get_monotonic_time(), ...at);
            await sleep(16);
        }
    };
    const timeline = [];
    const t0 = GLib.get_monotonic_time();
    let recording = true;
    const recorder = (async () => {
        let n = 0;
        while (recording) {
            const t = (GLib.get_monotonic_time() - t0) / 1000;
            const name = `${dir}/frame-${String(n).padStart(4, '0')}.png`;
            const stream = Gio.File.new_for_path(name).replace(null, false, Gio.FileCreateFlags.NONE, null);
            await new Shell.Screenshot().screenshot_area(...area, stream);
            stream.close(null);
            timeline.push({t, file: name, x: at[0] - area[0], y: at[1] - area[1]});
            n++;
        }
    })();
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), ...at);
    await sleep(500);
    const [mx, my] = ext._tag.get_transformed_position();
    await move(mx + ext._tag.width / 2, my + ext._tag.height / 2, 600);
    await sleep(900);
    const bar = ext._tabsRow.get_children()[0];
    const [bx, by] = bar.get_transformed_position();
    await move(bx + bar.width / 2, by + bar.height / 2, 450);
    await sleep(800);
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    await sleep(60);
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    timeline.push({click: (GLib.get_monotonic_time() - t0) / 1000});
    await sleep(1500);
    recording = false;
    await recorder;
    write(`${dir}/timeline.json`, JSON.stringify(timeline));
    check('demo: recorded', timeline.length > 40, `${timeline.length} frames`);
    check('demo: the click led to the chat', global.display.focus_window?.get_title() === '✳ Fix the poster upload — claude');
    out('DONE');
}

// TEST_ONLY=edge: the top bar's buttons answer to the pointer over the bar's full height (the
// very top pixel row included), while drawn the same as before.
async function edgeTest() {
    let ext;
    for (let i = 0; i < 40 && !ext?._buttons?.length; i++) {
        await sleep(500);
        ext = Main.extensionManager.lookup(UUID)?.stateObj;
    }
    Main.overview.hide();
    await sleep(1000);
    const [, panelY] = Main.panel.get_transformed_position();
    const panelBottom = panelY + Main.panel.height - 1;
    const items = [['mascot', ext._tag], ...ext._buttons.map(b => [`account ${b._slot}`, b]), ['+', ext._addBtn]];
    for (const [name, b] of items) {
        const [x, y] = b.get_transformed_position();
        const cx = Math.round(x + b.width / 2);
        const top = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, cx, panelY);
        const bottom = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, cx, panelBottom);
        out(`# ${name}: drawn ${b.width}x${b.height} at y ${y}, bar ${panelY}..${panelBottom}`);
        check(`edge: ${name} at the very top`, top === b || b.contains(top), top?.toString());
        check(`edge: ${name} at the bottom of the bar`, bottom === b || b.contains(bottom), bottom?.toString());
    }
    // Hovering there works like hovering the button.
    const pointer = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const b = ext._buttons[0];
    const [bx] = b.get_transformed_position();
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), bx + b.width / 2, panelY);
    await sleep(700);
    check('edge: hover at the top edge shows its hover text', b.hover && ext._tip.visible, ext._tooltip.text);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), 5, 500);
    await sleep(500);
    out('DONE');
}

// TEST_ONLY=tabs: the row of chats under the mascot's hover text, in tab order. Two desktops:
// on the first a window on the left with two tabs and one on the right with one tab; on the
// second a window with one tab. claude-tabs is a stand-in here (no accessibility bus).
async function tabsTest() {
    let ext;
    for (let i = 0; i < 40 && !ext?._tabsRow; i++) {
        await sleep(500);
        ext = Main.extensionManager.lookup(UUID)?.stateObj;
    }
    Main.overview.hide();
    const home = GLib.get_home_dir();
    const busy = `${GLib.get_user_runtime_dir()}/claude-busy`;
    const write = (path, text) => GLib.file_set_contents(path, text);
    const spawn = (...argv) => GLib.spawn_async(null, argv, null, GLib.SpawnFlags.SEARCH_PATH, null)[1];
    const windowTitled = t => global.get_window_actors().map(a => a.meta_window).find(w => w.get_title() === t);
    // Four chats (live processes standing in for claude), their titles in their transcripts.
    const names = {a: 'Alpha', b: 'Bravo', c: 'Charlie', d: 'Delta'};
    GLib.mkdir_with_parents(`${home}/.claude/sessions`, 0o700);
    GLib.mkdir_with_parents(`${home}/.claude/projects/-home-u-p`, 0o700);
    for (const [k, title] of Object.entries(names)) {
        const pid = spawn('sleep', '300');
        write(`${home}/.claude/sessions/${pid}.json`, JSON.stringify({pid, sessionId: `s-${k}`, cwd: '/home/u/p'}));
        write(`${home}/.claude/projects/-home-u-p/s-${k}.jsonl`, `${JSON.stringify({type: 'summary', aiTitle: title})}\n`);
    }
    // Bravo works, Charlie waits for you, Alpha and Delta are idle.
    write(`${busy}/s-b`, '\n');
    write(`${busy}/needs/s-c`, `\n${Math.floor(Date.now() / 1000)}\npermission\n/home/u/p\n${home}/.claude/projects/-home-u-p/s-c.jsonl\n`);
    // Windows show their active tab's title; the stand-in lists them in a scrambled order.
    for (const t of ['✳ Bravo — claude', '✳ Charlie — claude', '✳ Delta — claude']) {
        spawn('python3', GLib.getenv('TEST_WINDOW'), t);
        for (let i = 0; i < 40 && !windowTitled(t); i++) await sleep(250);
    }
    await sleep(800);
    global.workspace_manager.append_new_workspace(false, global.get_current_time());
    windowTitled('✳ Bravo — claude').move_frame(true, 40, 100);
    windowTitled('✳ Charlie — claude').move_frame(true, 800, 100);
    windowTitled('✳ Delta — claude').change_workspace_by_index(1, false);
    windowTitled('✳ Delta — claude').move_frame(true, 10, 100);
    await sleep(500);
    const stub = `${home}/tabs-stub`;
    write(stub, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify([
        {window: '✳ Delta — claude', tabs: ['✳ Delta — claude']},
        {window: '✳ Charlie — claude', tabs: ['✳ Charlie — claude']},
        {window: '✳ Bravo — claude', tabs: ['✳ Alpha — claude', '✳ Bravo — claude']},
    ])}\nEOF\n`);
    GLib.chmod(stub, 0o755);
    await sleep(600);

    ext._tag.hover = true;
    await sleep(900);
    const rects = ext._tabsRow.get_children();
    check('tabs: a rectangle per chat, under the text', ext._tabsRow.visible && rects.length === 4, `${rects.length}`);
    check('tabs: in tab order (desktop, left to right, tabs)', ext._tabsCache.map(c => c.id).join() === 's-a,s-b,s-c,s-d',
        ext._tabsCache.map(c => c.id).join());
    check('tabs: grey idle, orange working, white waiting for you',
        rects.map(r => ['idle', 'working', 'needs'].find(k => r.has_style_class_name(k))).join() === 'idle,working,needs,idle',
        rects.map(r => r.get_style_class_name()).join(' | '));
    check('tabs: only the orange one breathes', rects.map(r => !!r.get_transition('opacity')).join() === 'false,true,false,false',
        rects.map(r => !!r.get_transition('opacity')).join());
    check('tabs: a hand over the bars', rects.every(r => r.get_cursor_type?.() === Clutter.CursorType.POINTER));
    check('tabs: no names or numbers', rects.every(r => r.get_n_children() === 0));
    check('tabs: hover text above', /Claude needs you in “Charlie”/.test(ext._tooltip.text), ext._tooltip.text);
    // For the docs: the box with the white one blinking state left as it is.
    const [tx, ty] = ext._tip.get_transformed_position();
    const [tw, th] = ext._tip.get_transformed_size();
    const stream = Gio.File.new_for_path(`${OUT}/tabs.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
    const [ix] = ext._indicator.get_transformed_position();
    await new Shell.Screenshot().screenshot_area(Math.min(ix, tx) - 12, 0, Math.max(ix + ext._indicator.width, tx + tw) - Math.min(ix, tx) + 24, ty + th + 12, stream);
    stream.close(null);
    check('tabs: rounded rectangles you can click', rects.every(r => r instanceof St.Button && r.reactive));
    // Hovering bar after bar: the box and the bars stay put (names of different lengths used to
    // resize the box and slide the bars under the pointer).
    const layout = () => JSON.stringify([ext._tip.x, ext._tip.width, ...rects.map(r => r.get_transformed_position()[0])]);
    const still = layout();
    let moved = '';
    for (const r of [...rects, ...rects.slice().reverse()]) {
        r.hover = true;
        await sleep(120);
        if (layout() !== still)
            moved ||= `${ext._tooltip.text}: ${layout()} vs ${still}`;
        r.hover = false;
    }
    check('tabs: hovering bars doesn\'t move them', !moved, moved);
    const [tipX] = ext._tip.get_transformed_position();
    const mon = Main.layoutManager.primaryMonitor;
    check('tabs: the box stays on the screen', tipX >= mon.x && tipX + ext._tip.width <= mon.x + mon.width);
    // Moving from the mascot onto the box keeps it open.
    ext._tag.hover = false;
    ext._tip.hover = true;
    await sleep(600);
    check('tabs: the box stays while the pointer is on it', ext._tip.visible);
    rects[2].hover = true;
    await sleep(100);
    check('tabs: hovering a bar names its chat', ext._tooltip.text === 'Charlie · needs you', ext._tooltip.text);
    rects[2].hover = false;
    // Click the first: its window comes forward and the terminal's own shortcut picks its tab.
    const focused = () => global.display.focus_window?.get_title() ?? '';
    Main.activateWindow(windowTitled('✳ Charlie — claude'));
    await sleep(400);
    rects[0].emit('clicked', 1);
    await sleep(450);
    check('tabs: click goes to that chat\'s window', focused() === '✳ Bravo — claude', focused());
    const accel = new Gio.Settings({schema_id: 'org.gnome.Ptyxis.Shortcuts'}).get_string('focus-tab-1');
    check('tabs: and to its tab, with the terminal\'s shortcut', !!ext._pressed?.length, `${accel} -> ${ext._pressed}`);
    check('tabs: an orange frame shows around it', !!ext._flashActor && ext._flashActor.opacity > 0 &&
        Math.abs(ext._flashActor.x - (windowTitled('✳ Bravo — claude').get_frame_rect().x - 8)) <= 1);
    check('tabs: the box closes', !ext._tip.visible);
    await shot('flash', ext);
    const fs = Gio.File.new_for_path(`${OUT}/flash-window.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
    const fr = windowTitled('✳ Bravo — claude').get_frame_rect();
    await new Shell.Screenshot().screenshot_area(Math.max(0, fr.x - 20), Math.max(0, fr.y - 20), fr.width + 40, fr.height + 40, fs);
    fs.close(null);
    await sleep(1800);
    check('tabs: then fades away', !ext._flashActor);
    // A chat on the other desktop: it goes there.
    ext._tag.hover = true;
    await sleep(500);
    ext._tabsRow.get_children()[3].emit('clicked', 1);
    await sleep(700);
    check('tabs: a chat on another desktop: that desktop', focused() === '✳ Delta — claude' &&
        global.workspace_manager.get_active_workspace_index() === 1, focused());
    ext._tag.hover = false;
    await sleep(500);
    check('tabs: animation stops with the box', rects.every(r => !r.get_transition('opacity')) && !ext._tabsRow.visible);
    // A chat that starts while the box is closed: the tab layout is looked at again in the
    // background, so the box opens with it right away (no bar popping in).
    const pid5 = spawn('sleep', '300');
    write(stub, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify([
        {window: '✳ Delta — claude', tabs: ['✳ Delta — claude', '✳ Echo — claude']},
        {window: '✳ Charlie — claude', tabs: ['✳ Charlie — claude']},
        {window: '✳ Bravo — claude', tabs: ['✳ Alpha — claude', '✳ Bravo — claude']},
    ])}\nEOF\n`);
    write(`${home}/.claude/projects/-home-u-p/s-e.jsonl`, `${JSON.stringify({type: 'summary', aiTitle: 'Echo'})}\n`);
    write(`${home}/.claude/sessions/${pid5}.json`, JSON.stringify({pid: pid5, sessionId: 's-e', cwd: '/home/u/p'}));
    await sleep(2500);
    check('tabs: a new chat is picked up in the background', JSON.stringify(ext._tabsWindows ?? []).includes('Echo'));
    ext._tag.hover = true;
    check('tabs: the box fades in', !!ext._tip.get_transition('opacity'));
    await sleep(50);
    check('tabs: opens with every chat at once, in place', ext._tabsCache.map(c => c.id).join() === 's-a,s-b,s-c,s-d,s-e',
        ext._tabsCache.map(c => c.id).join());
    ext._tag.hover = false;
    await sleep(500);

    // Not under an account's hover text.
    ext._buttons[0].hover = true;
    await sleep(400);
    check('tabs: only under the mascot', !ext._tabsRow.visible);
    ext._buttons[0].hover = false;
    out('DONE');
}

// TEST_ONLY=needs: a chat waiting for you, its permission prompt as a notification, the lights.
async function needsTest() {
    let ext;
    for (let i = 0; i < 40 && !ext?._needsBox; i++) {
        await sleep(500);
        ext = Main.extensionManager.lookup(UUID)?.stateObj;
    }
    Main.overview.hide();
    const home = GLib.get_home_dir();
    const busy = `${GLib.get_user_runtime_dir()}/claude-busy`;
    const leds = GLib.getenv('CLAUDE_BUSY_LEDS');
    const write = (path, text) => GLib.file_set_contents(path, text);
    const read = path => { try { return new TextDecoder().decode(GLib.file_get_contents(path)[1]); } catch { return ''; } };
    const spawn = (...argv) => GLib.spawn_async(null, argv, null, GLib.SpawnFlags.SEARCH_PATH, null)[1];
    const focused = () => global.display.focus_window?.get_title() ?? '';
    const windowTitled = t => global.get_window_actors().map(a => a.meta_window).find(w => w.get_title() === t);
    // Two windows: the chat's terminal (titled like Claude Code titles it) and another one.
    spawn('python3', GLib.getenv('TEST_WINDOW'), '✳ Fix the poster upload');
    for (let i = 0; i < 40 && !windowTitled('✳ Fix the poster upload'); i++) await sleep(250);
    spawn('python3', GLib.getenv('TEST_WINDOW'), 'Something else');
    for (let i = 0; i < 40 && !windowTitled('Something else'); i++) await sleep(250);
    await sleep(800);
    Main.activateWindow(windowTitled('Something else'));
    await sleep(500);
    check('needs: test windows open', !!windowTitled('✳ Fix the poster upload') && focused() === 'Something else', focused());

    // A chat working, then waiting for you (claude-busy's files; the lights as claude-busy set them).
    write(`${busy}/s1`, '\n');
    write(`${busy}/.light-power`, 'needs\n');
    write(`${busy}/.light-lid_logo_dot`, 'steady\n');
    GLib.unlink(`${busy}/s1`);
    write(`${busy}/needs/s1`, `\n${Math.floor(Date.now() / 1000)}\npermission\n/home/u/Projects/listr\n${home}/chat.jsonl\n`);
    write(`${busy}/s2`, '\n');   // another chat keeps working meanwhile
    await sleep(700);
    check('needs: white dot and the chat name in the top bar', ext._needsBox.visible && ext._needsName.text.startsWith('Fix the poster'),
        ext._needsName.text);
    check('needs: comes before another chat working', !ext._spinner.visible && !ext._mascot.visible);
    const opacities = new Set();
    for (let i = 0; i < 25; i++) {
        opacities.add(ext._needsDot.opacity);
        await sleep(100);
    }
    check('needs: the dot blinks', opacities.has(255) && opacities.has(90), [...opacities].join());
    check('needs: the power light is put in step', read(`${leds}/tpacpi::power/pattern`).startsWith('255 150 255 0'),
        read(`${leds}/tpacpi::power/pattern`));
    check('needs: the lid dot left alone (lid open)', read(`${leds}/tpacpi::lid_logo_dot/pattern`) === '');
    ext._tag.hover = true;
    await sleep(300);
    check('needs: hover says where', ext._tooltip.text === 'Claude needs you in “Fix the poster upload”. Click to open it', ext._tooltip.text);
    ext._tag.hover = false;
    await shot('needs', ext);
    ext._tag.emit('clicked', 1);
    await sleep(800);
    check('needs: click opens that chat', focused() === '✳ Fix the poster upload', focused());

    // Its permission prompt as a notification, while you're elsewhere.
    Main.activateWindow(windowTitled('Something else'));
    await sleep(500);
    GLib.spawn_command_line_sync(`mkfifo ${busy}/ask/s1.fifo`);
    write(`${busy}/ask/s1.pid`, '1\n');
    spawn('sh', '-c', `cat ${busy}/ask/s1.fifo > ${busy}/answer.txt`);
    const request = {session_id: 's1', cwd: '/home/u/Projects/listr', transcript_path: `${home}/chat.jsonl`,
        hook_event_name: 'PermissionRequest', tool_name: 'Bash',
        tool_input: {command: 'rm -f pezei.py', description: 'Delete pezei.py'},
        permission_suggestions: [{type: 'addRules', rules: [{toolName: 'Bash', ruleContent: 'rm -f pezei.py'}],
            behavior: 'allow', destination: 'localSettings'}, {type: 'setMode', mode: 'acceptEdits', destination: 'session'}]};
    write(`${busy}/ask/s1.json`, JSON.stringify(request));
    await sleep(800);
    const n = ext._asks.get('s1');
    check('notify: shown', !!n);
    check('notify: project as title', n?.title === 'listr', n?.title);
    check('notify: the request in plain words', n?.body === 'Delete pezei.py? — $ rm -f pezei.py', JSON.stringify(n?.body));
    check('notify: opens expanded, buttons showing', Main.messageTray._banner?.expanded === true);
    check('notify: Yes, Always, No', n?.actions.map(a => a.label).join() === 'Yes,Always,No', n?.actions.map(a => a.label).join());
    const shotStream = Gio.File.new_for_path(`${OUT}/notification.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot_area(global.stage.width / 2 - 260, 0, 520, 200, shotStream);
    shotStream.close(null);
    n.actions.find(a => a.label === 'Always').activate();
    await sleep(1200);
    const answer = read(`${busy}/answer.txt`);
    check('notify: Always answers Claude Code, with the suggested rule',
        /"behavior":"allow"/.test(answer) && /"ruleContent":"rm -f pezei.py"/.test(answer) && !/setMode/.test(answer), answer.trim());
    // claude-busy then removes the prompt's files.
    for (const f of ['s1.json', 's1.fifo', 's1.pid'])
        GLib.unlink(`${busy}/ask/${f}`);
    await sleep(600);
    check('notify: gone once answered', !ext._asks.has('s1'));

    // Answered in the terminal instead: the notification goes away by itself.
    write(`${busy}/ask/s2.json`, JSON.stringify({...request, session_id: 's2', tool_input: {command: 'ls'}}));
    await sleep(600);
    const n2 = ext._asks.get('s2');
    GLib.unlink(`${busy}/ask/s2.json`);
    await sleep(600);
    check('notify: withdrawn when answered elsewhere', !!n2 && !ext._asks.has('s2'));
    // No notification for the chat you're looking at: its prompt is right there.
    Main.activateWindow(windowTitled('✳ Fix the poster upload'));
    await sleep(500);
    write(`${busy}/ask/s1.json`, JSON.stringify(request));
    await sleep(600);
    check('notify: not for the chat in front of you', !ext._asks.has('s1'),
        `focused "${focused()}", chat window "${ext._chatWindow({id: 's1', transcript: `${home}/chat.jsonl`, cwd: '/home/u/Projects/listr'})?.get_title()}"`);

    // Answered: back to the spinner (the other chat still works).
    GLib.unlink(`${busy}/needs/s1`);
    await sleep(600);
    check('needs: answered, the spinner again', !ext._needsBox.visible && ext._spinner.visible);

    // The menu's new switches.
    ext._tag.emit('clicked', 3);
    await sleep(700);
    const items = ext._options._getMenuItems().filter(i => i._switch);
    check('menu: notifications and lights switches', items.map(i => i.label.text).join(' | ').includes('Permission prompts as notifications | Blink the ThinkPad lights'),
        items.map(i => i.label.text).join(' | '));
    check('menu: on by default', items.every(i => i.state));
    await shot('options', ext, false, ext._options.actor);
    ext._options.close();
    out('DONE');
}

// TEST_ONLY=tokens-panel: just the history panel in tokens.
async function tokensPanel() {
    let ext;
    for (let i = 0; i < 40 && !ext?._buttons?.length; i++) {
        await sleep(500);
        ext = Main.extensionManager.lookup(UUID)?.stateObj;
    }
    Main.overview.hide();
    await sleep(1000);
    const accounts = `${GLib.get_home_dir()}/.claude/accounts`;
    GLib.file_set_contents(`${accounts}/.panel-unit`, 'tokens\n');
    const b1 = ext._buttons.find(b => b._slot === '1');
    ext._toggleHistory(b1);
    await sleep(800);
    const all = a => [a, ...a.get_children().flatMap(all)];
    const find = cls => all(b1._menu.box).filter(c => c.has_style_class_name?.(cls));
    const header = find('claude-acct-history-now')[0].text, detail = find('claude-acct-chart-detail')[0].text;
    check('tokens: header is the last 24 hours', /^[\d.]+[kM] tokens in the last 24 hours$/.test(header), header);
    check('tokens: busiest hour under the chart', /^Busiest hour \d\d:00–\d\d:00  ·  [\d.]+[kM] tokens$/.test(detail), detail);
    check('tokens: Now row keeps the 5-hour window', /^Now .* [\d.]+[kM]$/.test(find('claude-acct-window')[0].get_children().map(c => c.text).filter(Boolean).join(' ')));
    await shot('history-tokens', ext, false, b1._menu.actor);
    out('DONE');
}

export default class TestDriver extends Extension {
    enable() {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            ({'tokens-panel': tokensPanel, needs: needsTest, tabs: tabsTest, edge: edgeTest, flashdemo: flashDemo}[GLib.getenv('TEST_ONLY')] ?? run)().catch(e => out(`ERROR ${e}\n${e.stack}`)).finally(() => {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => global.context.terminate());
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {}
}
