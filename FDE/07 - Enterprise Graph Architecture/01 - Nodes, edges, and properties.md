# Enterprise Graph Architecture

## Nodes, edges, and properties

> Extended (slow track only) | Slow CP5 only | ~1.2 h

Graph ka poora data model teen cheezon pe chalta hai: **node** (ek cheez -- Customer, Order, Supplier, label ke saath `:Customer`), **edge/relationship** (do nodes ke beech directed, typed connection -- `(c)-[:PLACED]->(o)`), aur **properties** (key-value pairs, nodes aur edges dono pe -- `{status: "delayed"}`, `{since: 2023}`).
SQL se socho: row = node, foreign key + join table = edge. Fark yeh hai ki graph mein edge first-class data hai -- uska apna type aur properties hote hain, aur DB har node se neighbours seedha follow karta hai (index-free adjacency), join compute nahi karta.
FDE isse tab milta hai jab customer ke questions relationships pe hote hain: "kaun se suppliers delayed shipments aur open tickets dono se jude hain?" -- yahi M17-09 GraphRAG ki neev hai.
Ek baat yaad rakho: edge pe property tab daalo jab woh fact *relationship* ka hai (order quantity, rating date), node ka nahi. Aur edge direction meaningful rakho, query mein dono taraf traverse kar sakte ho.

```cypher
CREATE (c:Customer {id: 'C1', name: 'Asha'})-[:PLACED {at: date('2026-01-10')}]->(o:Order {id: 'O1', total: 499})
```

**Try this (20-40 min):** Paper pe apne kisi purane project ke 4 SQL tables (users, orders, products, reviews) lo aur graph model draw karo: kaun node bana, kaun edge, kaun si column property bani (aur kaun si edge pe gayi). Phir GraphAcademy sandbox ya Neo4j Desktop mein 5 nodes aur 6 edges `CREATE` karke `MATCH (n)-[r]->(m) RETURN n, r, m` chalao.

**Read:** https://neo4j.com/docs/getting-started/graph-database/
