"""Builds portal/plan.json -- the ordered queue for both tracks.

Sources (edit these, then re-run `python portal/plan.py` or restart the portal):
  curriculum.md   -> module + topic titles
  MASTER_PLAN.md  -> section 3 tier table (Core / Extended per module)
  RESOURCES.md    -> the 1 reading per module + links
  this file       -> checkpoint order for each track (mirrors MASTER_PLAN sections 4 and 5)

Topic ids are shared by both tracks (e.g. M06-13), so switching track keeps every tick.
"""
import datetime as dt
import json
import re
from pathlib import Path

FDE = Path(__file__).resolve().parent.parent
OUT = Path(__file__).resolve().parent / "plan.json"

TOPIC_HOURS = 1.2  # read 15-20 min + build ~50 min (MASTER_PLAN section 2)
STUB_BYTES = 300   # topic files at or below this size are still empty stubs

SETUP = [
    ("SET-1", "Create GitHub repos: fde-exercises (monorepo), omniguard, auditmesh -- each with a README", 0.5),
    ("SET-2", "Python 3.12+ env (uv or venv), pytest, ruff; one 'hello' test passing in fde-exercises", 0.5),
    ("SET-3", "LLM API keys in a .env that is gitignored (check `git status` never shows it)", 0.25),
]

BUILDS = {
    "B-EX": ("fde-exercises monorepo + one async worker exercise (asyncio + ThreadPoolExecutor)", 3),
    "B-OG-API": ("OmniGuard: FastAPI skeleton, Pydantic models, DI, pytest + coverage", 4),
    "B-OG-LLM": ("OmniGuard: LLM endpoint with strict JSON output, 2 tools, retry on parse errors", 4),
    "B-OG-RAG": ("OmniGuard: Hybrid RAG v1 (BM25 + dense + RRF + reranker) over messy PDFs, with evals", 6),
    "B-OG-MM": ("OmniGuard: multimodal ingestion (tables, charts, scanned pages)", 4),
    "B-GRAPH": ("Graph retrieval experiment: same questions, graph vs vector, write up the difference", 3),
    "B-OG-DEPLOY": ("OmniGuard: Dockerfile + GitHub Actions + deploy to AWS with health checks", 4),
    "B-OG-SQL": ("OmniGuard: secure Text-to-SQL (read-only role, parameterized) + OAuth2 + RBAC + data-level permissions", 6),
    "B-OG-V1": ("OmniGuard v1.0: Presidio + NeMo guardrails wired in, consulting docs in /docs", 4),
    "B-AM-CORE": ("AuditMesh: LangGraph supervisor, Jira MCP server, HITL approval with checkpointing", 6),
    "B-AM-V1": ("AuditMesh v1.0: traces, token-cost dashboard, approval UI, SLAs, handoff doc", 5),
}

# badge: which badge/achievement a gate unlocks
GATES = {
    "G-EX": ("Gate: fde-exercises repo with the async exercise running (link the repo)", None),
    "G-OG-API": ("Gate: OmniGuard tests passing + coverage report (link CI run or report)", None),
    "G-OG-LLM": ("Gate: 50 LLM calls with zero invalid JSON (link the test / log)", None),
    "G-OG-RAG": ("Gate: eval report in README -- faithfulness, context precision/recall (link README)", None),
    "G-MMG": ("Gate: multimodal ingestion + graph experiment write-up (link)", None),
    "G-DEPLOY": ("Gate: OmniGuard LIVE URL + health check + CI badge (link the live URL)", "deploy"),
    "G-RBAC": ("Gate: two-user demo -- same question, different allowed answers (link video)", None),
    "G-OG-V1": ("Gate: OmniGuard v1.0 tag + 5-min demo video + SOW/ROI/UAT docs (link release)", "omniguard"),
    "G-AM-HITL": ("Gate: agent run that pauses for human approval and resumes (link video)", None),
    "G-AM-V1": ("Gate: AuditMesh v1.0 tag + demo video (link release)", "auditmesh"),
}

