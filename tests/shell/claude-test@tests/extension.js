// Test driver for the top-bar extension in a throwaway headless shell (tests/shell/run.sh).
// Marks a made-up Claude session as working the way claude-busy does, checks the mascot turns
// orange with Claude Code's spinner next to it, and saves screenshots of the top bar to $TEST_OUT.
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
async function shot(name, ext, withTooltip = false) {
    let [x, y] = ext._indicator.get_transformed_position();
    let [w, h] = ext._indicator.get_transformed_size();
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
    await shot('idle', ext);

    GLib.file_set_contents(`${BUSY}/0a1b2c3d-test`, '1\n');
    await sleep(600);
    check('busy: tag marked', ext._busy === true && tag.has_style_class_name('busy'));
    check('busy: orange mascot', color(mascot) === '#d77757ff', `${idle} -> ${color(mascot)}`);
    check('busy: spinner shown', ext._spinner.visible && !!ext._spinTimer);
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
    check('done: grey again', ext._busy === false && color(mascot) === idle && !ext._spinner.visible, color(mascot));
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
