# Vector Search & Core RAG

## Cloud vector database provisioning

> Core | Fast CP3 / Slow CP4 | ~1.2 h | Builds on: M06-06, M06-07, M06-08

### Kahani
German manufacturing customer ke saath kickoff call. IT security lead ka pehla sawaal: "Vectors kahan store honge? Kaunsa region? Kaun delete kar sakta hai? Backup?"
Aapke POC mein Pinecone index kisi ne console pe click karke banaya tha -- us-east-1 mein, dimension 1536, jabki ab aap 384-dim model use kar rahe ho. Na koi config file, na review.
Ab production index "properly" banana hai: sahi region (EU data residency), sahi dim/metric, tenant filter index, aur config jo Git mein review ho sake.

### What it is
**Provisioning** = vector DB resource (index/collection/table) create karna sahi settings ke saath: provider, region, dimension, metric, ANN params, replicas, filter indexes, deletion protection.
Settings ko **config as code** rakho (YAML/JSON, Git mein), CI mein validate karo, aur ek script/Terraform se apply karo -- console clicks se nahi.

### Why it matters for an FDE
Dim, metric aur region aksar baad mein badal nahi sakte -- galat ho to re-index aur migration. Enterprise security review region, encryption, network access aur deletion policy poochega; jawab ek reviewed config file hona chahiye.

### Key concepts
- **Immutable-ish settings** -- dimension aur metric create time pe fix; badalna = naya index + full re-embed.
- **Data residency** -- region customer contract se aata hai; config validation mein enforce karo, yaad pe nahi.
- **Sizing** -- vectors x dim x 4 bytes + index overhead, x replicas; ye estimate cost aur tier choose karta hai.
- **Environments** -- `-dev`, `-staging`, `-prod` alag indexes; prod pe deletion protection aur restricted API keys.
- **Dry-run plan** -- create se pehle exact request print/review karo, jaise `terraform plan`.

### Options at a glance

| Option | You manage | Strengths | Watch out for | Good when |
|---|---|---|---|---|
| Pinecone (serverless) | Almost nothing | Zero ops, namespaces for tenants, fast start | Vendor lock-in, limited region list, cost at high QPS | Small team, customer OK with SaaS |
| Qdrant Cloud (or self-hosted) | Cluster size; all infra if self-hosted | Rich payload filters, HNSW knobs exposed, open-source escape hatch | Self-hosting = backups, upgrades, monitoring are yours | Heavy filtering, may need VPC/on-prem later |
| pgvector (RDS/Aurora/Cloud SQL) | A Postgres DB | Vectors next to relational data, SQL joins, existing backups/IAM | Tuning at many millions of vectors, index build RAM | Customer already runs Postgres, moderate scale |

Numbers, limits and regions change often -- check each provider's current docs and pricing before quoting a customer.

### Code example
In the repo the YAML lives in `config/vector_index.dev.yaml`; here it is inlined so the block is self-contained.

`pip install pydantic pyyaml`

