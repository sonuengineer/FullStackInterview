# RESOURCES.md — Best Existing Content (No Reinventing the Wheel)

## Minimum Viable Reading (do THIS, not everything)
Rule: **1 page per module, just-in-time.** Open docs only when a mini-exercise needs them. Total: ~18 pages, not 18 websites.

| Module | Read ONLY this |
|---|---|
| 00 | MDN HTTP overview (1 page) |
| 1 | Python asyncio HOWTO (1 page) |
| 2 | FastAPI Tutorial sections 1-6 (skip the rest) |
| 3 | AWS Skill Builder "AWS Cloud Essentials" (1 free course) |
| 4 | Docker "Get Started" (1 page) + one GitHub Actions quickstart |
| 5 | Anthropic Prompt Engineering Ch. 1-3 only |
| 6 | Pinecone RRF guide (1 page) |
| 7 | GraphAcademy Cypher Fundamentals (1 hr, free) |
| 8 | HF ColPali blog (1 post) |
| 9-10 | LangGraph quickstart + agent_supervisor.ipynb |
| 11 | Zeep "Using Zeep" (1 page) |
| 12 | oauth.net/2 spec summary (1 page) |
| 13 | Presidio "Getting Started" (1 page) |
| 14 | Langfuse "Observability Overview" (1 page) |
| 15-16 | MCP docs "Basic Overview" (1 page) |
| 17 | Skip until needed |

## Time math (why it's 5 months, not 3 years)
- 230 topics x 1-1.5 hrs (read 15 min + build 45-60 min) = ~290 hrs = 5 months at 2 hrs/day
- The 3-year trap: reading docs cover-to-cover. Docs are reference, not textbooks.
- 80% of learning happens while building the mini-exercise, not while reading.

## Use Claude Max to compress reading
- Paste a doc page into your Project: "Extract the 5 things I need for <subtopic>"
- Ask: "Give me the smallest runnable example for X"
- Never read a full doc site — query it instead



Policy: **Reuse official docs/courses for ~80% of topics. Write your own only for:**
- FDE-specific glue (discovery → SOW → ROI → UAT workflow)
- Capstone integration (OmniGuard, AuditMesh)
- Mini-exercises tailored to this curriculum
- Your own notes/flashcards

## 00 Prerequisites
- Python: https://docs.python.org/3/tutorial/ (official tutorial)
- SQL: https://www.sqlitetutorial.net/ (free, hands-on)
- Git: https://git-scm.com/book/en/v2 (Pro Git, free)
- REST/HTTP: https://developer.mozilla.org/en-US/docs/Web/HTTP

## Module 1: Python & Linux Foundations
- Python docs: https://docs.python.org/3/ (data structures, asyncio, OOP)
- asyncio: https://docs.python.org/3/library/asyncio.html
- Linux: https://linuxcommand.org/lc3_learning_the_shell.php (free)

## Module 2: Modern API Development
- FastAPI (full tutorial + testing + async): https://fastapi.tiangolo.com/
- GraphQL with Strawberry + FastAPI: https://strawberry.rocks/docs/integrations/fastapi and https://fastapi.tiangolo.com/how-to/graphql/
- pytest: https://docs.pytest.org/
- Pydantic: https://docs.pydantic.dev/

## Module 3: Cloud Fundamentals & Networking
- AWS docs: https://docs.aws.amazon.com/
- AWS Skill Builder (free digital courses): https://skillbuilder.aws/
- AWS AI security reference architecture: https://docs.aws.amazon.com/prescriptive-guidance/latest/security-reference-architecture-generative-ai/

## Module 4: Containerization & CI/CD
- Docker docs: https://docs.docker.com/
- GitHub Actions docs: https://docs.github.com/en/actions
- AWS ECS/Fargate: https://docs.aws.amazon.com/ecs/

## Module 5: LLM Fundamentals & Prompting
- Anthropic Prompt Engineering Interactive Tutorial (free, 9 chapters + exercises): https://github.com/anthropics/courses/tree/master/prompt_engineering_interactive_tutorial
- DeepLearning.AI: ChatGPT Prompt Engineering for Developers (free): https://www.deeplearning.ai/courses/chatgpt-prompt-eng
- DeepLearning.AI: Building toward Computer Use with Anthropic (prompt caching, tool use, multimodal): https://www.deeplearning.ai/courses/building-toward-computer-use-with-anthropic
- Structured outputs: https://platform.openai.com/docs/guides/structured-outputs

