# Cloud Fundamentals & Networking

## Managed relational databases setup

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M03-01, M03-06

### Kahani
Ek fintech customer pe OmniGuard ko apna policy + audit data Postgres mein chahiye. Pichhle POC mein kisi ne RDS "Publicly accessible: Yes" aur master password `.env` file mein Git pe push kar diya tha. Security team ne poora account freeze kar diya.
Dusri problem demo day pe aayi: 4 app containers x 20 connections = 80, aur chhote instance ka `max_connections` limit hit hua -- "too many connections" errors, aur OmniGuard ne saare LLM requests block kar diye.
Is baar aapko DB aise setup karna hai ki security review aur load test dono pass ho.

### What it is
**Amazon RDS / Aurora PostgreSQL** managed Postgres hai: AWS patching, backups, failover sambhalta hai; aap schema, queries, sizing aur access sambhalte ho.
Sahi setup = private subnets (DB subnet group), koi public access nahi, password Secrets Manager mein, automated backups, aur app side pe sensible **connection pooling**.

### Why it matters for an FDE
DB customer ka sabse sensitive asset hai. Galat network/secret setup = security incident; galat pool size = demo ke din outage.

### Key concepts
- **DB subnet group + PubliclyAccessible=false** -- DB sirf private subnets mein, sirf app ke security group se port 5432 (M03-08).
- **Parameter group vs secrets** -- parameter group = engine settings (`max_connections`, `log_min_duration_statement`); password kabhi config mein nahi, `--manage-master-user-password` se Secrets Manager mein.
- **Backups** -- automated backups + retention days (point-in-time restore), deletion protection, final snapshot; Multi-AZ = standby for failover, read scaling nahi.
- **Connection pooling** -- app pool (SQLAlchemy `pool_size`, `max_overflow`) + zaroorat ho to **RDS Proxy** jo bahut saare clients (Lambda!) ke connections ko kam DB connections mein multiplex karta hai.
- **Connection budget** -- `replicas x (pool_size + max_overflow)` hamesha DB ke `max_connections` se kaafi kam ho (admin/migration ke liye headroom).

### Code example
`pip install sqlalchemy` (already installed; sqlite stdlib -- koi Postgres server nahi chahiye)

Block RDS config validate karta hai, env se connection URL banata hai (password log nahi hota), aur sqlite pe pool exhaustion dikhata hai.

```python
# runnable
import os, tempfile, pathlib, time
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL
from sqlalchemy.exc import TimeoutError as PoolTimeout

RDS = {"Engine": "aurora-postgresql", "PubliclyAccessible": False, "StorageEncrypted": True,
       "ManageMasterUserPassword": True, "BackupRetentionPeriod": 7,
       "DeletionProtection": True, "DBSubnetGroupName": "omniguard-private"}

def review(cfg, env="prod"):
    rules = [("PubliclyAccessible", False), ("StorageEncrypted", True),
             ("ManageMasterUserPassword", True), ("DeletionProtection", env == "prod")]
    errs = [f"{k} must be {v}" for k, v in rules if cfg.get(k) != v]
    if cfg.get("BackupRetentionPeriod", 0) < (7 if env == "prod" else 1):
        errs.append("backup retention too short")
    if "MasterUserPassword" in cfg:
        errs.append("plaintext password in config")
    return errs

def db_url_from_env() -> URL:
    # In AWS the password comes from Secrets Manager at startup, injected as env -- never from code.
    return URL.create("postgresql+psycopg", username=os.environ["DB_USER"],
                      password=os.environ["DB_PASSWORD"], host=os.environ["DB_HOST"],
                      port=int(os.environ.get("DB_PORT", "5432")), database=os.environ["DB_NAME"],
                      query={"sslmode": "require"})

def connection_budget(replicas, pool_size, max_overflow, max_connections, headroom=0.8):
    need = replicas * (pool_size + max_overflow)
    return need, need <= int(max_connections * headroom)

assert review(RDS) == []
assert len(review({**RDS, "PubliclyAccessible": True, "MasterUserPassword": "x"})) == 2

os.environ.update(DB_USER="omniguard_app", DB_PASSWORD="s3cr3t-from-sm",
                  DB_HOST="og.cluster-abc.eu-west-1.rds.amazonaws.com", DB_NAME="omniguard")
url = db_url_from_env()
shown = url.render_as_string(hide_password=True)
assert "s3cr3t" not in shown and "***" in shown
print("log-safe URL:", shown)

assert connection_budget(4, 20, 10, 100) == (120, False)    # the demo-day outage
assert connection_budget(4, 5, 5, 100) == (40, True)

with tempfile.TemporaryDirectory() as d:
    eng = create_engine(f"sqlite:///{pathlib.Path(d) / 'og.db'}", pool_size=2, max_overflow=1,
                        pool_timeout=1, pool_pre_ping=True, pool_recycle=1800)
    held = [eng.connect() for _ in range(3)]               # pool_size + max_overflow
    t0 = time.monotonic()
    try:
        eng.connect()
        raise AssertionError("4th connection should wait then fail")
    except PoolTimeout:
        print(f"pool exhausted -> TimeoutError after {time.monotonic() - t0:.1f}s")
    for c in held:
        c.close()
    with eng.connect() as c:                                # connections returned -> works again
        assert c.execute(text("select 1")).scalar() == 1
    eng.dispose()
```

