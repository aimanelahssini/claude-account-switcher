#!/usr/bin/env python3
"""Made-up usage history for the test shell: two accounts, readings every few minutes over the
last 26 hours, with the reset time wobbling by a second like the real API's. Also writes a
made-up tokens.cache next to it, with tokens that follow the usage."""
import json, random, sys, time
from datetime import datetime, timezone

random.seed(7)
now = int(time.time())
out = []
tokens = {}
# (account, window end in hours from now, peak %): three windows for "1", one for "2"
for acct, end_h, peak in [("1", -14.5, 64), ("1", -6.2, 100), ("1", 1.2, 53), ("2", -1.0, 11)]:
    end = now + int(end_h * 3600)
    start = end - 5 * 3600
    pct = 0.0
    t = start + 600
    while t < min(end, now):
        step = random.choice([0, 0, 1, 2, 3, 5]) * peak / 60
        pct = min(peak, pct + step)
        if step:
            b = str(t // 600 * 600)
            tokens.setdefault(acct, {}).setdefault(b, [0, 0])
            tokens[acct][b][0] += int(step * 41000)
            tokens[acct][b][1] += int(step * 900000)
        reset = datetime.fromtimestamp(end + random.uniform(-1, 1), timezone.utc).isoformat()
        if t >= now - 26 * 3600:
            out.append({"t": t, "a": acct, "pct": round(pct), "reset": reset})
        t += 300
    if acct == "1" and end_h == -6.2:
        out.append({"t": end - 3 * 3600, "a": acct, "pct": 100, "reset": reset})
out.sort(key=lambda e: e["t"])
with open(sys.argv[1], "w") as f:
    for e in out:
        f.write(json.dumps(e) + "\n")
with open(sys.argv[1].replace("history.jsonl", "tokens.cache"), "w") as f:
    json.dump({"step": 600, "accounts": tokens}, f)