## Module 6: Vector Search & Core RAG
- Pinecone RRF guide: https://docs.pinecone.io/guides/search/reciprocal-rank-fusion
- Pinecone hybrid search: https://docs.pinecone.io/guides/search/hybrid-search
- Qdrant hybrid search + reranking tutorial: https://qdrant.tech/documentation/tutorials-basics/reranking-hybrid-search/
- Qdrant hybrid/multi-stage queries: https://qdrant.tech/documentation/search/hybrid-queries/
- DeepLearning.AI: Retrieval Augmented Generation (free): https://www.deeplearning.ai/courses/retrieval-augmented-generation

## Module 7: Enterprise Graph Architecture
- Neo4j GraphAcademy (free courses): Cypher Fundamentals https://graphacademy.neo4j.com/courses/cypher-fundamentals
- Neo4j Fundamentals: https://graphacademy.neo4j.com/courses/neo4j-fundamentals
- AuraDB Fundamentals: https://graphacademy.neo4j.com/courses/aura-fundamentals
- Cypher getting started: https://neo4j.com/docs/getting-started/cypher/intro-tutorial/

## Module 8: Multimodal RAG & Vision AI
- ColPali paper: https://arxiv.org/abs/2407.01449
- ViDoRe benchmark + models: https://huggingface.co/vidore
- ColPali code repo: https://github.com/illuin-tech/colpali
- HF ColPali blog (explainer): https://huggingface.co/blog/manu/colpali

## Modules 9-10: Agentic Frameworks & LangGraph / Advanced Orchestration
- LangGraph docs: https://langchain-ai.github.io/langgraph/
- Official supervisor example (notebook): https://github.com/langchain-ai/langgraph/blob/main/examples/multi_agent/agent_supervisor.ipynb
- create_supervisor API reference: https://reference.langchain.com/python/langgraph-supervisor/supervisor/create_supervisor
- LangChain OpenTutorial multi-agent structures: https://langchain-opentutorial.gitbook.io/langchain-opentutorial/17-langgraph/02-structures/09-langgraph-multi-agent-structures-02
- DeepLearning.AI: Agent Skills with Anthropic (MCP + subagents): https://www.deeplearning.ai/courses/agent-skills-with-anthropic

## Module 11: Legacy Systems & Integrations
- Zeep (SOAP) docs: https://docs.python-zeep.org/en/latest/
- SQLAlchemy: https://docs.sqlalchemy.org/
- pyodbc: https://github.com/mkleehammer/pyodbc/wiki
- oracledb: https://python-oracledb.readthedocs.io/

## Module 12: Identity & Access Management
- OAuth 2.0 spec (RFC 6749): https://oauth.net/2/
- OWASP auth cheatsheet: https://cheatsheetseries.owasp.org/
- SAML overview: https://docs.oasis-open.org/security/saml/

## Module 13: Production AI Security & Guardrails
- Microsoft Presidio docs: https://learn.microsoft.com/en-us/presidio/
- NeMo Guardrails (Colang, catalog, Presidio integration): https://docs.nvidia.com/nemo/guardrails/
- AWS Bedrock Guardrails: https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html
- OWASP Top 10 for LLM Applications: https://owasp.org/www-project-top-10-for-large-language-model-applications/

## Module 14: AI Observability & Gateway Management
- LiteLLM (gateway, evals, callbacks): https://docs.litellm.ai/
- Langfuse (tracing, evaluation, LLM-as-a-judge): https://langfuse.com/docs/observability/overview and https://langfuse.com/docs/evaluation/overview
- LangSmith: https://docs.smith.langchain.com/
- RAGAS (faithfulness, relevance, precision/recall): https://docs.ragas.io/
- DeepEval: https://docs.confident-ai.com/

## Modules 15-16: Capstones (OmniGuard, AuditMesh)
- Combine: FastAPI + Pinecone/Qdrant (M6) + Presidio/NeMo (M13) + LangGraph + MCP (M9-10) + Zeep/pyodbc (M11)
- MCP spec (for AuditMesh's Jira MCP server): https://modelcontextprotocol.io/
- MCP GitHub: https://github.com/modelcontextprotocol/modelcontextprotocol

## Module 17: Advanced & Emerging Tech (Optional)
- Kubernetes: https://kubernetes.io/docs/
- Azure AI: https://learn.microsoft.com/en-us/azure/ai-services/
- GCP Vertex AI: https://cloud.google.com/vertex-ai/docs
- Fine-tuning: https://huggingface.co/docs/transformers/training

## Free course bundles (cover multiple modules)
- DeepLearning.AAI short courses: https://www.deeplearning.ai/courses/ (RAG, prompt eng, agents, multimodal)
- Neo4j GraphAcademy: https://graphacademy.neo4j.com/
- Anthropic courses: https://github.com/anthropics/courses
- AWS Skill Builder: https://skillbuilder.aws/