```python
# runnable
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

CONFIG_YAML = """
name: omniguard-chunks-dev
provider: qdrant            # qdrant | pinecone | pgvector
region: eu-central-1        # customer contract: EU data residency
embedding_model: all-MiniLM-L6-v2
dim: 384
metric: cosine
hnsw: {m: 16, ef_construction: 128}
replicas: 1
payload_indexes: [tenant, doc_type]
expected_vectors: 2000000
deletion_protection: true
"""

KNOWN_MODEL_DIMS = {"all-MiniLM-L6-v2": 384, "text-embedding-3-small": 1536, "bge-base-en-v1.5": 768}
ALLOWED_REGIONS = {"eu-central-1", "eu-west-1"}          # from the customer's data-residency clause

class Hnsw(BaseModel):                                    # HNSW knobs from M06-06
    m: int = Field(16, ge=4, le=64)
    ef_construction: int = Field(128, ge=16, le=1024)

class IndexConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(pattern=r"^[a-z0-9-]{3,45}$")
    provider: Literal["qdrant", "pinecone", "pgvector"]
    region: str
    embedding_model: str
    dim: int = Field(gt=0)
    metric: Literal["cosine", "dot", "euclidean"]
    hnsw: Hnsw = Hnsw()
    replicas: int = Field(1, ge=1, le=5)
    payload_indexes: list[str] = ["tenant"]
    expected_vectors: int = Field(gt=0)
    deletion_protection: bool = True

    @model_validator(mode="after")
    def check(self):
        if self.region not in ALLOWED_REGIONS:
            raise ValueError(f"region {self.region} violates data residency")
        want = KNOWN_MODEL_DIMS.get(self.embedding_model)
        if want and want != self.dim:
            raise ValueError(f"dim {self.dim} != {want} for {self.embedding_model}")
        if "tenant" not in self.payload_indexes:              # multi-tenant filter needs an index
            raise ValueError("tenant must be a payload index")
        return self

def estimate_gb(cfg: IndexConfig):
    raw = cfg.expected_vectors * cfg.dim * 4                 # float32
    graph = cfg.expected_vectors * cfg.hnsw.m * 2 * 4        # rough HNSW link overhead
    return round((raw + graph) * cfg.replicas / 1e9, 2)

def plan(cfg: IndexConfig) -> dict:
    """Dry run: the request each provider WOULD receive. Nothing is created here."""
    if cfg.provider == "qdrant":
        return {"collection_name": cfg.name,
                "vectors_config": {"size": cfg.dim, "distance": {"cosine": "Cosine", "dot": "Dot", "euclidean": "Euclid"}[cfg.metric]},
                "hnsw_config": {"m": cfg.hnsw.m, "ef_construct": cfg.hnsw.ef_construction},
                "payload_indexes": cfg.payload_indexes}
    if cfg.provider == "pinecone":
        return {"name": cfg.name, "dimension": cfg.dim,
                "metric": {"dot": "dotproduct"}.get(cfg.metric, cfg.metric),
                "spec": {"serverless": {"cloud": "aws", "region": cfg.region}},
                "deletion_protection": "enabled" if cfg.deletion_protection else "disabled"}
    return {"migration": "pgvector is plain Postgres DDL -- see the SQL block below"}

cfg = IndexConfig.model_validate(yaml.safe_load(CONFIG_YAML))
print("valid config:", cfg.name, cfg.provider, cfg.region, f"~{estimate_gb(cfg)} GB")
for p in ["qdrant", "pinecone", "pgvector"]:
    print(p, "->", plan(cfg.model_copy(update={"provider": p})))

bad_cases = {"wrong dim": {"dim": 1536}, "US region": {"region": "us-east-1"}, "typo field": {"metrc": "cosine"}}
for label, patch in bad_cases.items():
    try:
        IndexConfig.model_validate({**yaml.safe_load(CONFIG_YAML), **patch})
        raise AssertionError(f"{label} should fail")
    except ValidationError as e:
        print(f"rejected ({label}):", e.errors()[0]["msg"][:70])

assert plan(cfg)["vectors_config"]["size"] == 384
assert 3.0 < estimate_gb(cfg) < 3.5
print("OK: config validated and planned; no cloud resource was created")
```

- `IndexConfig` with `extra="forbid"` -- `metrc` jaisa typo silently ignore nahi hota; CI mein fail.
- `model_validator` -- teen business rules: region data-residency list mein, dim model se match, tenant payload index present (M06-08).
- `estimate_gb` -- 20 lakh x 384 x 4 bytes ~ 3 GB + graph overhead; rough hai, lekin sizing call mein order-of-magnitude yahi chahiye.
- `plan()` -- provider-specific request body banata hai, create nahi karta. Review ke baad hi real client call (neeche).

