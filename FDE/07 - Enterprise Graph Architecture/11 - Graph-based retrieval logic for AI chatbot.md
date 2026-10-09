# Enterprise Graph Architecture

## Graph-based retrieval logic for AI chatbot

> Extended (slow track only) | Slow CP5 only | ~1.2 h

Yeh Module 7 ka capstone hai aur seedha M17-09 GraphRAG se judta hai. Chatbot ke liye teen common patterns: (1) **entity linking + k-hop** -- question se entities nikaalo, graph mein match karo, 1-2 hops expand karke jude chunks LLM ko do; (2) **text-to-Cypher** -- LLM schema dekh ke Cypher likhta hai; (3) **hybrid** -- graph results + vector results ko RRF (M06-13) se merge.
Text-to-Cypher powerful hai lekin risky: LLM galat label, unbounded `*` path, ya `DELETE` likh sakta hai. Guardrails: read-only DB user, query timeout, allow-list of labels/relations (ontology, M07-02), `LIMIT` enforce, aur hamesha parameters.
Har graph result ke saath source chunk/record id rakho taaki answer cite ho sake, aur tenant/ACL filter traversal ke andar lagao, baad mein nahi.
Ek baat yaad rakho: pehle fixed, parameterised Cypher templates (5-10 common question types) se start karo; free-form text-to-Cypher tabhi jab eval set (M06-10) dikhaye ki templates kam pad rahe hain.

```cypher
// template: "open tickets for suppliers of <status> shipments"
MATCH (sh:Shipment {status: $status, tenant: $tenant})-[:SUPPLIED_BY]->(s:Supplier)<-[:FILED_AGAINST]-(t:Ticket {status: 'open'})
RETURN s.name AS supplier, collect(DISTINCT t.id) AS tickets, collect(DISTINCT sh.chunk_id) AS sources LIMIT 25
```

**Try this (20-40 min):** M07-09 wale logistics graph pe 3 Cypher templates banao aur ek Python router likho (FakeLLM ya keyword rules) jo question ko template + params mein map kare. Ek "unsafe" check bhi add karo jo kisi bhi generated Cypher mein `DELETE|MERGE|CREATE|SET` ya bina upper bound `*` mile toh reject kare.

**Read:** https://neo4j.com/docs/neo4j-graphrag-python/current/
