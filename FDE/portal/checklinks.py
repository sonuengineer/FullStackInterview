"""Checks every relative markdown link under FDE/ points at a file that exists.

Run: python portal/checklinks.py   (exit code 1 if any link is broken)
Skips http(s)/mailto links, pure #anchors, and anything inside ``` code blocks.
"""
import re
import sys
from pathlib import Path
from urllib.parse import unquote

FDE = Path(__file__).resolve().parent.parent


def main():
    bad = n = 0
    for f in FDE.rglob("*.md"):
        text = re.sub(r"```.*?```", "", f.read_text(encoding="utf-8"), flags=re.S)
        for m in re.finditer(r"\]\((<[^>]+>|[^)\s]+)\)", text):
            target = m.group(1).strip("<>")
            if target.startswith(("http", "#", "mailto")):
                continue
            n += 1
            if not (f.parent / unquote(target.split("#")[0])).exists():
                bad += 1
                print("BROKEN", f.relative_to(FDE), "->", target)
    print(f"{n} links, {bad} broken")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
