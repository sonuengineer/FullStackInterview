# OmniGuard - Secure AI Integration

## ROI presentation for CISO and executives

> Deliverable 11 of 12 | Built in: Fast CP6 / Slow CP8 | Time box: 4 h

### Goal
Build an honest, reproducible business case for moving OmniGuard from pilot to production: benefits against total cost, payback period, a sensitivity table that shows where the case breaks, and risk reduction framed as an estimate, not a promise.

### Customer context (Kavach Finserv)
The steering committee has 20 minutes: Anil (CISO) wants risk and controls, Sunita (CFO) wants payback, Priya (Head of Claims) wants analyst time saved. A previous vendor claimed "10 crore saved and data breach risk eliminated" and lost the room on the first question. Every number in your deck must be traceable to an input with a stated source.

### What to build
- `omniguard/tools/roi.py inputs.yaml`: prints a markdown report with benefit per year, token cost per query and per year, run cost per year, net per year, payback months, a separate risk-reduction range, and a 3x3 sensitivity grid.
- `omniguard/docs/roi-inputs.yaml`: every input with a `value` and a `source` (`illustrative`, `pilot logs`, `HR/finance`, `discovery workshop`). Minimum inputs:
  - analysts, adoption, hours saved per week, loaded cost per hour, working weeks
  - queries per active day, working days, tokens in/out per query, price per 1M tokens in/out
  - infra per month, support FTE and FTE cost, one-time build cost
- Token figures taken from your own OmniGuard usage (logged token counts or a count-tokens call), not guessed.
- Risk reduction as `probability x impact x reduction`, shown as a low-high range and kept out of the payback number.
- `omniguard/docs/ROI.md`: the generated report plus narrative. First line: "All figures are illustrative inputs for a fictional customer."
- `omniguard/docs/roi-deck-outline.md`: 6 slides -- (1) problem + baseline metric, (2) solution + security controls, (3) benefits, (4) costs, (5) payback + sensitivity, (6) the ask (budget, decision, date). Each number footnoted with its source.

### Inputs: lessons to (re)read
- M15-04 Preparing ROI presentations for CISO/executives (formulas, sensitivity, honest risk framing)
- M15-01 Conducting technical discovery and scoping workshops (baseline metrics)
- M15-03 Drafting architecture SOWs (build cost and timeline)
- M05-03 Token calculation
- M14-11 Monitoring granular token costs and endpoint latency
- M14-15 Prompt caching strategies (a cost lever worth one line in the deck)

### Acceptance checks
Automated by the pytest suite for `roi.py` (pattern from M15-04):
1. Hand-calculated test: cost per query for 6,000 tokens in and 500 out at the M15-04 sample prices equals 2.125 (INR).
2. Hand-calculated test: benefit equals active analysts x hours saved x weeks x loaded cost.
3. Payback is infinite ("never") when net monthly benefit is zero or negative.
4. Sensitivity grid: rows = adoption (30/60/90%), columns = hours saved (2/4/6); more usage never gives a slower payback.
5. Risk reduction is a low-high range and is not added to payback.
6. Every input in `roi-inputs.yaml` has a `source`; a missing source fails the run.
7. Changing an input in YAML changes the report without any code change; same input -> identical output.
Manual review:
8. Deck outline has the 6 slides and the cell where ROI turns negative is called out, with the mitigation (for example an adoption/training plan).

### Proof for the gate
`ROI.md`, `roi-inputs.yaml` and the deck outline committed before the v1.0 tag (CP6); the payback and sensitivity slide appears in the business section of the demo video.

### Definition of done
- Report regenerates from one command; tests tie the formulas to hand calculations.
- No number in the deck that is not in the inputs file.
- Illustrative disclaimer at the top of both the report and the deck outline.

### Out of scope
Real customer financials, NPV/IRR modelling, vendor price negotiations, a designed slide deck (an outline is enough).

### Stretch goals
- Add a model-choice scenario (cheaper model for simple routes) and show its effect on run cost (M14-16).
- Tornado chart of the five most sensitive inputs.
- Replace illustrative token numbers with a week of measured usage from your deployed instance.
