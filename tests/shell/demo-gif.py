#!/usr/bin/env python3
"""Turns TEST_ONLY=flashdemo's frames into a GIF, with the pointer drawn in (screenshots leave
it out) and a ring where it clicks. Also writes OUT-strip.png with the frames around the click.
  python3 demo-gif.py DEMO_DIR OUT.gif"""
import json
import sys

from PIL import Image, ImageDraw

demo, gif = sys.argv[1], sys.argv[2]
timeline = json.load(open(f'{demo}/timeline.json'))
click = next(e['click'] for e in timeline if 'click' in e)
frames = [e for e in timeline if 'file' in e]


def pointer(draw, x, y):
    shape = [(0, 0), (0, 17), (4.5, 13), (7.5, 20), (10, 19), (7, 12.5), (12.5, 12.5)]
    draw.polygon([(x + px, y + py) for px, py in shape], fill='white', outline='black')


images, durations = [], []
for i, e in enumerate(frames):
    im = Image.open(e['file']).convert('RGB')
    draw = ImageDraw.Draw(im)
    if click <= e['t'] <= click + 120:
        draw.ellipse((e['x'] - 9, e['y'] - 9, e['x'] + 9, e['y'] + 9), outline='white', width=2)
    pointer(draw, e['x'], e['y'])
    images.append(im.resize((im.width * 3 // 4, im.height * 3 // 4), Image.LANCZOS))
    following = frames[i + 1]['t'] if i + 1 < len(frames) else e['t'] + 1200
    durations.append(max(20, round(following - e['t'])))
images[0].save(gif, save_all=True, append_images=images[1:], duration=durations, loop=0, optimize=True)

around = [f for f in frames if click - 100 <= f['t'] <= click + 1000][:9]
w, h = images[0].size
strip = Image.new('RGB', (w * 3 // 2, h // 2 * ((len(around) + 2) // 3)), (30, 30, 30))
for k, f in enumerate(around):
    strip.paste(Image.open(f['file']).convert('RGB').resize((w // 2, h // 2)), ((k % 3) * (w // 2), (k // 3) * (h // 2)))
strip.save(gif.rsplit('.', 1)[0] + '-strip.png')
print(gif, len(frames), 'frames; around the click (ms):', [round(f['t'] - click) for f in around])
