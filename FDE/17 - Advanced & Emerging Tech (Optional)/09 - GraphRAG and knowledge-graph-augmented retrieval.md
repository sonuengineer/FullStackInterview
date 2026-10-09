# Advanced & Emerging Tech (Optional)

## GraphRAG and knowledge-graph-augmented retrieval

> Core | Fast CP6 / Slow CP5 | ~1.2 h | Builds on: M06-10, M06-13 (and M07-01 on the slow track)

### Kahani
Logistics customer ka RAG bot demo mein mast chal raha tha -- "SH-101 kahan hai?" turant answer. Phir ops head ne poocha: "Which suppliers of our delayed shipments also have open compliance tickets?"
Bot ne do policy documents quote kar diye aur bola "I could not find specific suppliers." Data toh corpus mein tha -- ek chunk mein "SH-101 delayed, supplier Acme Steel", doosre mein "Ticket CT-9 open against Acme Steel".
Problem: answer kisi ek chunk mein nahi hai. Do chunks ko ek **relationship** (Acme Steel) jodta hai, aur vector search relationships follow nahi karta. Yahin graph ki zaroorat aati hai.

### 20-minute graph refresher
Fast track pe Module 7 skip hai, toh pehle basics (slow track: M07-01, M07-05 mein detail hai).
- **Node** -- ek cheez: Customer, Order, Supplier. **Label** = uska type (`:Customer`), ek node pe multiple labels ho sakte hain.
- **Edge (relationship)** -- do nodes ke beech directed, typed connection: `(c)-[:PLACED]->(o)`. SQL ka foreign key + join, lekin stored as first-class data.
- **Properties** -- key-value pairs nodes aur edges dono pe: `{name: "Asha", status: "delayed"}`.
- **Path** -- nodes aur edges ki chain: `Shipment -> Supplier <- Ticket`. Path ki length = hops. "2-hop question" = answer tak pahunchne ke liye 2 edges chalne padte hain.
- **Why graph DB?** -- SQL mein 3-4 level joins mehenge aur likhne mushkil; graph DB har node se uske neighbours seedha follow karta hai (index-free adjacency).
Cypher (Neo4j ki query language) mein ASCII-art jaisa pattern likhte ho:
```cypher
MATCH (c:Customer)-[:PLACED]->(o:Order)
RETURN c.name, count(o)
```


Padho aise: "har Customer node `c` jo PLACED edge se Order node `o` se juda hai -- uska naam aur order count do." `count()` automatically `c.name` pe group karta hai (SQL ke GROUP BY jaisa).

### What it is
**GraphRAG** = retrieval mein knowledge graph use karna. Chunks se entities/relations extract karke graph banao, question ke entities graph mein dhoondo (**entity linking**), k hops expand karo, visited nodes se jude chunks LLM ko do.
Doosra flavour **Microsoft-style GraphRAG**: poore graph pe community detection + har community ka LLM summary, taaki "global" questions ("main themes kya hain?") answer ho sakein.

### Why it matters for an FDE
Enterprise questions aksar relationships pe hote hain (supplier-shipment-ticket, patient-doctor-drug, account-transaction-alert). Vector-only RAG yahan confidently adhoora answer deta hai -- aur customer ka trust wahin toot-ta hai.

### Key concepts
- **Multi-hop failure** -- vector search "jo question jaisa dikhe" laata hai; jo chunk sirf beech ke entity se juda hai (CT-9 ticket) woh question jaisa nahi dikhta.
- **Extraction** -- LLM har chunk se `{entities, relations}` JSON nikaalta hai; har entity ke saath source chunk ids store karo (provenance).
- **k-hop expansion** -- seeds se BFS, depth k (usually 1-2); zyada hops = noise aur token cost explode.
- **Fusion** -- graph chunks aur vector chunks ko RRF (M06-13) se merge karo; graph relationships laata hai, vector paraphrase/semantic.
- **Community summaries** -- graph ko clusters mein todo (Leiden algorithm), har cluster ka summary pehle se likhwa lo; global question pe summaries ka map-reduce.

### Code example
stdlib only

