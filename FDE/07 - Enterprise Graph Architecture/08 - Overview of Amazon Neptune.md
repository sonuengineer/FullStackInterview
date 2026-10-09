# Enterprise Graph Architecture

## Overview of Amazon Neptune

> Extended (slow track only) | Slow CP5 only | ~1.2 h

**Amazon Neptune** = AWS ka managed graph database. Do data models support karta hai: **property graph** (query via **openCypher** ya **Gremlin**) aur **RDF** (query via **SPARQL**). Neo4j se aaye ho toh openCypher sabse familiar lagega, lekin har Cypher feature/procedure (jaise APOC) available nahi -- compatibility list docs mein check karo.
Neptune clusters aapke **VPC ke andar** chalte hain -- laptop se seedha connect nahi hota; bastion/VPN ya same-VPC Lambda/EC2 chahiye. IAM database auth (SigV4 signed requests) common hai. Serverless option aur Neptune Analytics bhi hain -- features aur pricing badalte rehte hain, docs check karo.
FDE isse tab milta hai jab customer "AWS-only, no third-party SaaS" bolta hai: data AWS account ke andar, IAM, CloudWatch, VPC security groups -- procurement aur security review aasaan.
Ek baat yaad rakho: decision matrix banao -- query language need (Cypher/Gremlin/SPARQL), network/compliance, ops team ka AWS comfort, aur cost (instance-hour vs serverless capacity) -- "Neo4j vs Neptune" religious debate nahi hai.

**Try this (20-40 min):** Koi AWS resource mat banao. Docs padhke ek 1-page comparison table likho: AuraDB vs Neptune -- query languages, networking (public vs VPC-only), auth, backups, free/trial options, aur bulk load method (Neptune bulk loader from S3 vs LOAD CSV). End mein ek customer-facing recommendation paragraph likho.

**Read:** https://docs.aws.amazon.com/neptune/latest/userguide/intro.html
