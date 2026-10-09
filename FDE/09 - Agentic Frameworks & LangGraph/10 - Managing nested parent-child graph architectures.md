# Agentic Frameworks & LangGraph

## Managing nested parent-child graph architectures

> Extended (slow track only) | Slow CP9 only | ~1.2 h

Jab AuditMesh bada hota hai, ek hi graph mein 30 nodes ho jaate hain -- evidence team, control-check team, Jira team sab ek file mein. **Subgraph** pattern isse todta hai: ek compiled graph ko parent graph mein ek node ki tarah add karo.
Do tareeke hain: (1) parent aur child ki state keys shared hon to compiled child seedha `builder.add_node("evidence_team", evidence_graph)`; (2) schemas alag hon to ek wrapper node jo parent state ko child input mein translate kare, `child.invoke(...)` kare, aur sirf zaroori output keys wapas parent ko de.
FDE ko ye tab milta hai jab customer ki alag teams alag sub-workflows own karti hain, ya ek evidence subgraph SOC 2 aur ISO 27001 dono audits mein reuse karna ho.
Ek cheez yaad rakho: child ka **interface** (input keys, output keys) explicitly define karo -- child ke internal scratch fields (raw tool outputs, retries) parent state mein leak nahi hone chahiye; warna parent state phoolta hai aur checkpoints mein PII pahunchti hai.
Checkpointing, interrupts aur streaming (`stream(..., subgraphs=True)`) subgraphs ke saath kaise behave karte hain ye version-specific hai -- check the docs for your langgraph version.

**Try this (20-40 min):** MiniGraph (M09-07 wala) se ek `evidence_team` child graph banao (`fetch -> summarise`), aur parent mein wrapper node se call karo jo sirf `evidence_summary` wapas de. Test: parent ke final state mein child ke raw fields (`raw_docs`) nahi hone chahiye.

**Read:** https://docs.langchain.com/oss/python/langgraph/use-subgraphs
