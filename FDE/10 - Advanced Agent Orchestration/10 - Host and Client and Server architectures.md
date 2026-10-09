# Advanced Agent Orchestration

## Host/Client/Server architectures

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M10-09, M05-11

### Kahani
Ek SaaS customer ke paas teen AI surfaces hain: internal chat app, developers ka IDE assistant, aur AuditMesh agent. Teeno ko Jira chahiye.
Teen teams ne teen alag Jira integrations likhi -- alag auth, alag tool names (`create_ticket`, `jira_create`, `newIssue`), alag bugs. Jira ne API field rename kiya to teeno ek saath toote, teen alag fixes.
Customer ka architect bola: "Mujhe Jira capability ek baar banani hai, ek jagah secure karni hai, aur har AI app use plug kare -- jaise USB." Yahi problem **MCP (Model Context Protocol)** solve karta hai.

### What it is
**MCP** ek open protocol hai jisme teen roles hain: **host** (AI application -- Claude Desktop, IDE, tumhara agent app), **client** (host ke andar, har server ke liye ek 1:1 connection), aur **server** (ek program jo **tools**, **resources** aur **prompts** expose karta hai). Messages **JSON-RPC 2.0** hain: `initialize` handshake, phir `tools/list`, `tools/call` waghera.
Transports: **stdio** (host server ko local subprocess ki tarah chalata hai) aur **Streamable HTTP** (remote server, HTTP pe).

### Why it matters for an FDE
Customer ke internal systems (Jira, ServiceNow, SAP) ke liye ek MCP server likho, aur wo har MCP-compatible host mein chal jaata hai. Security bhi ek jagah: auth, scopes, validation server pe (M10-09, M10-11), har app mein dobara nahi.

### Key concepts
- **Host** -- LLM se baat karta hai, user consent/approval UI rakhta hai, kai clients manage karta hai; decide karta hai kaunse tools model ko dikhenge.
- **Client** -- ek server se ek stateful session; handshake, capability negotiation, requests/responses route karna.
- **Server** -- capabilities expose: tools (model-invoked actions), resources (read-only context data), prompts (user-selectable templates).
- **Lifecycle** -- `initialize` (protocolVersion + capabilities) -> `notifications/initialized` -> normal requests; notifications ke `id` nahi hota.
- **Errors** -- protocol errors JSON-RPC `error` object (e.g. -32601 method not found); tool execution errors `result.isError: true` taaki model khud correct kar sake.

```text
 HOST (AuditMesh app / Claude Desktop / IDE)
 +-----------------------------------------------+
 |  LLM <-> host logic (consent, tool selection)  |
 |   client A ---- stdio ----> Jira MCP server    |
 |   client B ---- HTTP -----> KB MCP server      |
 +-----------------------------------------------+
```

### Code example
`stdlib only`

```python
# runnable
import json

PROTOCOL = "2025-06-18"   # teaching value; check the MCP spec for the current version

class MiniMCPServer:
    """Teaching stand-in for an MCP server: JSON-RPC 2.0 over strings (like newline-delimited stdio)."""
    def __init__(self, name, tools):
        self.name, self.tools, self.ready = name, tools, False
    def handle(self, line):
        msg = json.loads(line)
        method, params, mid = msg["method"], msg.get("params", {}), msg.get("id")
        if mid is None:                                    # notification: no response
            self.ready = self.ready or method == "notifications/initialized"
            return None
        reply = lambda **kw: json.dumps({"jsonrpc": "2.0", "id": mid, **kw})
        if method == "initialize":
            return reply(result={"protocolVersion": PROTOCOL, "capabilities": {"tools": {}},
                                 "serverInfo": {"name": self.name, "version": "0.1.0"}})
        if not self.ready:
            return reply(error={"code": -32002, "message": "not initialized"})   # server-chosen code
        if method == "tools/list":
            return reply(result={"tools": [{"name": n, "description": t["description"], "inputSchema": t["schema"]}
                                           for n, t in self.tools.items()]})
        if method == "tools/call":
            tool = self.tools.get(params.get("name"))
            if not tool:
                return reply(error={"code": -32602, "message": f"unknown tool {params.get('name')}"})
            try:
                text = tool["fn"](**params.get("arguments", {}))
                return reply(result={"content": [{"type": "text", "text": text}], "isError": False})
            except (TypeError, ValueError) as e:            # tool error -> result, so the model can retry
                return reply(result={"content": [{"type": "text", "text": str(e)}], "isError": True})
        return reply(error={"code": -32601, "message": f"method not found: {method}"})

class MiniMCPClient:
    """One client per server (1:1). Lives inside the host."""
    def __init__(self, server):
        self.server, self.next_id = server, 0
    def request(self, method, params=None):
        self.next_id += 1
        out = json.loads(self.server.handle(json.dumps({"jsonrpc": "2.0", "id": self.next_id,
                                                        "method": method, "params": params or {}})))
        assert out["id"] == self.next_id
        return out
    def connect(self):
        init = self.request("initialize", {"protocolVersion": PROTOCOL, "capabilities": {},
                                           "clientInfo": {"name": "auditmesh-host", "version": "0.1.0"}})
        self.server.handle(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        return init["result"]

def create_issue(summary, severity):
    if severity not in {"P1", "P2", "P3"}:
        raise ValueError("severity must be P1, P2 or P3")
    return f"created AUD-101: [{severity}] {summary}"

jira = MiniMCPServer("jira", {"create_issue": {"description": "Create a Jira issue", "fn": create_issue,
    "schema": {"type": "object", "properties": {"summary": {"type": "string"}, "severity": {"type": "string"}},
               "required": ["summary", "severity"]}}})
kb = MiniMCPServer("kb", {"search": {"description": "Search policies", "fn": lambda query: f"POL-RET-v3 matches {query!r}",
    "schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}})

c = MiniMCPClient(jira)
assert c.request("tools/list")["error"]["code"] == -32002          # must initialize first
host = {"jira": c, "kb": MiniMCPClient(kb)}                         # host = many clients, one per server
for name, client in host.items():
    print(name, "->", client.connect()["serverInfo"])
catalog = {f"{s}.{t['name']}": s for s, cl in host.items() for t in cl.request("tools/list")["result"]["tools"]}
print("tools the host can offer the model:", sorted(catalog))
ok = host["jira"].request("tools/call", {"name": "create_issue", "arguments": {"summary": "Public S3", "severity": "P1"}})
bad = host["jira"].request("tools/call", {"name": "create_issue", "arguments": {"summary": "x", "severity": "P0"}})
assert ok["result"]["isError"] is False and "AUD-101" in ok["result"]["content"][0]["text"]
assert bad["result"]["isError"] is True                             # tool error, not protocol error
assert host["kb"].request("resources/list")["error"]["code"] == -32601
assert sorted(catalog) == ["jira.create_issue", "kb.search"]
print("OK: initialize -> tools/list -> tools/call over JSON-RPC 2.0")
```

