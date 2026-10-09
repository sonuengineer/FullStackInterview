# Enterprise Graph Architecture

## AuraDB cloud provisioning

> Extended (slow track only) | Slow CP5 only | ~1.2 h

**Neo4j AuraDB** = Neo4j ka fully managed cloud service -- server, backups, upgrades sab Neo4j sambhalta hai. Free tier learning ke liye kaafi hai (limited nodes/relationships, idle hone pe pause ho sakta hai -- exact limits docs mein check karo); paid tiers mein bigger memory, backups, private networking.
Provision karte waqt ek baar credentials file milti hai (URI `neo4j+s://...`, username, password) -- usi time download karke secret manager / `.env` mein rakho, password dobara nahi dikhta.
FDE angle: customer POC ke liye AuraDB fastest hai, lekin production se pehle poocho -- data region kahan hai, private link/VPC peering chahiye, SSO, backup retention, aur kya customer ka security team managed SaaS allow karta hai. AWS-only shop hai toh Neptune (M07-08) compare karo.
Ek baat yaad rakho: app code mein URI/user/password env vars se lo (`NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`), kabhi git mein nahi; aur `neo4j+s` (TLS) hi use karo.

**Try this (20-40 min):** AuraDB free instance banao (koi card nahi chahiye -- signup page pe check karo), credentials `.env` mein daalo, Python `neo4j` driver se `driver.verify_connectivity()` aur ek `execute_query("RETURN 1 AS ok")` chalao. Ek README note likho: region, tier limits, aur production ke liye kya badalna padega.

**Read:** https://neo4j.com/docs/aura/
