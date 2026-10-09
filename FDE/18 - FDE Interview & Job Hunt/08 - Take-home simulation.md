# FDE Interview & Job Hunt

## Take-home simulation

> Core | Fast CP8 / Slow CP10 | ~4 h | Builds on: M18-04, M18-05, M02-*, M06-*, M14-*

### Kahani
Friday shaam email aata hai: "Please build a prototype that helps our support team answer questions from our product docs. Timebox: 4 hours. Submit a repo link by Monday."
Bas. Na docs ka format, na "kitna accurate chahiye", na UI chahiye ya API.
Ek candidate weekend bhar 14 ghante lagata hai, React UI, auth, sab kuch -- aur README mein run instructions nahi. Reviewer clone karta hai, error aata hai, reject.
Doosra 4 ghante mein ek chhota, chalne wala, tested API + eval script + honest README bhejta hai. Woh next round mein jaata hai.
Take-home test karta hai ki aap vague brief pe **scope choose** karke time mein kuch **trustworthy** ship kar sakte ho.

### What it is
Ek timed build exercise (usually 2-6 hours) jahan brief jaan-bujh ke vague hota hai. Aapko assumptions likhne hain, scope cut karna hai, aur ek runnable, documented submission dena hai.
Is lesson mein aap ek full 4-hour simulation karte ho, real jaisa.

### Why it matters for an FDE
Customer pilots bhi aise hi hote hain: limited time, adhoori requirements. Reviewer dekh raha hai: kya aap wahi cheez ship karoge jo important hai, aur kya aap apni limits honestly likhoge.

### Key concepts
- **Assumptions log** -- har unclear cheez pe ek written assumption; README mein top pe.
- **Timebox discipline** -- 4 hours means 4 hours. Over-time submissions often hurt more than help; agar zyada time lagaya to honestly bolo.
- **Thin vertical slice** -- input -> core logic -> output -> test -> eval, end to end, before any polish.
- **Evidence of quality** -- tests + a tiny eval set with a number beats a pretty UI.
- **Reviewer empathy** -- reviewer ke paas 15-20 minute hain. 3 commands mein chalna chahiye.

### How to do it
The brief (use this exactly, do not add details):
```text
Our support team spends too long finding answers in our product documentation.
Build a prototype that helps them. You have 4 hours.
Submit a repository with a README. Use any language or tools you like.
```
Sample docs: kisi open-source project ke 20-40 markdown docs use karo (e.g. FastAPI ya kisi library ke docs folder ka copy), ya khud 20 short FAQ files likho. Real API keys optional -- FakeLLM fallback rakho taaki reviewer bina key ke chala sake.

Timeboxing plan (4h = 240 min):
| Block | Minutes | Output |
|---|---|---|
| Read + assumptions + scope | 20 | `ASSUMPTIONS` section drafted, 1 user + 1 metric chosen |
| Skeleton + data loading | 30 | repo, `make run` / one command works on dummy input |
| Core: retrieval + answer with citations | 70 | `/ask` endpoint or CLI returns answer + sources |
| Eval: 15-20 Q/A pairs + scoring script | 40 | one number (e.g. retrieval hit rate@5) |
| Tests + error handling | 30 | 4-6 tests, timeouts, empty-result path |
| README + cleanup | 30 | README from template below, fresh-clone test |
| Buffer | 20 | something always breaks |
Phone pe timer lagao. Har block ke end pe commit karo (`git log` reviewer ke liye bhi signal hai).

#### What reviewers commonly look for
- Does it run from the README on a fresh machine?
- Did the candidate state assumptions and scope cuts clearly?
- Is the core problem solved, even simply? (Answers cite sources, not just chat.)
- Is there any measurement of quality?
- Code structure: small modules, config via env vars, no secrets committed.
- Error handling: missing docs, no results, LLM timeout.
- Honest limitations and "what I would do next with more time".

#### Submission README template (English)
```markdown
# Docs Answer Assistant (4-hour take-home)

## What it does
Answers support agents' questions from product docs, with citations to the source file and section.

## Assumptions
- Users are internal support agents, not end customers.
- Docs are markdown, < 500 files, updated weekly.
- Success = the right doc appears in the top 5 sources for most questions.

## Scope cuts (on purpose)
- No UI (API + CLI only), no auth, no incremental re-indexing.

## How to run
cp .env.example .env        # LLM key optional; FakeLLM is used without it
pip install -r requirements.txt
python -m app.index docs/   # build index
uvicorn app.main:app        # POST /ask {"question": "..."}
pytest -q

## Results
| Metric | Value | Data |
|---|---|---|
| Retrieval hit rate @5 | <hit rate> | 20 hand-written questions (eval/questions.jsonl) |
| p95 answer latency | <p95 latency> | same set, local machine |

## Design decisions
- BM25 + embeddings with RRF because docs mix exact API names and natural language.
- Answers must cite sources; if nothing relevant is found, the API says so instead of guessing.

## Limitations and next steps
- Eval set is small and written by me; next: 100 real agent questions labelled by the support team.
- Time spent: 4h 05m.
```

### Practice set
1. Run the full simulation on a weekend morning. Strict 4 hours.
2. Next day, do a fresh clone in a new folder and follow your README exactly. Fix (in a separate commit labelled "post-deadline") anything that broke, and note it.
3. Paste the README + key files to Claude: "Review this take-home as a strict FDE hiring reviewer. Score out of 10 and list the top 5 issues."
4. Log it: Job hunt -> Mock interviews -> kind "take-home".
5. Second run (optional, 2 weeks later): brief = "Our finance team wants to automate invoice data entry. 4 hours."

### Rubric
| Area | Points |
|---|---|
| Runs from README in 3-5 commands | 2 |
| Assumptions + scope cuts written | 2 |
| Core problem solved with citations / correct output | 2 |
| Has an eval number with method | 2 |
| Tests + error handling + no secrets | 1 |
| Honest limitations + time spent | 1 |

### Common pitfalls
- Gold-plating UI aur auth pe 2 ghante -- core aur eval adhoore reh jaate hain.
- Real API key required to run. Reviewer ke paas key nahi hogi -- fake fallback ya clear instructions do.
- Over-time chhupana. Commit timestamps dikhte hain; honesty safer hai.

### Checklist before moving on
- [ ] One full 4-hour simulation submitted to your own repo
- [ ] Fresh-clone test done
- [ ] Claude review score 7+/10 (or a second attempt done)
- [ ] Take-home logged in the portal

### Self-quiz
1. With only 4 hours, why is an eval number more valuable than a UI?
2. Which three assumptions would you write first for the vague support-docs brief, and why those?
3. You finish at 4h 30m. What do you write in the README, and why?