```python
# real version -- not run here, needs: pip install qdrant-client pinecone   (check the docs for your SDK version)
import os
from qdrant_client import QdrantClient, models
from pinecone import Pinecone, ServerlessSpec

p = plan(cfg)
if cfg.provider == "qdrant":
    qc = QdrantClient(url=os.environ["QDRANT_URL"], api_key=os.environ["QDRANT_API_KEY"], timeout=30)
    if not qc.collection_exists(cfg.name):                                     # idempotent
        qc.create_collection(cfg.name,
            vectors_config=models.VectorParams(size=cfg.dim, distance=models.Distance.COSINE),
            hnsw_config=models.HnswConfigDiff(m=cfg.hnsw.m, ef_construct=cfg.hnsw.ef_construction))
        for field in cfg.payload_indexes:
            qc.create_payload_index(cfg.name, field_name=field, field_schema="keyword")
elif cfg.provider == "pinecone":
    pc = Pinecone(api_key=os.environ["PINECONE_API_KEY"])
    if not pc.has_index(cfg.name):
        pc.create_index(name=cfg.name, dimension=cfg.dim, metric=p["metric"],
                        spec=ServerlessSpec(cloud="aws", region=cfg.region),
                        deletion_protection=p["deletion_protection"])
```

```sql
-- pgvector: a migration file, applied like any other schema change
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS omniguard_chunks_dev (
  id text PRIMARY KEY, tenant text NOT NULL, doc_type text, embedding vector(384) NOT NULL);
CREATE INDEX IF NOT EXISTS chunks_tenant_idx ON omniguard_chunks_dev (tenant);
CREATE INDEX IF NOT EXISTS chunks_hnsw_idx ON omniguard_chunks_dev
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 128);
```

> Needs keys for the real version: QDRANT_URL + QDRANT_API_KEY or PINECONE_API_KEY (from a secrets manager, never in the YAML).

### Mini-exercise (30-60 min)
`omniguard/config/vector_index.{dev,prod}.yaml` + `scripts/provision_index.py`.
- `--dry-run` (default) sirf validated plan aur size estimate print kare; `--apply` tabhi chale jab env var `CONFIRM_ENV` config ke env se match kare.
- CI step: dono YAML files validate (pytest); prod config mein `deletion_protection: true` aur `replicas >= 2` mandatory.
- README mein provider choice ki 3-line justification, upar wali table ke format mein, apne customer ke constraints ke saath.
- Acceptance: tests -- wrong dim, disallowed region, unknown field teeno fail; `--apply` bina confirm ke non-zero exit. Real resource banana zaroori nahi (free tier optional, apne account mein).

### Common pitfalls
- API key YAML mein ya repo mein -- config non-secret rakho, keys secrets manager/env se.
- Create script idempotent nahi -- doosri baar chalaya to crash ya duplicate; pehle "exists?" check.
- Dev aur prod ek hi index, sirf `tenant=test` se alag -- ek galat delete-by-filter aur prod data gaya.

### Checklist before moving on
- [ ] Teeno options ka trade-off customer ko 2 minute mein samjha sakta hoon.
- [ ] Index config Git mein hai aur CI mein validate hota hai.
- [ ] Region, dim, metric aur tenant index validation rules mein enforce hain.
- [ ] Provisioning script dry-run default aur idempotent hai.

### Related
- M03-03 Managed relational databases setup
- M06-06 Index creation
- M06-08 Metadata filtering
- M06-10 End-to-end basic retrieval
- M12-09 API keys vs service accounts

### Self-quiz
1. POC index 1536-dim tha, ab model 384-dim hai. Kya options hain aur cost kya hai?
2. Customer EU data residency maangta hai. Config validation ke alawa aur kya check karoge?
3. 50 lakh chunks, 768 dims, 2 replicas -- rough RAM estimate karo.
4. Customer pehle se Aurora Postgres chalata hai, 3M chunks. Pinecone ya pgvector -- kya recommend karoge aur kyun?