- `ManageMasterUserPassword: True` -- RDS khud password Secrets Manager mein banata aur rotate karta hai; config/Terraform state mein plaintext nahi.
- `render_as_string(hide_password=True)` -- URL log karna ho to yahi; `str(url)` bhi password chhupata hai, par f-string mein khud password jodna mat.
- `sslmode=require` -- VPC ke andar bhi TLS; bahut customers ka compliance yahi maangta hai.
- `connection_budget()` -- 4 replicas x 30 = 120 > 80 (100 ka 80%) -- yahi demo-day outage tha. Autoscaling pe replicas badhenge, isliye max replicas se calculate karo.
- `pool_timeout=1` -- pool khaali ho to request hamesha ke liye latakti nahi, jaldi fail hoti hai; `pool_pre_ping` failover ke baad dead connections pakadta hai.

Asli create (customer account, unke role se):

```bash
aws rds create-db-subnet-group --db-subnet-group-name omniguard-private \
  --db-subnet-group-description "OmniGuard private" \
  --subnet-ids subnet-priv-a subnet-priv-b
aws rds create-db-cluster --db-cluster-identifier omniguard-db \
  --engine aurora-postgresql --master-username og_admin \
  --manage-master-user-password --storage-encrypted \
  --db-subnet-group-name omniguard-private --vpc-security-group-ids sg-omniguard-db \
  --backup-retention-period 7 --deletion-protection
aws rds create-db-instance --db-instance-identifier omniguard-db-1 \
  --db-cluster-identifier omniguard-db --engine aurora-postgresql \
  --db-instance-class db.t4g.medium --no-publicly-accessible
```

### Mini-exercise (30-60 min)
`omniguard/infra/db/` mein:
1. `rds_review.py` -- `review()` + `connection_budget()`; input ek JSON file jo aap customer ko bhejoge.
2. `omniguard/app/db.py` -- engine sirf env se bane (`DB_HOST`, `DB_USER`, ...), pool settings bhi env se, startup pe `render_as_string(hide_password=True)` log ho.
3. Tests: public access, plaintext password, kam retention, aur `replicas=10` pe budget fail.
4. Design doc "Database" section: subnet group, SG, backups, pool math, RDS Proxy kab lenge.

Acceptance: `pytest -q` green; `grep -ri password omniguard/` mein sirf env var naam dikhe, koi value nahi.

### Common pitfalls
- **"Bas thodi der ke liye public kar dete hain"** -- debug ke liye SSM port forwarding ya bastion use karo; public flag kabhi nahi.
- **Lambda se direct Postgres** -- har concurrent invocation naya connection; RDS Proxy ya queue ke bina `max_connections` turant khatam.
- **Backups ka restore kabhi test nahi kiya** -- retention 7 din hai par restore drill nahi hui to RTO pata hi nahi. Ek baar restore karke time note karo.

### Checklist before moving on
- [ ] DB private subnets mein, sirf app SG se 5432 allowed.
- [ ] Password Secrets Manager mein, code/config/state mein nahi.
- [ ] Pool math likha hai: replicas x (pool_size + max_overflow) vs max_connections.
- [ ] Multi-AZ aur read replica ka fark bata sakte ho.

### Related
- M03-06 Public vs private subnet routing
- M03-08 Configuring strict security groups
- M03-10 Creating identity policies
- M03-04 Event-driven serverless function basics

### Self-quiz
1. Multi-AZ on hai; kya isse read traffic scale hota hai? Failover ke time app ko kya handle karna padta hai?
2. 3 replicas, `pool_size=10`, `max_overflow=5`, autoscale max 6 replicas, DB `max_connections=150`. Safe hai? Calculation dikhao.
3. Security team puchhe "password rotate hua to app down ho jayega?" -- aapka jawab kya hai?
4. RDS Proxy kab add karoge aur kab yeh sirf extra cost aur latency hai?
