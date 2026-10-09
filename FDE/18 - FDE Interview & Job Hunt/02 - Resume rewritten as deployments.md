# FDE Interview & Job Hunt

## Resume rewritten as deployments

> Core | Fast CP5 / Slow CP5 | ~2 h | Builds on: M18-01

### Kahani
Recruiter ke paas ek FDE role ke liye 300 resumes aaye. Har resume pe average 20-30 second.
Aapke resume ki pehli line: "Worked on LangChain, FastAPI, Docker, AWS, Pinecone, React."
Agle resume ki pehli line: "Deployed a secure RAG + Text-to-SQL assistant over MS SQL for an insurance pilot; cut analyst lookup time from <baseline> to <result>."
Dono ne shayad same tech use ki. Interview call doosre ko gaya -- kyunki usne **deployment** bataya, tool list nahi.

### What it is
Har resume bullet ko is shape mein likhna: **Problem -> What you built -> Measured result** (+ optionally the hard constraint you handled).
FDE resume ek "deployments ka portfolio" hai, skills ka dictionary nahi.

### Why it matters for an FDE
FDE ko hire karne wala ek sawal poochta hai: "Kya ye banda customer ke messy environment mein kuch ship karke number move kar sakta hai?" Bullet agar is sawal ka jawab nahi deta, woh jagah waste hai.

### Key concepts
- **Deployment bullet** -- context (who/what), action (what you built, key decision), result (number) -- ek line, max do.
- **Metric placeholders** -- abhi number nahi hai to `<p95 latency>` jaisa placeholder rakho aur capstone mein measure karo. Kabhi invent mat karo.
- **Constraint word** -- "on-prem", "PII", "legacy SOAP", "read-only DB role" -- ye shabd FDE recruiter ko signal dete hain.
- **Verb discipline** -- built, deployed, integrated, measured, reduced, led. "Worked on", "helped with", "exposure to" hatao.
- **Honest scope** -- capstone ko "pilot for a simulated customer" ya "portfolio project" likho; fake client naam nahi.

### How to do it
1. Purana resume kholo. Har bullet ke saamne likho: P (problem) / B (built) / R (result) -- jo missing hai woh mark karo.
2. Top section: 2-line summary (neeche template).
3. "Projects / Deployments" section ko experience ke **upar** rakho agar aapka current job AI-related nahi hai.
4. Har capstone ke liye 3-4 bullets, har ek mein ek number ya placeholder.
5. Existing full-stack experience ko bhi rewrite karo -- integration aur customer-facing kaam highlight karo.
6. 1 page (experience < 8 years), PDF, ATS-friendly (no tables/columns, no images).

#### Before -> after (English, paste-ready)

Summary:
- Before: `Passionate full-stack developer learning AI and LLMs, skilled in many technologies.`
- After: `Full-stack engineer (Node/TS, SQL, REST) now building and deploying LLM systems end to end: secure RAG over enterprise data, multi-agent workflows with human approval, and evals that prove they work.`

OmniGuard (secure AI integration capstone):
- Before: `Built a RAG chatbot using LangChain and FastAPI.`
- After: `Built and deployed OmniGuard, a hybrid RAG + read-only Text-to-SQL assistant over MS SQL and documents for a simulated insurance pilot; reached <faithfulness score> faithfulness and <p95 latency> p95 on a 50-question eval set.`
- Before: `Implemented security features.`
- After: `Added OAuth 2.0 + RBAC so each answer respects the caller's data access, and PII redaction guardrails that blocked <n>/<n> injection and leakage test prompts.`
- Before: `Used Docker and deployed to cloud.`
- After: `Shipped as a Dockerized FastAPI service with CI checks and a UAT runbook; documented SOW scope, data classification and ROI for a CISO-level review.`

AuditMesh (multi-agent compliance capstone):
- Before: `Made a multi-agent system with LangGraph.`
- After: `Built AuditMesh, a LangGraph supervisor that automates a 5-step manual compliance review with human-in-the-loop approval; cut simulated review time from <baseline minutes> to <result minutes> per case.`
- Before: `Created an MCP server.`
- After: `Wrote a custom MCP server for Jira ticketing with scoped permissions and audit logging, so agents could create tickets but never close or delete them.`
- Before: `Added monitoring.`
- After: `Added traces and a token-cost dashboard; held cost at <cost per case> and p95 at <p95 latency> against the SLA I defined.`

Existing job (example rewrite):
- Before: `Developed REST APIs and fixed bugs for clients.`
- After: `Integrated <n> client systems (REST, SOAP, CSV drops) into a Node/SQL platform; reduced failed nightly syncs from <before> to <after> per week by adding retries and idempotent upserts.`

### Practice set
1. Rewrite every bullet on your current resume into P/B/R. Count how many have a number.
2. Write 4 OmniGuard + 4 AuditMesh bullets; pick the best 3 each.
3. List every placeholder and the exact script/eval in your capstone that will produce it.
4. Paste your resume and one target job post to Claude with: "You are a recruiter for this role. Spend 30 seconds on this resume. What do you remember? What would make you reject it?"
5. Make one tailored version for your top-3 gap role family from M18-01.

### Rubric
| Check | Target |
|---|---|
| Bullets with a number or placeholder | 80%+ |
| Bullets starting with a weak verb (worked on, helped, exposure) | 0 |
| Constraint words (PII, on-prem, legacy, RBAC, SLA) visible in top half | 3+ |
| Capstones honestly labelled (portfolio / simulated customer) | yes |
| 1 page, single column, text-selectable PDF | yes |

### Common pitfalls
- Fake numbers. Interviewer deep-dive (M18-07) mein ek follow-up se pakda jaata hai -- aur trust khatam. Placeholder rakho, measure karo, phir bharo.
- Tool soup: 25 tools ki list. 8-10 rakho jo bullets mein actually use hue.
- Capstone ko real client bata dena. "Simulated insurance pilot" bolna perfectly fine hai; jhooth nahi.

### Checklist before moving on
- [ ] Summary rewritten in the after-style
- [ ] 3 OmniGuard + 3 AuditMesh bullets with placeholders mapped to evals
- [ ] Old job bullets rewritten as integrations/deployments
- [ ] Claude recruiter pass done and fixes applied
- [ ] PDF exported and checked by copy-pasting text (ATS test)

### Self-quiz
1. What makes "Built a RAG chatbot using LangChain" weak for an FDE role, specifically?
2. Your faithfulness eval is not done yet. What do you write today, and what must happen before you apply?
3. Why can a constraint word like "read-only DB role" be more valuable on an FDE resume than another framework name?
