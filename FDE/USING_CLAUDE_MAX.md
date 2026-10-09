# Using Claude Max for the FDE Roadmap

## 1. Making content (fill the 230 subtopic .md files)
- Attach `curriculum.md` in a Project; one session = one subtopic file
- Prompt: "Fill 01 - Python & Linux Foundations/02 - Memory management fundamentals.md using the template in PLAN.md with a runnable code example and a 30-min mini-exercise"
- Use Claude Code to scaffold code snippets directly into the right folder
- Generate: definitions, diagrams (Artifact), pitfalls, checklists

## 2. Daily tasks
- Morning: "Give me today's task list for Module 6, week 2, 2-hour session"
- Evening: "Quiz me on today's 3 subtopics, then grade my answers"
- Weekly: "Review my progress vs the 5-month plan and adjust next week"

## 3. Practice projects (OmniGuard & AuditMesh)
- Claude Code as pair programmer: scaffold FastAPI app, Dockerfile, LangGraph graph, MCP server, CI workflow YAML
- Debug: paste errors; ask for root cause + fix
- Review: "Review my OmniGuard RBAC code for security flaws"
- Deploy: ask for AWS free-tier step-by-step (ECS Fargate, RDS)

## 4. Reading material
- Fetch official docs (LangGraph, MCP, Neo4j, ColPali, Presidio, LiteLLM) and summarize into module notes
- Attach papers/specs; ask for 1-page summaries + what matters for the capstone
- Turn Module 15/16 docs into SOW/ROI/UAT templates via Artifacts

## 5. Other study
- Mock interviews: "Run a 30-min FDE technical interview on RAG + security"
- Flashcards: generate 20 Q&A cards per module for review
- Code review: paste your exercise, get line-by-line feedback
- Compare options: "Pinecone vs Qdrant for OmniGuard — table"

## Max plan tips
- Use Claude Code (CLI) for repo work in H:\New folder (2)\FDE
- One Project per module keeps context clean
- Iterate: ask for revisions instead of starting over
- Prefer runnable examples; test them locally before filing away
