# Vector Search & Core RAG

## Keyword-based search mechanisms

> Extended (slow track only) | Slow CP4 only | ~1.2 h

Keyword search ka engine hai **inverted index**: har term -> un docs/positions ki list jahan wo aata hai (`"px-2291" -> [doc3:pos5, doc7:pos1]`). Query pe sirf un terms ki lists merge hoti hain, poora corpus scan nahi -- isliye crore docs pe bhi milliseconds.
Iske upar features banate hain: boolean (`AND/OR/NOT`), phrase match (positions se "opened electronics"), prefix/fuzzy (typos: "warrenty"), field boosts (title > body), aur ranking (TF-IDF/BM25, M06-05).
FDE ko ye customer ke existing stack mein milta hai: Elasticsearch/OpenSearch, Postgres full-text (`tsvector`, `ts_rank`), Solr, ya SharePoint search. Aksar sabse sasta hybrid yahi hai -- jo search customer pehle se chala raha hai uske results ko dense results ke saath RRF (M06-13) se fuse karo, naya system mat banao.
Yaad rakho: analyzer/tokenizer (lowercase, stemming, stopwords, ID handling) index aur query dono pe same hona chahiye -- yahi keyword search ka 80% quality hai.

**Try this (20-40 min):** stdlib mein ek inverted index likho (`dict[str, set[int]]` + positions) jo `AND` query aur exact phrase query support kare; phir sqlite FTS5 (`CREATE VIRTUAL TABLE t USING fts5(body)`, `MATCH`, `bm25(t)`) se same 10 docs pe results compare karo.

**Read:** https://www.sqlite.org/fts5.html
