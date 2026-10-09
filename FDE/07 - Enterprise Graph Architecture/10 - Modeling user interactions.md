# Enterprise Graph Architecture

## Modeling user interactions

> Extended (slow track only) | Slow CP5 only | ~1.2 h

User behaviour graph: `(:User)-[:VIEWED {at}]->(:Product)`, `-[:PURCHASED {qty, at}]->`, `-[:RATED {stars}]->`, `(:User)-[:FOLLOWS]->(:User)`. Isse recommendations ("jinhone yeh khareeda unhone yeh bhi"), fraud rings (same device/card share karne wale accounts) aur support context ("is user ne pichhle hafte kya dekha") nikalte hain.
Modeling choice: har click ko edge banao ya `(:Event)` node? Simple counts ke liye edge + properties theek hai; agar event pe khud relations chahiye (session, device, campaign) toh event ko node banao (reification).
FDE angle: interaction data bahut tezi se badhta hai -- raw clickstream ko graph mein mat dhakelo; aggregate karo (daily `VIEWED {count}`), purane events archive karo, aur PII (email, phone) ko graph property banane se pehle privacy check karo (M13-14).
Ek baat yaad rakho: "collaborative filtering" Cypher mein bas 3-hop pattern hai: user -> product <- other user -> other product.

```cypher
MATCH (u:User {id: $userId})-[:PURCHASED]->(:Product)<-[:PURCHASED]-(other:User)-[:PURCHASED]->(rec:Product)
WHERE NOT (u)-[:PURCHASED]->(rec)
RETURN rec.name, count(DISTINCT other) AS score ORDER BY score DESC LIMIT 5
```

**Try this (20-40 min):** 20 users, 15 products, ~80 random PURCHASED edges UNWIND se banao. Upar wali recommendation query chalao, phir ek fraud query likho: do se zyada users jo ek hi `(:Device)` share karte hain. Note karo ki edge vs Event-node model mein query kaise badlegi.

**Read:** https://neo4j.com/docs/getting-started/data-modeling/
