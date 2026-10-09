# Enterprise Graph Architecture

## Mapping logistics networks

> Extended (slow track only) | Slow CP5 only | ~1.2 h

Logistics graph ka typical model: `(:Supplier)-[:SUPPLIES]->(:Part)`, `(:Facility)-[:SHIPS_TO {lead_days, cost}]->(:Facility|:Customer)`, `(:Shipment)-[:SUPPLIED_BY]->(:Supplier)`, `(:Shipment)-[:VIA]->(:Port)`. Edge properties (lead time, cost, capacity) yahan bahut kaam ki hain -- weighted path queries inhi se banti hain.
FDE questions jo is model se aate hain: "Mumbai port band ho gaya toh kaun se customers 3 hops ke andar affected?", "single-source parts kaun se hain (sirf ek supplier)?", "kis supplier ke delayed shipments aur open compliance tickets dono hain?" (yahi M17-09 ka example tha).
Time important hai: shipments aur routes badalte rehte hain, isliye `valid_from/valid_to` properties ya per-date Shipment nodes rakho, warna aaj ka graph kal ke question ka galat answer dega.
Ek baat yaad rakho: "Port" aur "Country" jaise nodes supernodes ban jaate hain (M07-07) -- unpe traversal se pehle filter lagao.

```cypher
MATCH (p:Port {code: $port})<-[:VIA]-(:Shipment)-[:SUPPLIED_BY]->(s:Supplier)-[:SUPPLIES]->(part:Part)
WITH part, count(DISTINCT s) AS suppliers WHERE suppliers = 1
RETURN part.sku AS single_source_part_at_risk
```

**Try this (20-40 min):** 5 suppliers, 8 parts, 4 facilities, 2 ports, 10 shipments ka graph banao. Teen queries likho: (1) port-closure impact within 3 hops, (2) single-source parts, (3) lowest total `lead_days` route between do facilities (pehle `*1..4` paths nikaalo, phir `reduce()` se sum karo).

**Read:** https://graphacademy.neo4j.com/courses/modeling-fundamentals/
