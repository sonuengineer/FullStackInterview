# Starter repos

Copy these folders out of the FDE course and make each one its own GitHub repo
(setup steps 001-002 in [SYLLABUS.md](../SYLLABUS.md)). Full instructions: [SETUP.md](../SETUP.md).

| Folder | Becomes repo | Used from |
|---|---|---|
| `fde-exercises/` | `fde-exercises` | CP1 onward: every lesson mini-exercise |
| `omniguard/` | `omniguard` | CP2 onward: capstone 1 |
| _(auditmesh)_ | `auditmesh` | CP9: created then, from the CP9 lessons -- just an empty repo + README for now |

## How lesson paths map to the omniguard repo

Lessons write paths like `omniguard/sql/guard.py` or `omniguard/docs/SOW.md`.
The repo is called `omniguard` and the Python package inside it is also called `omniguard`:

```
omniguard/                  <- repo root
  pyproject.toml
  omniguard/                <- Python package: main.py, sql/, rag/, auth/, guardrails/ ...
  tests/                    <- tests/acceptance/ = capstone harnesses (M15-06..08)
  docs/  config/  infra/  uat/  evals/  tools/
```

| Lesson says | File in the repo |
|---|---|
| `omniguard/main.py`, `omniguard/sql/guard.py`, `omniguard/rag/fusion.py` | package: `omniguard/omniguard/...` |
| `omniguard/docs/...`, `omniguard/config/...`, `omniguard/infra/...`, `omniguard/uat/...` | repo root: `omniguard/docs/...` |
| `omniguard/tests/acceptance/...` | repo root: `omniguard/tests/acceptance/...` |
| `OMNIGUARD_APP=omniguard.main:app` | the `app` object in `omniguard/omniguard/main.py` |

Rule of thumb: **Python code goes in the package, everything else at the repo root.**
