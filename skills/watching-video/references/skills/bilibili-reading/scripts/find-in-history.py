#!/usr/bin/env python3
"""Search the logged-in Bilibili account's watch history for keyword matches.

Wraps the `bili` CLI (bilibili-cli): pages the history, aggregates every item into one
list, and prints the matches as rows, so the agent never eyeballs a long listing.

Examples:
    python3 find-in-history.py deepseek harness
    python3 find-in-history.py DSH 插件 --pages 12
    python3 find-in-history.py 番剧 jojo --all
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys


def fetch_page(page: int, per_page: int) -> list[dict]:
    """Return one history page as a list of items (empty list on failure)."""
    proc = subprocess.run(
        ["bili", "history", "-p", str(page), "-n", str(per_page), "--json"],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        print(f"page {page}: bili exited {proc.returncode}: {proc.stderr.strip()[:200]}", file=sys.stderr)
        return []
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        print(f"page {page}: non-JSON output (is the account authenticated?)", file=sys.stderr)
        return []
    data = payload.get("data") or {}
    return data.get("items") or []


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Search Bilibili watch history (观看历史) for keyword matches.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("keywords", nargs="+", help="keywords matched against title + author")
    parser.add_argument("--pages", type=int, default=8, help="history pages to fetch (100 items per page)")
    parser.add_argument("--per-page", type=int, default=100, help="items per page (CLI maximum is 100)")
    parser.add_argument("--all", action="store_true", help="require every keyword to match (default: any keyword)")
    args = parser.parse_args()

    if shutil.which("bili") is None:
        print("bili not on PATH; install with: uv tool install bilibili-cli", file=sys.stderr)
        print("then export PATH=\"$HOME/.local/bin:$PATH\"", file=sys.stderr)
        return 2

    items: list[dict] = []
    for page in range(1, args.pages + 1):
        got = fetch_page(page, args.per_page)
        if not got:
            break
        items.extend(got)

    if not items:
        print("no history items returned; check `bili status` (authenticated, exit 0)", file=sys.stderr)
        return 1

    print(f"scanned {len(items)} items | range {items[-1].get('viewed_at', '?')} .. {items[0].get('viewed_at', '?')}")

    def matches(item: dict) -> bool:
        blob = f"{item.get('title', '')} {item.get('author', '')}"
        found = [kw for kw in args.keywords if re.search(re.escape(kw), blob, re.IGNORECASE)]
        return len(found) == len(args.keywords) if args.all else bool(found)

    hits = [item for item in items if matches(item)]
    print(f"{len(hits)} match(es) for {args.keywords}")
    for hit in hits:
        print(
            f"{hit.get('viewed_at', '?')} | {hit.get('bvid', '?')} | "
            f"{hit.get('title', '')[:70]} | {(hit.get('author') or '')[:20]}"
        )
    print("confirm the candidate with: bili video <BV> --yaml  (read `description`)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
