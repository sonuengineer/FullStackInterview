# Advanced Agent Orchestration

## Managed agent provisioning

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M03-09, M04-09, M10-01

### Kahani
Ek bank ka platform team bola: "Hum apna LangGraph server, checkpoint Postgres aur sandbox khud nahi chalayenge. Hamara cloud vendor 'managed agents' deta hai -- wahi use karo."
FDE ne console mein click karke agent bana diya: model, instructions, teen tools. Demo chal gaya. Do hafte baad UAT aur prod mein alag instructions nikle, kisi ne prod agent pe `delete_account` tool bhi attach kar diya tha, aur session timeout 1 ghanta tha jabki bank policy 15 minute kehti hai.
Kisi ko nahi pata tha kis version ne kya badla. "ClickOps" agent ka koi code review, rollback ya audit nahi tha.

### What it is
**Managed agent provisioning** = vendor ke hosted agent platform pe agent (model, instructions, tools, guardrails, limits, session settings) ko **config-as-code** se banana aur update karna -- validated YAML/JSON -> plan (diff) -> apply via SDK/API/IaC, har environment ke liye same pipeline.
Platform agent loop, tool execution sandbox, session state aur tracing host karta hai; tum config aur policies own karte ho.

### Why it matters for an FDE
Enterprise customers aksar apne cloud ke managed service pe hi agent chalana chahte hain (procurement, data residency, existing contracts). FDE ka kaam: vendor choose karne mein trade-offs batana, aur provisioning ko reviewable, repeatable aur least-privilege banana.

### Key concepts
- **What you get** -- hosted loop, built-in tools/code sandbox, managed sessions/memory, tracing, scaling; kam infra.
- **What you give up** -- loop pe fine control (custom interrupts, guards), portability (vendor lock-in), kabhi kabhi model choice aur region; debugging vendor ke tools tak simit.
- **Config-as-code** -- agent definition git mein, PR review, CI validation, per-env overlays (dev/uat/prod).
- **Plan before apply** -- desired vs current ka diff dikhao; idempotent apply (same config = no-op).
- **Secrets by reference** -- config mein `secret_ref: vault://...`, kabhi literal key nahi.

| Platform (check current docs -- these evolve fast) | Typical shape | Good fit when |
|---|---|---|
| Anthropic (Claude Managed Agents) | Hosted agent loop with managed sandbox and sessions | Claude-first teams wanting Claude Code-style tools without running infra |
| AWS Bedrock Agents / AgentCore | Agents + action groups (Lambda/OpenAPI), knowledge bases, IAM roles | Customer is AWS-native, needs IAM + VPC + CloudTrail |
| Azure AI Foundry Agent Service | Agents with tools, threads, Azure identity + networking | Microsoft shop, Entra ID, Azure data residency |
| OpenAI (Responses API / Agents platform) | Hosted tools (search, files, code), agent builder tooling | OpenAI-model-first, fast prototyping |
| Self-hosted (LangGraph etc.) | You run loop, checkpoints, workers | Need custom HITL, guards, multi-vendor models |

### Code example
`pip install pyyaml pydantic`

```python
# runnable
import re
import yaml
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

TOOL_REGISTRY = {"search_policies": "read", "get_ticket": "read", "create_ticket": "write", "delete_account": "admin"}
SECRET_LIKE = re.compile(r"(sk-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN)")

class Limits(BaseModel):
    model_config = ConfigDict(extra="forbid")
    max_turns: int = Field(ge=1, le=30)
    max_output_tokens: int = Field(ge=256, le=16000)
    session_ttl_minutes: int = Field(ge=1, le=240)

class AgentSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(pattern=r"^[a-z][a-z0-9-]{2,40}$")
    env: Literal["dev", "uat", "prod"]
    model_env: str = Field(pattern=r"^[A-Z_]+$")           # name of an env var, never a hardcoded id
    instructions_file: str
    tools: list[str]
    guardrails: list[str] = []
    approval_required_for: list[str] = []
    limits: Limits
    @model_validator(mode="after")
    def policy(self):
        if set(self.tools) - TOOL_REGISTRY.keys():
            raise ValueError(f"unknown tools: {sorted(set(self.tools) - TOOL_REGISTRY.keys())}")
        kinds = {t: TOOL_REGISTRY[t] for t in self.tools}
        if "admin" in kinds.values():
            raise ValueError("admin tools cannot be attached to an agent")
        writes = {t for t, k in kinds.items() if k == "write"}
        if self.env == "prod":
            if not writes <= set(self.approval_required_for):
                raise ValueError(f"prod write tools need approval: {sorted(writes - set(self.approval_required_for))}")
            if "pii_filter" not in self.guardrails or self.limits.session_ttl_minutes > 15:
                raise ValueError("prod needs pii_filter and session_ttl_minutes <= 15")
        return self

def load(text):
    if SECRET_LIKE.search(text):
        raise ValueError("literal secret found in agent config; use a secret reference")
    return AgentSpec.model_validate(yaml.safe_load(text))

def plan(desired: AgentSpec, current: dict | None):
    want = desired.model_dump()
    if current is None:
        return [("create", desired.name)]
    return [("update", k) for k in sorted(want) if want[k] != current.get(k)]

GOOD = """
name: auditmesh-evidence
env: prod
model_env: LLM_MODEL
instructions_file: prompts/evidence.md
tools: [search_policies, get_ticket, create_ticket]
guardrails: [pii_filter, prompt_injection_scan]
approval_required_for: [create_ticket]
limits: {max_turns: 12, max_output_tokens: 2000, session_ttl_minutes: 15}
"""
spec = load(GOOD)
assert plan(spec, None) == [("create", "auditmesh-evidence")] and plan(spec, spec.model_dump()) == []  # idempotent
drifted = {**spec.model_dump(), "tools": ["search_policies", "get_ticket", "create_ticket", "delete_account"]}
assert plan(spec, drifted) == [("update", "tools")]                 # console drift caught
bad_cases = {"need approval": GOOD.replace("approval_required_for: [create_ticket]", "approval_required_for: []"),
             "admin tools": GOOD.replace("create_ticket]\nguard", "create_ticket, delete_account]\nguard"),
             "session_ttl": GOOD.replace("session_ttl_minutes: 15", "session_ttl_minutes: 60"),
             "literal secret": GOOD + "api_key: sk-abcdefghijklmnop\n"}
for expected, text in bad_cases.items():
    try:
        load(text)
        msg = "ACCEPTED"
    except ValidationError as e:
        msg = e.errors()[0]["msg"]
    except ValueError as e:
        msg = str(e)
    print("rejected:", msg[:90])
    assert expected in msg, msg
print("OK: agent config validated, drift detected, unsafe configs rejected")
```