- `handle()` sirf JSON strings leta/deta hai -- stdio transport pe bhi exactly yahi hota hai (ek line = ek JSON-RPC message); HTTP transport pe same messages HTTP body mein.
- `initialize` se pehle `tools/list` -> error: lifecycle enforce karna server ka kaam hai.
- `notifications/initialized` ka `id` nahi, response nahi -- JSON-RPC notification ka rule.
- `isError: True` result vs `error` object -- invalid severity tool-level error hai (model padh ke fix kare); unknown method protocol-level.
- Host `catalog` mein server prefix (`jira.create_issue`) -- do servers ke same tool naam takrayein nahi; ye host ki zimmedari hai.

```json
{"jsonrpc": "2.0", "id": 7, "method": "tools/call",
 "params": {"name": "create_issue", "arguments": {"summary": "Public S3 bucket", "severity": "P1"}}}
```

```python
# real version -- not run here, needs: pip install mcp
# Official Python SDK, FastMCP style. Check the MCP Python SDK docs for your version.
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("auditmesh-jira")

@mcp.tool()
def create_issue(summary: str, severity: str) -> str:
    """Create a Jira issue for a compliance finding."""
    return jira_client.create(summary=summary, severity=severity)   # your safe executor (M10-09)

if __name__ == "__main__":
    mcp.run()                     # stdio by default; check the docs for transport="streamable-http"
```

Client side (host code) official SDK mein `ClientSession` + `stdio_client(StdioServerParameters(command="python", args=["server.py"]))`, phir `await session.initialize()`, `await session.list_tools()`, `await session.call_tool("create_issue", {...})` -- exact imports docs se confirm karo.

### Mini-exercise (30-60 min)
CP7 AuditMesh: `auditmesh/mcp_jira/server.py` -- Jira MCP server ka skeleton.
- Pehle upar wale `MiniMCPServer` se tools `get_issue`, `search_issues`, `create_issue` (fake Jira, M10-09 ka executor andar); phir FastMCP version alag file mein (agar `pip install mcp` kar sakte ho).
- `tests/test_mcp_jira.py`: JSON-RPC level tests -- initialize se pehle error, `tools/list` mein 3 tools with `inputSchema`, invalid args pe `isError: true`, unknown method -32601.
- Acceptance: stdio test -- `subprocess` se server chalao, ek line `initialize` bhejo, response line parse karo (`sys.executable` use karo).

### Common pitfalls
- MCP ko security boundary samajhna -- protocol sirf plumbing hai; auth, scopes, validation server ke andar tumhe likhne hain.
- Untrusted third-party MCP servers ko install karna -- tool descriptions mein bhi prompt injection ho sakta hai ("tool poisoning"); sirf vetted servers, pinned versions.
- stdio server mein `print()` debug karna -- stdout hi protocol channel hai, logs stderr pe bhejo.

### Checklist before moving on
- [ ] Host, client, server ka role ek-ek line mein bata sakta hoon, aur client:server 1:1 kyon.
- [ ] stdio vs Streamable HTTP transport kab use hota hai bata sakta hoon.
- [ ] `initialize` -> `notifications/initialized` -> `tools/list` -> `tools/call` flow test mein chalta hai.
- [ ] Protocol error vs tool `isError` ka fark samajh aata hai.

### Related
- M10-09 Connecting agents to external tools safely
- M10-11 Standardizing tool access boundaries
- M05-11 Defining precise function schemas for LLMs
- M10-12 Vendor agent SDKs (Claude Agent SDK and OpenAI Agents SDK)
- M16 AuditMesh capstone

### Self-quiz
1. Host aur server dono same machine pe hain. stdio choose karoge ya Streamable HTTP? Kab answer badlega?
2. Ek host mein 5 MCP servers, 80 tools. Model ko sab dikhane mein kya problem hai, aur host kya kar sakta hai?
3. Tools, resources aur prompts mein se kaun model-controlled hai aur kaun application/user-controlled?
4. Jira MCP server remote hai. Kaunse user ke credentials se Jira call hogi -- agent ke ya end-user ke? Trade-off batao.
