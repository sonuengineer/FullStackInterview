# OmniGuard -- Secure AI Integration

> Fill this README as you build. Hiring managers read the first screen: keep the live URL,
> the metrics table and the demo video at the top.

**Live:** _not deployed yet (CP6 gate)_ | **Demo video:** _CP8 gate_ | **CI:** _CP6 gate_

## What it does
_One paragraph: the customer problem (fictional Kavach Finserv claims team) and what OmniGuard does about it._

## Metrics
| Metric | Value | How measured |
|---|---|---|
| Faithfulness | _CP4_ | evals/run_eval.py |
| Context precision / recall | _CP4_ | evals/run_eval.py |
| Invalid JSON rate (50 calls) | _CP3_ | tests |
| Test coverage | _CP2_ | pytest --cov |
| p95 latency, cost per query | _CP10_ | traces |

## Architecture
_ASCII or Mermaid diagram: client -> API -> guardrails -> RAG / SQL guard -> LLM._

## Run locally
```bash
python -m venv .venv && . .venv/Scripts/activate
pip install -e ".[dev]"
pytest
uvicorn omniguard.main:app --reload    # http://127.0.0.1:8000/health
```

## Docs
See [docs/](docs/) -- discovery, data classification, SOW, ROI, UAT runbook.