- `model_env` sirf env var ka naam -- model id per-environment inject hota hai, config mein hardcode nahi.
- `policy()` validator customer ki policy ko code banata hai: unknown tools, admin tools, prod write tools bina approval, TTL > 15 min -- sab CI mein fail.
- `SECRET_LIKE` raw text pe check -- YAML parse se pehle; literal key PR tak pahunchni hi nahi chahiye.
- `plan()` -- live agent (console se drift hua `delete_account`) vs git config ka diff; apply step sirf ye diff push kare.
- Validator vendor-neutral hai; apply step har vendor ke SDK/IaC se alag hoga.

```python
# real version -- not run here, needs: pip install boto3 (AWS Bedrock Agents example)
# Check the current AWS docs for parameter names; never run this without the customer's approval.
import boto3, os
client = boto3.client("bedrock-agent", region_name=os.environ["AWS_REGION"])
resp = client.create_agent(agentName=spec.name, foundationModel=os.environ[spec.model_env],
                           instruction=open(spec.instructions_file).read(),
                           agentResourceRoleArn=os.environ["AGENT_ROLE_ARN"],
                           idleSessionTTLInSeconds=spec.limits.session_ttl_minutes * 60)
client.prepare_agent(agentId=resp["agent"]["agentId"])
```

### Mini-exercise (30-60 min)
`fde-exercises/m10_provisioning/`: AuditMesh ke 3 agents (supervisor, evidence, ticketing) ke liye `agents/*.yaml` + `envs/{dev,prod}.yaml` overlays.
- `provision.py validate` -- saare configs validate; `provision.py plan --current current.json` -- diff print, exit 1 agar drift hai.
- GitHub Actions job (M04) jo PR pe `validate` chalaye.
- Acceptance: prod overlay mein write tool bina approval -> CI red; same config dobara plan -> empty diff; literal key -> red.

### Common pitfalls
- Console mein click karke prod agent banana -- drift, koi review nahi, koi rollback nahi.
- Managed platform ko "security included" maan lena -- tool permissions, data access aur approval policy phir bhi tumhari zimmedari hai.
- Vendor feature pe poora design tika dena bina exit plan ke -- tools ko MCP/OpenAPI jaise portable interface pe rakho (M10-10).

### Checklist before moving on
- [ ] Managed vs self-hosted agent ke 3 gains aur 3 losses bata sakta hoon.
- [ ] Agent config git mein hai aur CI mein validate hota hai.
- [ ] Plan/diff step drift pakadta hai, same config pe no-op.
- [ ] Config mein koi literal secret ya hardcoded model id nahi.

### Related
- M10-09 Connecting agents to external tools safely
- M10-11 Standardizing tool access boundaries
- M10-12 Vendor agent SDKs (Claude Agent SDK and OpenAI Agents SDK)
- M13-12 Setting up AWS Bedrock managed guardrail configurations via Boto3
- M12-09 API keys vs service accounts

### Self-quiz
1. Bank ko custom HITL chahiye jahan approval 2 din tak pending reh sake. Managed platform choose karne se pehle kya verify karoge?
2. Console drift detect hua. Auto-overwrite karoge ya alert? Dono ke risks batao.
3. Data residency (India region only) requirement provisioning config mein kaise express aur enforce karoge?
4. Vendor lock-in kam karne ke liye kaunse do design choices aaj hi kar sakte ho?