```python
# runnable
import json
import math
import re
from collections import Counter, defaultdict, deque

CHUNKS = {
    "c0": "Shipment SH-101 is delayed at Mumbai port. Supplier: Acme Steel.",
    "c1": "Shipment SH-102 is delayed in customs. Supplier: Borak Metals.",
    "c2": "Shipment SH-103 arrived on time. Supplier: Cyan Plastics.",
    "c3": "Ticket CT-9 is open against Acme Steel: missing ISO certificate.",
    "c4": "Ticket CT-8 is closed against Borak Metals: label format fixed.",
    "c5": "Ticket CT-10 is open against Cyan Plastics: late audit report.",
    "d1": "Policy: delayed shipments must be reported to suppliers within 24 hours.",
    "d2": "Policy: open compliance tickets block new orders for suppliers.",
    "d3": "FAQ: suppliers can raise compliance tickets for delayed shipments in the portal.",
}
Q = "Which suppliers of our delayed shipments also have open compliance tickets?"

class FakeLLM:
    """Stands in for an LLM extraction call (client.messages.create with a JSON schema).
    Regexes instead of a model, but the same output shape: a JSON string."""
    def extract(self, text):
        ents, rels = [], []
        if m := re.search(r"Shipment (SH-\d+) is (delayed|arrived on time).*Supplier: (\w+ \w+)", text):
            ents += [{"id": m[1], "label": "Shipment", "status": "delayed" if m[2] == "delayed" else "on_time"},
                     {"id": m[3], "label": "Supplier"}]
            rels.append([m[1], "SUPPLIED_BY", m[3]])
        if m := re.search(r"Ticket (CT-\d+) is (open|closed) against (\w+ \w+)", text):
            ents += [{"id": m[1], "label": "Ticket", "status": m[2]}, {"id": m[3], "label": "Supplier"}]
            rels.append([m[1], "FILED_AGAINST", m[3]])
        return json.dumps({"entities": ents, "relations": rels})

# --- build the in-memory graph: nodes, adjacency, node -> source chunks ---
nodes, adj, node_chunks = {}, defaultdict(set), defaultdict(set)
llm = FakeLLM()
for cid, text in CHUNKS.items():
    out = json.loads(llm.extract(text))
    for e in out["entities"]:
        nodes.setdefault(e["id"], {}).update(e)
        node_chunks[e["id"]].add(cid)
    for src, rel, dst in out["relations"]:
        adj[src].add((rel, dst))
        adj[dst].add((rel, src))  # traverse both directions

def link_entities(q):  # prod: LLM extracts entities/filters from the question
    seeds = {n for n in nodes if n.lower() in q.lower()}
    if "delayed" in q.lower() and "shipment" in q.lower():
        seeds |= {n for n, p in nodes.items() if p["label"] == "Shipment" and p.get("status") == "delayed"}
    return seeds

def k_hop(seeds, k=2):
    dist, queue = {s: 0 for s in seeds}, deque(seeds)
    while queue:
        n = queue.popleft()
        if dist[n] < k:
            for _, nb in sorted(adj[n]):
                if nb not in dist:
                    dist[nb] = dist[n] + 1
                    queue.append(nb)
    return dist

def graph_retrieve(q, k=2):
    best = {}
    for n, d in k_hop(link_entities(q), k).items():
        for c in node_chunks[n]:
            best[c] = min(d, best.get(c, d))
    return sorted(best, key=lambda c: (best[c], c))

# --- toy vector search: bag-of-words cosine (stands in for embeddings) ---
def vec(t):
    return Counter(w.rstrip("s") for w in re.findall(r"[a-z0-9-]+", t.lower()))
def cosine(a, b):
    dot = sum(a[w] * b[w] for w in a)
    return dot / (math.sqrt(sum(v * v for v in a.values())) * math.sqrt(sum(v * v for v in b.values())) or 1)
def vector_retrieve(q, k=3):
    return sorted(CHUNKS, key=lambda c: -cosine(vec(q), vec(CHUNKS[c])))[:k]

def rrf(*rankings, k=60):  # M06-13
    score = defaultdict(float)
    for r in rankings:
        for i, d in enumerate(r):
            score[d] += 1 / (k + i + 1)
    return sorted(score, key=lambda d: -score[d])

vec_hits, graph_hits = vector_retrieve(Q), graph_retrieve(Q)
fused = rrf(graph_hits, vector_retrieve(Q, k=5))
suppliers = {nb for s in link_entities(Q) for rel, nb in adj[s] if rel == "SUPPLIED_BY"}
answer = sorted(s for s in suppliers
                if any(r == "FILED_AGAINST" and nodes[t]["status"] == "open" for r, t in adj[s]))
print("vector top-3:", vec_hits, "| graph:", graph_hits)
print("fused (RRF):", fused[:6], "| answer:", answer)

assert "c3" not in vec_hits                  # vector misses the 2-hop evidence (ticket chunk)
assert "c3" in graph_hits and "c5" not in graph_hits   # graph finds it; Cyan (on-time) not reached
assert "c3" in fused[:6] and "d3" in fused[:6]         # fusion keeps both signals
assert answer == ["Acme Steel"]
print("OK: 2-hop question answered by graph expansion, missed by vector search")
```

