# FDE Interview & Job Hunt

## Study 10 real FDE job posts

> Core | Fast CP5 / Slow CP5 | ~2 h | Builds on: --

### Kahani
Rohit ne 3 mahine "AI engineer" banne ke liye padhai ki -- LangChain, fine-tuning, thoda CUDA. Phir pehli FDE job post khol ke padhi.
Usmein likha tha: "travel to customer sites", "own the deployment end to end", "explain trade-offs to non-technical stakeholders", "integrate with legacy systems".
CUDA ka zikr tak nahi tha. Rohit ne galat cheez pe 3 mahine laga diye the.
Ye lesson us galti ka ilaaj hai: pehle market se poochho ki woh kya maangta hai, phir apna plan us hisaab se adjust karo.

### What it is
10 real job posts collect karna, har requirement ko ek table mein todna, aur apne current level ke against score karna.
Output: ek **skill-gap table** jo batata hai ki next 4-8 hafte kis cheez pe lagane hain -- opinion se nahi, data se.

### Why it matters for an FDE
FDE titles bahut alag naam se aate hain (Forward Deployed Engineer, Solutions Engineer, Applied AI Engineer, Customer Engineer, Deployment Engineer). Bina posts padhe aap ya to galat role pe apply karoge ya resume mein galat cheez highlight karoge.

### Key concepts
- **Role family** -- FDE-style roles ka common core: customer-facing delivery + coding + ambiguity. Title alag, kaam milta-julta.
- **Must-have vs nice-to-have** -- post mein "required" aur "bonus" alag padho; frequency count dono ka alag rakho.
- **Frequency score** -- 10 mein se kitni posts mein ek skill aayi. 7+ = core market signal.
- **Gap score** -- frequency x (how far you are from it). Highest gap score pehle padho.
- **Evidence** -- har skill ke saamne ek proof link (repo, demo, blog). Bina evidence ke skill "claimed" hai, "shown" nahi.

### How to do it
**Step 1 -- Collect (40 min).** 10 posts, mix mein:
- 3-4 AI labs / AI-first product companies. Places to look (check their careers page for current openings): OpenAI, Anthropic, Palantir, Scale AI, Sierra, Decagon.
- 3-4 Indian GCCs (global capability centres) or Indian AI startups -- LinkedIn Jobs, company careers pages, Wellfound, Instahyre.
- 2 "adjacent" titles: Solutions Engineer (AI), Applied AI Engineer, Customer Engineer.
Search strings: `"forward deployed engineer"`, `"applied AI engineer"`, `"solutions engineer" LLM`, `"deployment engineer" AI`.
Har post ka text ek file mein copy karo (posts band ho jaati hain) -- `job-posts/YYYY-MM-DD-company-role.txt`.

**Step 2 -- Extract (40 min).** Har post se requirements ko normalised skills mein todo. Ye commonly dikhte hain (aapki posts mein jo mile wahi likho, ye list sirf starting vocabulary hai):
- Python (production quality), one more language (TS/Go/Java)
- LLM apps: prompting, RAG, tool use / agents, evals
- Integration with messy customer systems: APIs, databases, SSO, data pipelines
- Cloud + deployment: Docker, one cloud, CI/CD
- Customer-facing: discovery, scoping, demos, writing docs
- Working in ambiguity, travel / on-site, owning outcomes

**Step 3 -- Score (30 min).** Neeche wala template bharo.

**Step 4 -- Decide (10 min).** Top 3 gap scores -> agle 4 hafte ka focus. Baaki ko roadmap pe as-is chhod do.

#### Skill-gap table template
Copy this into your notes (English, because it may go into an interview prep doc):

```text
| Skill (normalised)          | Must (n/10) | Nice (n/10) | Freq = Must + 0.5*Nice | My level 0-3 | Gap = Freq x (3 - level) | Evidence link | Plan |
|-----------------------------|-------------|-------------|------------------------|--------------|--------------------------|---------------|------|
| Python production code      |             |             |                        |              |                          |               |      |
| RAG + retrieval evals       |             |             |                        |              |                          |               |      |
| Agents / tool use           |             |             |                        |              |                          |               |      |
| Customer discovery + scoping|             |             |                        |              |                          |               |      |
| Legacy integration (SQL/SOAP)|            |             |                        |              |                          |               |      |
| Cloud deploy + Docker       |             |             |                        |              |                          |               |      |
| Security (SSO, PII, RBAC)   |             |             |                        |              |                          |               |      |
| Demos + written comms       |             |             |                        |              |                          |               |      |
```

**My level scale:** 0 = never done, 1 = followed a tutorial, 2 = built it in a capstone, 3 = built it + measured it + can defend trade-offs.
**Gap example:** RAG must in 8/10, nice in 2/10 -> Freq = 9. Level 1 -> Gap = 9 x 2 = 18. Docker must in 4/10 -> Freq 4, level 2 -> Gap 4. RAG pehle.

### Practice set
1. Collect the 10 posts and save the raw text files.
2. Fill the table. Minimum 12 rows -- agar posts mein koi skill baar-baar aa rahi hai jo upar nahi hai, add karo.
3. Highlight the top 3 gaps. Map each to a module in this curriculum (e.g. "Agents -> M09/M10, AuditMesh").
4. Write a 5-line "market summary" in English: what these roles want most, what surprised you, what you will stop studying.
5. Paste the table to Claude with: "Challenge my self-ratings. Ask me one question per row that would prove level 2 or 3." Revise honestly.

### Rubric
| Check | Pass |
|---|---|
| 10 posts, at least 3 from Indian companies/GCCs | yes/no |
| Raw text saved (not just links) | yes/no |
| Every row has a frequency count, not a guess | yes/no |
| Self-level backed by an evidence link or marked 0-1 | yes/no |
| Top 3 gaps mapped to concrete modules/weeks | yes/no |

### Common pitfalls
- Sirf AI labs ki posts padhna. Unka bar alag hai; GCC/startup posts aapka near-term market hain.
- Kisi blog ya forum ki "is company ka interview aisa hai" baat ko fact maan lena. Sirf post ka text aur recruiter se mili info use karo.
- Self-level inflate karna. "Maine RAG ek baar banaya" = level 1-2, level 3 nahi jab tak eval numbers nahi hain.

### Checklist before moving on
- [ ] 10 raw post files saved
- [ ] Skill-gap table filled with frequency + gap scores
- [ ] Top 3 gaps chosen and scheduled
- [ ] 5-line market summary written
- [ ] Re-do this table every 6-8 weeks (market badalta hai)

### Self-quiz
1. Why does the gap score multiply frequency by distance instead of just listing the skills you are weakest at?
2. Two posts have different titles but 80% the same requirements. How do you decide whether to treat them as one role family?
3. What evidence would move you from level 2 to level 3 on "RAG + retrieval evals"?
