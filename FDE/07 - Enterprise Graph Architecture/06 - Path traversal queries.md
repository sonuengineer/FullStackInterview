# Enterprise Graph Architecture

## Path traversal queries

> Extended (slow track only) | Slow CP5 only | ~1.2 h

Graph ki asli taaqat: "kitne bhi hops" wali query ek line mein. **Variable-length pattern** `-[:SHIPS_TO*1..3]->` = 1 se 3 hops tak ka koi bhi path. `shortestPath()` / `SHORTEST 1` (newer Cypher syntax -- version check karo) sabse chhota route deta hai. `p = (...)` se poora path variable mein aata hai, `length(p)`, `nodes(p)`, `relationships(p)` se details.
SQL mein yahi kaam recursive CTE se hota hai -- likhna mushkil aur deep hops pe slow.
FDE isse supply chain ("is factory ke band hone se kaun se customers affected?"), fraud rings, org charts aur access paths mein milta hai -- aur GraphRAG (M17-09) ka k-hop expansion bhi yahi hai.
Ek baat yaad rakho: **upper bound hamesha do** (`*1..3`, kabhi `*` akela nahi) -- unbounded traversal dense graph pe millions of paths bana ke DB ko hang kar deta hai.

```cypher
MATCH p = (f:Facility {id: $facilityId})-[:SHIPS_TO*1..3]->(c:Customer)
RETURN c.name, min(length(p)) AS hops
ORDER BY hops LIMIT 50
```

**Try this (20-40 min):** 10 facilities aur 15 customers ka chhota `SHIPS_TO` network banao (ek cycle bhi daalo). Teen queries chalao: `*1..2`, `*1..4`, aur shortest path between do nodes; har ka row count aur time note karo. Phir bina upper bound wali query ka `EXPLAIN` dekho aur samjho kyun woh risky hai.

**Read:** https://neo4j.com/docs/cypher-manual/current/patterns/variable-length-patterns/