M18 = [
    ("Study 10 real FDE job posts -> your own skill-gap table", 2),
    ("Resume rewritten as deployments: problem -> what you built -> measured result", 2),
    ("GitHub profile + 2 pinned flagship repos + LinkedIn headline/About", 1.5),
    ("Practical coding drills: 20 Python problems (messy data / call an API / fix a bug)", 3),
    ("Decomposition interview: 10 prompts", 2),
    ("Customer role-play: 5 mock discovery calls (Claude plays a difficult customer)", 2),
    ("Project deep-dive: STAR stories for OmniGuard and AuditMesh, including what broke", 1.5),
    ("Take-home simulation: a 4-hour timed build from a vague brief", 4),
    ("Behavioural: ambiguity, pushing back on a customer, owning a production mistake", 1),
    ("Demo skills: record and critique a 5-min demo", 1),
    ("Outreach set up: referral list + applications log started (10 applications/week from now on)", 0.5),
    ("Full mock loop (4 rounds) with Claude, scored", 2),
]

NEW_SDK = ("M10-12", "NEW: one vendor agent SDK (Claude Agent SDK or OpenAI Agents SDK)")


def nums(cell):
    # only the leading number/range of each comma-separated entry ("10 A2A" -> 10, not 2)
    out = []
    for token in cell.split(","):
        m = re.match(r"\s*(\d+)(?:-(\d+))?", token)
        if m:
            a, b = m.groups()
            out += list(range(int(a), int(b) + 1)) if b else [int(a)]
    return out


def parse_curriculum():
    mods, cur = {}, None
    for line in (FDE / "curriculum.md").read_text(encoding="utf-8").splitlines():
        m = re.match(r"^## (?:Module (\d+):\s*(.+)|Prerequisites)", line)
        if m:
            n = int(m.group(1)) if m.group(1) else 0
            cur = mods[n] = {"n": n, "title": (m.group(2) or "Prerequisites").strip(), "topics": {}}
            continue
        m = re.match(r"^(\d+)\.\s+(.+)$", line)
        if m and cur is not None:
            cur["topics"][int(m.group(1))] = m.group(2).strip()
    return mods


def parse_tiers():
    """Section 3 of MASTER_PLAN.md -> {module: (core, ext, expected_c, expected_e)}."""
    text = (FDE / "MASTER_PLAN.md").read_text(encoding="utf-8")
    sec = text.split("## 3. Topic tiers", 1)[1].split("\n## 4.", 1)[0]
    tiers = {}
    for line in sec.splitlines():
        m = re.match(r"^\| (\d\d) [^|]+\|([^|]*)\|([^|]*)\|\s*(\d+) / (\d+)\s*\|", line)
        if m:
            n = int(m.group(1))
            tiers[n] = (nums(m.group(2)), nums(m.group(3)), int(m.group(4)), int(m.group(5)))
    return tiers


def parse_resources():
    text = (FDE / "RESOURCES.md").read_text(encoding="utf-8")
    first, links = {}, {}
    for line in text.splitlines():
        m = re.match(r"^\| (\d+)(?:-(\d+))? \| (.+?) \|$", line)
        if m:
            for n in nums(m.group(0).split("|")[1]):
                first[n] = m.group(3).strip()
    cur = []
    for line in text.splitlines():
        if line.startswith("## "):
            h = line[3:]
            cur = nums(re.sub(r"^\D*", "", h.split(":")[0])) if re.match(r"^(\d\d |Modules? \d)", h) else []
            continue
        for url in re.findall(r"https?://[^\s)>,]+", line):
            for n in cur:
                links.setdefault(n, []).append(url)
    return first, links


def find_file(n, t):
    folders = sorted(FDE.glob(f"{n:02d} - *"))
    if not folders:
        return None, False
    files = sorted(folders[0].glob(f"{t:02d} - *.md"))
    if not files:
        return None, False
    f = files[0]
    return f.relative_to(FDE).as_posix(), f.stat().st_size > STUB_BYTES


