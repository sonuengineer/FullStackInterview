# FDE Interview & Job Hunt

## Decomposition interview

> Core | Fast CP6 / Slow CP10 | ~2 h | Builds on: M15-01, M15-03, M06-*, M09-*

### Kahani
Interviewer sirf ek line bolta hai: "A hospital wants AI for discharge notes. Go."
Na data ka size, na users, na budget. 45 minute ka round.
Ek candidate turant bolta hai: "Main GPT-4 + Pinecone + LangChain use karunga." 3 minute mein architecture ready, aur interview wahi khatam -- kyunki usne ek bhi sawal nahi poocha.
Doosra candidate poochta hai: "Who writes these notes today, who reads them, and what goes wrong when they are late or wrong?" Woh round jeet jaata hai.
Decomposition round test karta hai ki aap fog ko plan mein badal sakte ho ya nahi -- bilkul M15-01 discovery workshop jaisa, bas 45 minute mein.

### What it is
Ek vague business problem ko structured tarike se todna: goal, users, constraints, data, success metric, MVP design, risks, phased plan -- aur ye sab bolte hue, interviewer ke saath collaborate karte hue.

### Why it matters for an FDE
Real customer bhi aise hi aata hai: "we want AI for X". Jo FDE seedha tool chun leta hai, woh 6 hafte baad galat cheez deliver karta hai.

### Key concepts
- **Clarify before design** -- pehle 8-10 minute sirf sawal. Interviewer jawab na de to apna assumption bolke likho.
- **Data inventory** -- kaunsa data hai, kahan hai, kis format mein, kaun access deta hai, kitna PII.
- **Success metric** -- baseline + target + kaise measure. "Better notes" metric nahi hai.
- **MVP architecture** -- sabse chhota system jo metric move kare; human-in-the-loop by default in high-risk domains.
- **Phased plan** -- pilot (4-6 weeks, 1 team) -> expand -> scale. Har phase ka exit criterion.

### How to do it
The 7-step method (rough time split for 45 min):
1. **Clarify goal / users / constraints** (8 min) -- who, why now, what does "done" mean, compliance, on-prem vs cloud, budget, timeline.
2. **Data inventory** (5 min) -- sources, volume, quality, access, PII, labels for evaluation.
3. **Success metric** (3 min) -- one primary, 1-2 guardrail metrics (e.g. error rate must not rise).
4. **MVP architecture** (12 min) -- draw boxes: ingestion -> retrieval/extraction -> LLM step -> validation -> human review -> output -> logging/evals.
5. **Risks** (5 min) -- hallucination, PII leakage, latency, cost, adoption, integration.
6. **Phased plan** (5 min) -- pilot, expand, scale, each with an exit check.
7. **What I would ask the customer next** (3 min) -- 3-5 questions you could not resolve.
Board pe ye 7 headings pehle likh do. Interviewer ko aapka map dikhta hai, aur aap khud bhi track pe rehte ho.

#### Worked example (English, how you would say it)
Prompt: "A hospital wants AI for discharge notes."

```text
1. Clarify
- "Is the goal to draft discharge summaries for doctors, or to explain them to patients?"
  Assume: draft summaries for doctors from the inpatient record; doctor always signs off.
- Users: ward doctors (write/approve), nurses (read), patients (later phase).
- Constraints: patient data cannot leave the hospital network or approved region; audit trail required; EHR is a legacy system with an HL7/FHIR or DB export.
2. Data inventory
- Admission notes, progress notes, lab results, medication orders, past discharge summaries (good examples for evaluation).
- Volume assumption: ~150 discharges/day. Free text + structured labs. Heavy PII.
3. Success metric
- Primary: median doctor time per summary from <baseline> to <target>, measured by EHR timestamps.
- Guardrails: zero medication errors in a reviewed sample; doctor edit distance tracked.
4. MVP architecture
- Nightly or on-demand pull from EHR (read-only) -> section extractor (meds, diagnoses, follow-ups) as structured JSON
  -> LLM drafts summary using only extracted facts, every sentence citing its source note
  -> validator checks meds against the medication order table -> doctor review UI -> signed note back to EHR.
- Model hosted in an approved region or on-prem; PII never logged in plain text.
5. Risks
- Wrong medication or dose (highest risk) -> rule-based cross-check + mandatory human sign-off.
- Doctors stop reading drafts carefully -> show diffs and citations, sample audits.
- EHR integration delays -> start with an export file in the pilot.
6. Phased plan
- Pilot: 1 ward, 4-6 weeks, shadow mode first (draft not used, only compared). Exit: time saved + no critical errors in 200 reviewed notes.
- Expand: 3-4 wards, write-back to EHR. Scale: patient-friendly version, multilingual.
7. What I would ask the customer
- Who owns EHR access and how long does approval take?
- Which past summaries are considered "gold" and who can label errors?
- What is the clinical-safety sign-off process for new software?
```

### Practice set
10 prompts. Har ek 45 min, timer, out loud, 7 headings ke saath. Claude ko interviewer banao (prompt M18-12 mein hai).
1. A hospital wants AI for discharge notes. (redo the worked example without looking)
2. An insurance company wants to triage incoming claims (email + PDF attachments) by urgency and fraud risk.
3. A logistics company wants an assistant that predicts and explains shipment delays to its ops team.
4. A bank wants to speed up KYC document review (ID proofs, address proofs, forms in 3 languages).
5. A retail brand wants a support bot that can look up order status and process simple returns.
6. A 5,000-person company wants an HR policy assistant for employees across 4 countries.
7. A legal team wants to search clauses across 20,000 contracts ("show me all uncapped indemnities").
8. A manufacturer wants to use 10 years of free-text maintenance logs to reduce machine downtime.
9. A telecom company wants to understand churn from call-centre agent notes.
10. A state government wants to route citizen grievances (text + voice, multiple languages) to the right department.

### Rubric
Score out of 10:
| Area | Points |
|---|---|
| Asked clarifying questions before naming any tool | 2 |
| Data inventory incl. access + PII | 1 |
| Measurable success metric with baseline | 2 |
| MVP is small, has human review where risk is high | 2 |
| Risks named with a mitigation each | 1 |
| Phased plan with exit criteria | 1 |
| Clear structure + collaborated with interviewer | 1 |

### Common pitfalls
- Tool-first answer ("LangGraph + Pinecone"). Tool sirf step 4 mein aata hai, aur hamesha "because..." ke saath.
- Har cheez ek hi phase mein. Pilot chhota rakho; interviewer ko scope discipline dikhni chahiye.
- Cost aur latency bhool jaana. Ek line bolo: "At ~150 summaries a day the LLM cost is small; latency matters less because it is batch."

### Checklist before moving on
- [ ] All 10 prompts done, scored, with notes
- [ ] Last 3 scored 7+/10
- [ ] 7 headings written from memory in under 30 seconds
- [ ] At least 1 decomposition logged in Job hunt -> Mock interviews

### Self-quiz
1. Why is "shadow mode" a good first pilot phase in high-risk domains like healthcare?
2. The interviewer refuses to answer your clarifying questions. What do you do instead of stalling?
3. For prompt 7 (legal clause search), what would your primary success metric be and how would you measure it?
