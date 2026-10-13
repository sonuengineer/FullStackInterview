# OmniGuard - Secure AI Integration

## Hybrid RAG implementation

> Deliverable 01 of 12 | Built in: Fast CP3 / Slow CP4 | Time box: 14 h
>
> **BUILD brief.** You ship this in your own repo. Learn first: [Constructing Hybrid RAG alongside secure Text-to-SQL for MS SQL databases](<../../15 - OmniGuard - Secure AI Integration/07 - Constructing Hybrid RAG alongside secure Text-to-SQL for MS SQL databases.md>).

### Goal
Answer policy-wording questions over messy enterprise PDFs with cited, measurable retrieval: BM25 + dense search, fused with RRF, reranked, and filtered by the caller's access level. The gate is an eval report, not a demo.

### Customer context (Kavach Finserv)
Kavach Finserv (fictional Pune insurer/lender) has about 3,000 SharePoint policy PDFs owned by Meera (Ops). 40 claims analysts ask questions like "Is knee surgery covered under clause 7.3(b)?". Exact IDs such as "7.3(b)" defeat pure dense search, and some PDFs are scanned or rotated. Policy wording is classified `internal`; anything above the caller's level must never reach the prompt.

### What to build
- Ingestion entry point: `python -m omniguard.ingest.run ./inbox` with a manifest (idempotent re-runs, per-file status, corrupt files do not stop the batch).
- Chunks with stable `chunk_id`, `page`, `section_path`, and ACL metadata (`tenant`, `allowed_groups`, `classification`). Missing ACL = chunk is not indexed.
- Retrieval: sparse (BM25) + dense, top-50 each, RRF fusion (`k=60` default, configurable), top-20 to a reranker, top-5 to the prompt.
- Reranker behind one `Reranker` Protocol: `stub` (default, CI), `local`, hosted. Timeout falls back to RRF order, never a 500.
- RAG path of `POST /v1/ask`. Response shape (shared by all deliverables):
  `{"answer": str, "route": "rag", "sources": ["wording#7.3b", ...], "citations": [{"doc_id", "page"}], "tools_called": [], "request_id": str}`
- Eval pipeline and report: `omniguard/evals/run_eval.py` -> `omniguard/evals/report.md`, embedded in the README "Eval report" section.

Suggested layout: `omniguard/ingest/`, `omniguard/rag/` (`hybrid.py`, `fusion.py`, `rerank.py`, `retrieve.py`), `omniguard/evals/` (`dataset.jsonl`, `manifest.json`, `run_eval.py`, `report.md`).
Config keys: `RETRIEVE_TOP_K`, `RRF_K`, `RERANK_PROVIDER`, `RERANK_TIMEOUT_MS`, `RERANK_TOP_N`, `RERANK_MAX_DOCS`.

### Inputs: lessons to (re)read
- [M06-01](<../../06 - Vector Search & Core RAG/01 - Fixed-size and semantic chunking.md>) Fixed-size and semantic chunking; [M06-05](<../../06 - Vector Search & Core RAG/05 - BM25 sparse matrices.md>) BM25 sparse matrices; [M06-08](<../../06 - Vector Search & Core RAG/08 - Metadata filtering.md>) Metadata filtering
- [M06-10](<../../06 - Vector Search & Core RAG/10 - End-to-end basic retrieval.md>) End-to-end basic retrieval; [M06-12](<../../06 - Vector Search & Core RAG/12 - Combining dense and sparse signals.md>) Combining dense and sparse signals; [M06-13](<../../06 - Vector Search & Core RAG/13 - Implementing RRF algorithms.md>) Implementing RRF algorithms
- [M06-14](<../../06 - Vector Search & Core RAG/14 - Precision and recall metrics.md>) Precision and recall metrics; [M06-15](<../../06 - Vector Search & Core RAG/15 - Cross-encoder reranking models.md>) Cross-encoder reranking models; [M06-16](<../../06 - Vector Search & Core RAG/16 - API integration for rerankers.md>) API integration for rerankers
- [M08-01](<../../08 - Multimodal RAG & Vision AI/01 - Identifying document structures.md>) Identifying document structures; [M08-02](<../../08 - Multimodal RAG & Vision AI/02 - Optical character recognition pipelines.md>) Optical character recognition pipelines; [M08-10](<../../08 - Multimodal RAG & Vision AI/10 - Ingesting unstructured legacy enterprise PDFs.md>) Ingesting unstructured legacy enterprise PDFs; [M08-11](<../../08 - Multimodal RAG & Vision AI/11 - Aligning bounding boxes with text chunks.md>) Aligning bounding boxes with text chunks
- [M14-05](<../../14 - AI Observability & Gateway Management/05 - Automating LLM-as-a-judge scoring pipelines.md>) Automating LLM-as-a-judge scoring pipelines; [M14-06](<../../14 - AI Observability & Gateway Management/06 - Calculating RAGAS faithfulness and answer relevance metrics.md>) Calculating RAGAS faithfulness and answer relevance metrics; [M14-07](<../../14 - AI Observability & Gateway Management/07 - Measuring context precision and recall.md>) Measuring context precision and recall; [M14-08](<../../14 - AI Observability & Gateway Management/08 - Creating synthetic benchmark datasets from source documents.md>) Creating synthetic benchmark datasets from source documents
- [M12-07](<../../12 - Identity & Access Management/07 - Enforcing data-level permissions in retrieval layers.md>) Enforcing data-level permissions in retrieval layers (ACL filter, needed again at CP5)
- [M15-07](<../../15 - OmniGuard - Secure AI Integration/07 - Constructing Hybrid RAG alongside secure Text-to-SQL for MS SQL databases.md>) Constructing Hybrid RAG alongside secure Text-to-SQL for MS SQL databases (the `/v1/ask` RAG cases)

