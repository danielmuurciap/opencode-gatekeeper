#!/usr/bin/env python3
"""Answer the only question that matters about delegation: does it save you
money, or burn it in retries?

Reads the gatekeeper JSONL log and prints success rate per model/variant,
cost concentration, retry hotspots, and which gate cuts most.

Usage:  analyze.py [--log PATH] [--days N]
"""
import argparse, collections, json, statistics, time
from pathlib import Path

DEF_LOG = Path.home() / ".local/share/gatekeeper/dispatches.jsonl"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", default=str(DEF_LOG))
    ap.add_argument("--days", type=int, default=0, help="0 = everything")
    a = ap.parse_args()

    rows = [json.loads(l) for l in Path(a.log).expanduser().read_text().splitlines() if l.strip()]
    if a.days:
        cutoff = time.time() - a.days * 86400
        rows = [r for r in rows if r.get("ts", 0) >= cutoff]
    # Rows without duration measured nothing (crashed collector, legacy rows):
    # count them, exclude them from rates so they can't fake a denominator.
    dead = [r for r in rows if not r.get("duration_s")]
    live = [r for r in rows if r.get("duration_s")]
    print(f"dispatches: {len(rows)}  (with data: {len(live)}, empty: {len(dead)})")
    if not live:
        return

    ok = [r for r in live if r.get("exit") == 0]
    cost = sum(r.get("cost_usd") or 0 for r in live)
    print(f"pass rate: {len(ok)}/{len(live)} = {100*len(ok)/len(live):.0f}%   "
          f"total cost: ${cost:.4f}   worker time: {sum(r['duration_s'] for r in live)/3600:.1f}h")

    print("\nby model/variant:")
    m = collections.defaultdict(lambda: [0, 0, 0.0, []])
    for r in live:
        k = f"{r.get('model')}·{r.get('variant') or '-'}"
        m[k][0] += 1
        m[k][1] += r.get("exit") == 0
        m[k][2] += r.get("cost_usd") or 0
        m[k][3].append(r["duration_s"])
    for k, v in sorted(m.items(), key=lambda x: -x[1][0]):
        print(f"  {k:44} n={v[0]:3} ok={100*v[1]/v[0]:3.0f}% ${v[2]:8.4f} median={statistics.median(v[3]):5.0f}s")

    print("\nretry hotspots (same name, 2+ dispatches):")
    t = collections.defaultdict(lambda: [0, 0, 0.0])
    for r in live:
        t[r["name"]][0] += 1
        t[r["name"]][1] += r.get("exit") == 0
        t[r["name"]][2] += r.get("cost_usd") or 0
    hot = [(k, v) for k, v in t.items() if v[0] >= 2]
    for k, v in sorted(hot, key=lambda x: -x[1][0])[:10]:
        print(f"  {k:36} attempts={v[0]:2} ok={v[1]} ${v[2]:.4f}")
    if not hot:
        print("  none")

    print("\nwhat cuts (failure reasons):")
    reasons = collections.Counter()
    for r in live:
        for f in (r.get("failure_reason") or "").split(","):
            if f:
                reasons[f.split(":")[0]] += 1
    for k, n in reasons.most_common():
        print(f"  {k:24} {n}")
    if not reasons:
        print("  nothing — every dispatch passed")

    gated = sum(1 for r in live if r.get("gate") and r["gate"] != "no_gate")
    print(f"\ndispatches with an acceptance gate: {gated}/{len(live)} "
          f"({100*gated/len(live):.0f}%) — briefs without one are unverified by definition")


if __name__ == "__main__":
    main()
