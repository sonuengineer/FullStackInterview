# Enterprise Graph Architecture

## Optimizing complex graph joins

> Extended (slow track only) | Slow CP5 only | ~1.2 h

Graph query slow hone ke teen common reasons: (1) **starting point pe index nahi** -- DB `AllNodesScan`/`NodeByLabelScan` karta hai, (2) **cartesian product** -- do disconnected patterns ek `MATCH` mein, (3) **supernode** -- ek node ke laakhon edges (jaise "Country: India"), jahan se har traversal explode hota hai.
`EXPLAIN` plan dikhata hai bina chalaye; `PROFILE` chalake har operator ke rows aur db hits batata hai. Plan mein `NodeIndexSeek` accha sign hai, `CartesianProduct` aur huge row counts red flag.
Fixes: lookup properties pe index/unique constraint, sabse selective node se start karo, `WITH` + `LIMIT` se beech mein rows kaato, supernodes ke liye edge type zyada specific karo ya intermediate nodes (e.g. per-month bucket).
Ek baat yaad rakho: guess mat karo -- pehle `PROFILE`, phir ek change, phir dobara `PROFILE`; jaise SQL mein `EXPLAIN ANALYZE`.

```cypher
CREATE INDEX shipment_status IF NOT EXISTS FOR (s:Shipment) ON (s.status);
PROFILE
MATCH (sh:Shipment {status: $status})-[:SUPPLIED_BY]->(s:Supplier)<-[:FILED_AGAINST]-(t:Ticket)
RETURN s.name, count(t);
```

**Try this (20-40 min):** 50k Shipment nodes UNWIND se generate karo. Upar wali query index ke bina `PROFILE` karo, db hits note karo; index banao, dobara PROFILE karo. Phir jaan-boojh ke ek cartesian product wali query likho aur plan mein `CartesianProduct` operator dhoondo.

**Read:** https://neo4j.com/docs/cypher-manual/current/planning-and-tuning/