### Acceptance checks
1. Ingestion run twice on the same inbox: second run reprocesses 0 files; one corrupt fixture does not fail the batch ([M08-10](<../../08 - Multimodal RAG & Vision AI/10 - Ingesting unstructured legacy enterprise PDFs.md>)).
2. Same input -> identical `chunk_id`s ([M08-11](<../../08 - Multimodal RAG & Vision AI/11 - Aligning bounding boxes with text chunks.md>)).
3. Hand-computed RRF value matches within 1e-12; ties are deterministic ([M06-13](<../../06 - Vector Search & Core RAG/13 - Implementing RRF algorithms.md>)).
4. Hybrid hit@5 is not below the better of BM25-only and dense-only on your eval set ([M06-12](<../../06 - Vector Search & Core RAG/12 - Combining dense and sparse signals.md>)).
5. Reranker only reorders candidates; timeout / 503 / malformed response still returns HTTP 200 with RRF order ([M06-15](<../../06 - Vector Search & Core RAG/15 - Cross-encoder reranking models.md>), [M06-16](<../../06 - Vector Search & Core RAG/16 - API integration for rerankers.md>)).
6. Eval set: at least 40 rows, 5 unanswerable, 5 ID-style, 15 reviewed as gold; unanswerable questions get "not found", not an invented answer ([M14-08](<../../14 - AI Observability & Gateway Management/08 - Creating synthetic benchmark datasets from source documents.md>), [M06-14](<../../06 - Vector Search & Core RAG/14 - Precision and recall metrics.md>)).
7. Report table: config | K | precision@5 | recall@5 | MRR | ctx_precision | ctx_recall | faithfulness, for dense, hybrid RRF, hybrid RRF + rerank ([M06-14](<../../06 - Vector Search & Core RAG/14 - Precision and recall metrics.md>), [M14-07](<../../14 - AI Observability & Gateway Management/07 - Measuring context precision and recall.md>)).
8. Every citation comes from the retrieved hits; no chunk from another tenant or above the caller's classification ever appears ([M06-10](<../../06 - Vector Search & Core RAG/10 - End-to-end basic retrieval.md>), [M12-07](<../../12 - Identity & Access Management/07 - Enforcing data-level permissions in retrieval layers.md>)).
9. `/v1/ask` RAG cases in the [M15-07](<../../15 - OmniGuard - Secure AI Integration/07 - Constructing Hybrid RAG alongside secure Text-to-SQL for MS SQL databases.md>) harness (`ASK_CASES`, run with `OMNIGUARD_APP=omniguard.main:app`) pass: route `rag` and the expected source id for "What does clause 7.3(b) say about knee surgery?".

### Proof for the gate
README "Eval report" section with the table from check 7, dataset version hash, git commit hash, and a one-line fallback rate for the reranker. Link to the green CI run.

### Definition of done
- All 9 checks automated in pytest and green in CI without API keys (stub embedder/reranker/judge).
- `report.md` is deterministic: same input -> same table.
- README states known weak spots (for example, which question types still fail).

### Out of scope
SQL questions and routing beyond the `rag` route (Deliverable 02), JWT verification (Deliverable 03), PII masking of chunks (Deliverable 06), GraphRAG, image/chart reasoning.

### Stretch goals
- Highlight the cited region in the PDF using `bbox_norm` citations ([M08-11](<../../08 - Multimodal RAG & Vision AI/11 - Aligning bounding boxes with text chunks.md>)).
- Sweep `RRF_K` (10, 60, 100) and minmax alpha; publish the comparison in the report.
- Track eval scores per commit and fail CI on a faithfulness regression ([M14-09](<../../14 - AI Observability & Gateway Management/09 - Tracking evaluation scores across deployment runs.md>)).

<!-- nav: generated by portal/lessonnav.py, do not edit below -->

---

[Project README](<README.md>) | [Syllabus](<../../SYLLABUS.md>) | [START_HERE](<../../START_HERE.md>)
