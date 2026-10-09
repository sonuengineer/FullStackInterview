# FDE Interview & Job Hunt

## GitHub profile and LinkedIn

> Core | Fast CP5 / Slow CP5 | ~1.5 h | Builds on: M18-02

### Kahani
Hiring manager ne aapka resume pasand kiya aur GitHub link khola. Pehli cheez dikhi: 41 repos, sab "tutorial-xyz", "test123", "langchain-demo-final-v2".
Pinned section khaali. OmniGuard repo ka README bas `# omniguard` aur `pip install -r requirements.txt`.
Usne 40 second mein tab band kar diya. Aapka sabse accha kaam ek click door tha, par dikhaya hi nahi gaya.
GitHub aur LinkedIn aapke resume ka "proof layer" hain -- recruiter claim padhta hai resume pe, aur saboot dhoondta hai yahan.

### What it is
GitHub profile ko 2 pinned flagship repos (OmniGuard, AuditMesh) ke around organise karna, unke READMEs ko 2-minute evaluation ke liye likhna, aur LinkedIn headline + About ko same story pe align karna.

### Why it matters for an FDE
FDE ka kaam hi hai customer ko 5 minute mein samjhana ki system kya karta hai aur kyun trust karein. Aapka README us skill ka pehla sample hai jo hiring manager dekhta hai.

### Key concepts
- **Pinned flagship** -- 2 deep repos pin karo, 4 shallow nahi. Baaki pins optional: ek tooling/library repo, ek drill repo.
- **README as a landing page** -- top 15 lines mein: what, live URL, demo video, architecture diagram, eval numbers.
- **Profile README** -- `username/username` repo ka README.md profile pe dikhta hai; 6-8 lines max.
- **LinkedIn headline** -- role + proof, not adjectives. Search ke liye keywords zaroori.
- **Consistency** -- resume, GitHub aur LinkedIn mein same numbers aur same project names.

### How to do it
1. Archive ya private karo: tutorials, forks you never changed, empty repos.
2. Pin OmniGuard and AuditMesh first. Repo description (one line) bharo + topics add karo (`rag`, `llm`, `fastapi`, `langgraph`, `mcp`).
3. Har flagship README ko neeche ke checklist pe laao.
4. Profile README likho.
5. LinkedIn headline + About update karo, Featured section mein demo video + repo link.

#### Pinned-repo README checklist
Order matters -- ye top se bottom isi order mein:
- [ ] **One-line pitch** -- what it does, for whom, under which constraint
- [ ] **Live URL** (or "runs locally in 3 commands" if hosting is off) + demo login if safe (never real secrets)
- [ ] **Demo video** (2-5 min, Loom/YouTube unlisted) -- link or GIF thumbnail
- [ ] **Architecture diagram** (Mermaid or PNG) with trust boundaries marked
- [ ] **Eval numbers table** -- metric, value, dataset size, date, how to reproduce
- [ ] **How to run** -- prerequisites, `.env.example`, 3-5 commands, expected output
- [ ] **Key decisions + trade-offs** -- 3-5 bullets ("chose BM25 + vectors because...")
- [ ] **What broke and what I changed** -- 2-3 honest bullets (this is gold for M18-07)
- [ ] **Limitations / next steps**
- [ ] **Tests + CI badge**, license

README top block (English, paste-ready skeleton):
```markdown
# OmniGuard -- secure AI assistant over enterprise SQL + documents

Hybrid RAG + read-only Text-to-SQL for a simulated insurance pilot, with OAuth 2.0/RBAC and PII guardrails.

**Live:** <url> | **Demo (4 min):** <video url> | **Eval report:** docs/eval.md

| Metric | Value | Dataset | How to reproduce |
|---|---|---|---|
| Faithfulness | <faithfulness score> | 50 Qs | `make eval` |
| Answer p95 latency | <p95 latency> | 50 Qs | `make eval` |
| Blocked injection prompts | <n>/<n> | 30 attacks | `make redteam` |
```

#### LinkedIn (English, paste-ready)
Headline options:
- `Full-stack engineer -> AI Forward Deployed Engineer | Secure RAG, multi-agent workflows, LLM evals | Python, Node, SQL`
- `Building and deploying LLM systems on messy enterprise data | RAG + Text-to-SQL + agents with human approval`

About (edit the placeholders, keep it under 120 words):
```text
I build AI systems that survive real customer environments: legacy databases, strict access rules, and people who need to trust the output.

Recent work:
- OmniGuard: secure hybrid RAG + read-only Text-to-SQL over MS SQL with RBAC and PII guardrails. <faithfulness score> faithfulness, <p95 latency> p95.
- AuditMesh: a LangGraph multi-agent compliance workflow with human approval and a Jira MCP server. Review time <baseline> -> <result>.

Before AI, I spent <n> years shipping full-stack products (Node/TS, SQL, REST) and integrating client systems.

I am looking for Forward Deployed / Applied AI Engineer roles. Demos and code: <github url>
```

Profile README (6-8 lines): name + one-line role, 2 flagship links with one metric each, "currently building", contact.

### Practice set
1. Clean up repos (archive/private) and pin the 2 flagships.
2. Bring both READMEs to 8/10 checklist items, even if numbers are still placeholders.
3. Write the profile README.
4. Update LinkedIn headline, About, Featured.
5. Ask Claude: "Here is my README. You are a hiring manager with 2 minutes. What do you understand, what is missing, what would you click next?" Fix the top 3 issues.
6. Ask a friend (non-AI dev) to open the repo and run it from the README alone. Note where they got stuck.

### Rubric
| Check | Pass |
|---|---|
| 2 flagships pinned, descriptions + topics set | yes/no |
| Each README: live/demo link + diagram + eval table in first screen | yes/no |
| Fresh clone runs with README steps only | yes/no |
| No secrets in repo history (`.env` ignored, keys rotated if ever leaked) | yes/no |
| LinkedIn headline and resume tell the same story | yes/no |

### Common pitfalls
- `.env` ya API key commit ho gayi history mein. File delete karna kaafi nahi -- key rotate karo.
- README mein 2 page setup pehle, "kya karta hai" baad mein. Reverse karo.
- LinkedIn pe "Open to work" + generic headline. Headline hi search result hai; keywords daalo.

### Checklist before moving on
- [ ] Flagship READMEs follow the checklist order
- [ ] Demo video links work in an incognito window
- [ ] Profile README live
- [ ] LinkedIn updated with Featured links
- [ ] Numbers identical across resume, README, LinkedIn

### Self-quiz
1. Why should the eval table sit in the first screen of the README instead of in a docs folder?
2. A hiring manager clones your repo and it fails on step 2. What three things in the README most likely caused it?
3. How does the "what broke and what I changed" section help you later in the deep-dive round?