- `FakeLLM.extract` -- real version mein yeh LLM call hai (M08 structured outputs); output shape same: `{"entities": [...], "relations": [[src, REL, dst]]}`.
- `node_chunks` -- provenance: har node yaad rakhta hai kis chunk se aaya. Isi se LLM ko citation-wale chunks milte hain, sirf graph facts nahi.
- `k_hop` -- plain BFS with depth limit. SH-101 -> Acme Steel (hop 1) -> CT-9 (hop 2). Cyan Plastics kabhi visit nahi hota kyunki uska shipment on-time hai.
- `vector_retrieve` -- policy/FAQ chunks question ke words se zyada match karte hain, isliye top-3 mein woh aate hain, CT-9 wala chunk nahi. Real embeddings mein bhi yahi pattern dikhta hai. `rrf` (M06-13) dono lists ko bina score-scale tension ke jodta hai.

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY) for extraction, plus a graph DB.

```python
# real version -- not run here, needs: pip install neo4j
import os
from neo4j import GraphDatabase

CYPHER = """
MATCH (s:Shipment {status: $status})-[:SUPPLIED_BY]->(sup:Supplier)<-[:FILED_AGAINST]-(t:Ticket {status: 'open'})
RETURN sup.name AS supplier, collect(DISTINCT t.id) AS tickets, collect(DISTINCT s.chunk_id) AS chunks
"""
driver = GraphDatabase.driver(os.environ["NEO4J_URI"],
                              auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
with driver:
    records, summary, keys = driver.execute_query(CYPHER, status="delayed", database_="neo4j")
    for r in records: print(r["supplier"], r["tickets"], r["chunks"])
# Use parameters ($status), never f-string user text into Cypher (injection). Free option: Neo4j AuraDB free tier. AWS option: Amazon Neptune (openCypher/Gremlin). Check the docs for limits.
```

**Microsoft-style GraphRAG (concept only):** poore corpus pe extraction -> graph -> community detection (Leiden) -> har community ka LLM summary, kai levels pe. Global question ("top 5 supplier risks across all regions?") pe summaries pe map-reduce hota hai. Cost warning: indexing = har chunk pe LLM call + summaries; bade corpus pe yeh vector indexing se kai guna mehenga hai. Pehle 1-5% sample pe cost measure karo. Library ka current CLI/config badalta rehta hai -- check the docs (github.com/microsoft/graphrag).

**When NOT to use GraphRAG:** FAQ bot, policy QA, "manual mein kya likha hai" -- yeh single-chunk questions hain; hybrid + rerank (M06-12, M06-15) kaafi hai. Graph tab lao jab eval set (M06-10) mein multi-hop/relationship questions consistently fail ho rahe hon. Agar data already SQL tables mein structured hai, text-to-SQL ya ek normal join zyada sasta ho sakta hai.

### Mini-exercise (30-60 min)
`fde-exercises/graphrag/` mein:
- `extract.py` -- 10 hand-written logistics chunks, FakeLLM extractor, graph as dicts with source chunk ids. `retrieve.py` -- `graph_retrieve(q, k)`, `vector_retrieve(q, k)`, `hybrid(q)` via RRF; response mein har chunk ke saath `{"source": "graph"|"vector", "hops": n}`.
- `eval.py` -- 6 questions: 3 single-hop, 3 two-hop; recall@5 table for vector vs hybrid. Acceptance: pytest -- hybrid two-hop recall > vector; single-hop recall vector se kam nahi; k=3 pe chunk count print karke dekho noise kitna badha.

### Common pitfalls
- Entity resolution bhool gaye -- "Acme Steel", "ACME Steel Ltd", "Acme" teen alag nodes ban gaye, aur 2-hop path toot gaya. Extraction ke baad normalise/merge step chahiye.
- Pura corpus ek saath LLM extraction pe bhej diya -- bill aur rate limits (M08) dono phat gaye. Sample, cache, batch, aur retries with backoff.
- Graph traversal mein tenant/ACL filter nahi lagaya -- hop karte-karte doosre customer ke node pe pahunch gaye (M12-07).

### Checklist before moving on
- [ ] Node, edge, label, property, path apne words mein bata sakta hoon aur ek simple Cypher MATCH padh sakta hoon.
- [ ] Vector RAG multi-hop pe kyun fail hota hai, example se samjha sakta hoon.
- [ ] Extraction -> graph -> entity linking -> k-hop -> chunks -> RRF fusion ka flow likh sakta hoon.
- [ ] Community-summary GraphRAG kab chahiye, uska cost risk, aur kab GraphRAG NAHI chahiye -- customer ko bata sakta hoon.

### Related
- M06-10 End-to-end basic retrieval
- M06-12 Combining dense and sparse signals
- M06-13 Implementing RRF algorithms
- M07-01 Nodes, edges, and properties (slow track)

### Self-quiz
1. "Which suppliers of delayed shipments have open tickets?" pe vector search ka top-3 kyun galat tha, jabki data corpus mein tha?
2. k=1 aur k=3 hops pe is example mein kya badlega? Production mein k kaise choose karoge?
3. Entity resolution na ho to graph retrieval kaise fail hota hai? Ek example do.
4. Customer kehta hai "hamare 2 lakh PDFs pe GraphRAG lagao". Aap pehle kya measure karoge aur kyun?