def build():
    mods = parse_curriculum()
    tiers = parse_tiers()
    first, links = parse_resources()
    items = {}

    def add(id_, **kw):
        items[id_] = {"id": id_, **kw}
        return id_

    for id_, title, h in SETUP:
        add(id_, kind="setup", title=title, hours=h, mod=None)
    for n, title in mods[0]["topics"].items():
        f, has = find_file(0, n)
        add(f"M00-{n:02d}", kind="diag", mod=0, n=n, title=title, hours=0.25, tier="D", file=f, has=has)

    problems = []
    for n, mod in mods.items():
        if n in (0, 15, 16):
            continue
        core, ext, ec, ee = tiers[n]
        for t, title in mod["topics"].items():
            tier = "C" if t in core else "E" if t in ext else None
            if tier is None:
                continue
            f, has = find_file(n, t)
            add(f"M{n:02d}-{t:02d}", kind="topic", mod=n, n=t, title=title, hours=TOPIC_HOURS, tier=tier, file=f, has=has)
        got_c = sum(1 for t in core if t in mod["topics"]) + (1 if n == 10 else 0)
        got_e = sum(1 for t in ext if t in mod["topics"])
        if (got_c, got_e) != (ec, ee):
            problems.append(f"M{n:02d}: table says {ec}/{ee}, parsed {got_c}/{got_e}")
    f, has = find_file(10, 12)  # not in curriculum.md; the lesson file is created alongside the stubs
    add(NEW_SDK[0], kind="topic", mod=10, n=12, title=NEW_SDK[1], hours=TOPIC_HOURS, tier="C", file=f, has=has)
    for n in (15, 16):
        for t, title in mods[n]["topics"].items():
            f, has = find_file(n, t)
            add(f"M{n}-{t:02d}", kind="cap", mod=n, n=t, title=title, hours=1, tier="C", file=f, has=has)
    for i, (title, h) in enumerate(M18, 1):
        f, has = find_file(18, i)
        add(f"M18-{i:02d}", kind="job", mod=18, n=i, title=title, hours=h, tier="C", file=f, has=has)
    for id_, (title, h) in BUILDS.items():
        add(id_, kind="build", title=title, hours=h, mod=None)
    for id_, (title, badge) in GATES.items():
        add(id_, kind="gate", title=title, hours=0, mod=None, badge=badge)
    if problems:
        raise SystemExit("Tier table and parser disagree:\n  " + "\n  ".join(problems))

    def mod_ids(n, tiers_="C", only=None, skip=()):
        ids = [i for i in items.values() if i.get("mod") == n and i["kind"] in ("topic", "cap", "job")
               and i["tier"] in tiers_ and (only is None or i["n"] in only) and i["id"] not in skip]
        return [i["id"] for i in sorted(ids, key=lambda x: x["n"])]

    setup = [s[0] for s in SETUP] + ["M03-13"]
    diag = [f"M00-{n:02d}" for n in mods[0]["topics"]]
    evals = ["M14-05", "M14-06", "M14-07", "M14-08"]
    m18 = lambda *ns: [f"M18-{n:02d}" for n in ns]
    C, CE = "C", "CE"

    fast = [
        ("Setup + diagnostic + Python/Linux core", setup + diag + mod_ids(1) + ["B-EX", "G-EX"]),
        ("APIs + LLM fundamentals", mod_ids(2) + ["B-OG-API", "G-OG-API"] + mod_ids(5) + ["B-OG-LLM", "G-OG-LLM"]),
        ("RAG + evals + messy PDFs", mod_ids(6) + evals + mod_ids(8) + ["B-OG-RAG", "G-OG-RAG"]),
        ("Docker, CI/CD, AWS -> live", mod_ids(4) + mod_ids(3, skip=("M03-13",)) + ["B-OG-DEPLOY", "G-DEPLOY"]),
        ("Integrations -> IAM + job hunt starts", mod_ids(11) + mod_ids(12) + m18(1, 2, 3) + ["B-OG-SQL", "G-RBAC"]),
        ("Security + GraphRAG + OmniGuard v1.0", mod_ids(13) + ["M17-09"] + mod_ids(15) + m18(4, 5) + ["B-OG-V1", "G-OG-V1"]),
        ("Agents + MCP -> AuditMesh core", mod_ids(9) + mod_ids(10) + m18(6, 7) + ["B-AM-CORE", "G-AM-HITL"]),
        ("Observability + AuditMesh v1.0 + interviews", mod_ids(14, skip=evals) + mod_ids(16) + m18(8, 9, 10, 11, 12) + ["B-AM-V1", "G-AM-V1"]),
    ]
    slow = [
        ("Setup + diagnostic + Python/Linux", setup + diag + mod_ids(1, CE) + ["B-EX", "G-EX"]),
        ("Modern APIs + OmniGuard skeleton", mod_ids(2, CE) + ["B-OG-API", "G-OG-API"]),
        ("LLM fundamentals + prompting", mod_ids(5, CE) + ["B-OG-LLM", "G-OG-LLM"]),
        ("RAG + evals", mod_ids(6, CE) + evals + ["B-OG-RAG", "G-OG-RAG"]),
        ("Multimodal + graph + job hunt starts", mod_ids(8, CE) + mod_ids(7, CE) + ["M17-09"] + m18(1, 2, 3) + ["B-OG-MM", "B-GRAPH", "G-MMG"]),
        ("Docker, CI/CD, AWS -> live", mod_ids(4, CE) + mod_ids(3, CE, skip=("M03-13",)) + ["B-OG-DEPLOY", "G-DEPLOY"]),
        ("Integrations -> IAM", mod_ids(11, CE) + mod_ids(12, CE) + ["B-OG-SQL", "G-RBAC"]),
        ("Security + OmniGuard v1.0", mod_ids(13, CE) + mod_ids(15) + ["B-OG-V1", "G-OG-V1"]),
        ("Agents + MCP -> AuditMesh core", mod_ids(9, CE) + mod_ids(10, CE) + ["B-AM-CORE", "G-AM-HITL"]),
        ("Observability + AuditMesh v1.0 + interviews", mod_ids(14, CE, skip=evals) + mod_ids(16) + mod_ids(17, "E")
         + m18(4, 5, 6, 7, 8, 9, 10, 11, 12) + ["B-AM-V1", "G-AM-V1"]),
    ]

    tracks = {}
    for name, cps, months, label in (("fast", fast, {1: 4, 2: 8}, "Fast -- 2 months"),
                                     ("slow", slow, {1: 2, 2: 4, 3: 6, 4: 8, 5: 10}, "Slow -- 5 months")):
        seen = [i for _, ids in cps for i in ids]
        dup = {i for i in seen if seen.count(i) > 1}
        missing = [i for i in seen if i not in items]
        if dup or missing:
            raise SystemExit(f"{name}: duplicate {sorted(dup)} missing {missing}")
        topics = [i for i in seen if items[i]["kind"] == "topic"]
        tracks[name] = {
            "label": label,
            "months": months,
            "checkpoints": [{"n": k + 1, "title": t, "items": ids} for k, (t, ids) in enumerate(cps)],
            "hours": round(sum(items[i]["hours"] for i in seen), 1),
            "topicCount": len(topics),
        }

    modules = []
    for n, mod in sorted(mods.items()):
        folder = sorted(FDE.glob(f"{n:02d} - *"))
        modules.append({"n": n, "title": mod["title"], "folder": folder[0].name if folder else None,
                        "read": first.get(n), "links": links.get(n, [])[:6]})
    if not any(m["n"] == 18 for m in modules):
        modules.append({"n": 18, "title": "FDE Interview & Job Hunt", "folder": None, "read": None, "links": []})

    plan = {"generated": dt.date.today().isoformat(), "start": "2026-10-12",
            "tracks": tracks, "items": items, "modules": modules}
    OUT.write_text(json.dumps(plan, indent=1, ensure_ascii=True) + "\n", encoding="utf-8")
    return plan


if __name__ == "__main__":
    p = build()
    for k, t in p["tracks"].items():
        print(f"{k}: {len(t['checkpoints'])} checkpoints, {t['topicCount']} topics, {t['hours']} h")
    print("wrote", OUT)
