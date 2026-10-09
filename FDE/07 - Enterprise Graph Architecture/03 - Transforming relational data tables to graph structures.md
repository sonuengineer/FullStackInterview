# Enterprise Graph Architecture

## Transforming relational data tables to graph structures

> Extended (slow track only) | Slow CP5 only | ~1.2 h

Customer ka data almost hamesha Postgres/Oracle tables mein hota hai. Mapping rule simple hai: **entity table -> node label**, **row -> node**, **foreign key column -> edge**, **join table (order_items) -> edge with properties** (quantity, price), lookup/enum columns -> property ya chhota node (jab us pe query karni ho).
Flow: SQL se CSV export (ya driver se batch read) -> pehle unique constraints banao -> nodes load karo -> phir edges load karo (MATCH dono ends, CREATE/MERGE edge).
`MERGE` idempotent hai (re-run pe duplicate nahi) lekin bina index ke slow; bade loads ko batches mein karo (`CALL { ... } IN TRANSACTIONS`), warna memory phat jaayegi.
Ek baat yaad rakho: har cheez graph mein mat daalo -- sirf woh entities aur relations jinpe multi-hop questions aate hain; baaki SQL mein hi rehne do, graph mein id rakh lo.

```cypher
CREATE CONSTRAINT supplier_id IF NOT EXISTS FOR (s:Supplier) REQUIRE s.id IS UNIQUE;
LOAD CSV WITH HEADERS FROM 'file:///shipments.csv' AS row
MERGE (sh:Shipment {id: row.shipment_id}) SET sh.status = row.status
WITH sh, row
MATCH (s:Supplier {id: row.supplier_id})
MERGE (sh)-[:SUPPLIED_BY]->(s);
```

**Try this (20-40 min):** sqlite mein `suppliers`, `shipments(supplier_id FK)`, `tickets(supplier_id FK)` banao, 20 rows daalo, CSV export karo. Phir AuraDB free / Neo4j Desktop mein constraints + `LOAD CSV` (ya Python driver se `UNWIND $rows AS row`) se load karo aur verify karo: SQL `COUNT(*)` = graph node/edge counts.

**Read:** https://graphacademy.neo4j.com/courses/importing-fundamentals/
