# Enterprise Graph Architecture

## Pattern matching syntax

> Extended (slow track only) | Slow CP5 only | ~1.2 h

Cypher ASCII-art jaisa hai: `()` = node, `-[]->` = directed edge, `:Label` / `:TYPE` filter, `{key: value}` inline property filter. `MATCH` pattern dhoondhta hai, `WHERE` extra conditions, `RETURN` output, `OPTIONAL MATCH` = SQL ka LEFT JOIN (missing pe null).
Aggregation automatic grouping karti hai: `RETURN s.name, count(t)` mein `s.name` group key ban jaata hai. `collect()` list banata hai, `DISTINCT` duplicates hatata hai.
FDE ke liye sabse important rule: user/LLM input hamesha **parameters** (`$id`, `$status`) se bhejo, string concat se kabhi nahi -- warna Cypher injection, aur query plan cache bhi kaam nahi karta.
Ek baat yaad rakho: pattern mein label zaroor likho (`(s:Supplier)` na ki `(s)`) -- label nahi toh DB ko poore graph ke nodes scan karne padte hain.

```cypher
MATCH (sh:Shipment {status: $status})-[:SUPPLIED_BY]->(s:Supplier)
OPTIONAL MATCH (s)<-[:FILED_AGAINST]-(t:Ticket {status: 'open'})
RETURN s.name AS supplier, count(DISTINCT sh) AS shipments, collect(DISTINCT t.id) AS open_tickets
ORDER BY shipments DESC LIMIT 10
```

**Try this (20-40 min):** GraphAcademy ka Movies sandbox kholo aur 5 queries likho: (1) ek actor ki movies, (2) co-actors, (3) OPTIONAL MATCH se director-without-reviews, (4) top 5 by count, (5) same query `$name` parameter ke saath. Har query ka SQL equivalent bhi likho.

**Read:** https://graphacademy.neo4j.com/courses/cypher-fundamentals/
