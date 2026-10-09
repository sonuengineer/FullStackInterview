# Modern API Development

## Designing GraphQL schemas and object types using Python frameworks like Strawberry or Graphene

> Extended (slow track only) | Slow CP2 only | ~1.2 h

GraphQL mein server ek **typed schema** publish karta hai (types, fields, relations) aur client khud decide karta hai ki kaunse fields chahiye -- REST ke fixed response shape ke ulat.
Python mein do bade options: **Strawberry** (code-first, dataclass + type hints, Pydantic jaisa feel, FastAPI ke saath `GraphQLRouter`) aur **Graphene** (purana, `graphene.ObjectType` classes). Naye projects ke liye Strawberry zyada natural hai; Graphene aksar legacy Django codebases mein milega.
FDE ko ye tab milta hai jab customer ka frontend (React/Apollo) already GraphQL bolta hai, ya ek dashboard ko 5 REST calls ki jagah ek query chahiye.
Schema design ka core: types business nouns hon (`Document`, `Tenant`), nullability soch-samajh ke (`str | None` = nullable), aur internal fields (storage path, PII) schema mein aayein hi nahi -- jo schema mein hai wo public contract hai.
Ek baat yaad rakho: GraphQL schema bhi API contract hai, Pydantic `DocumentOut` (M02-02) jaisa -- field hatana breaking change hai, isliye pehle deprecate karo (`strawberry.field(deprecation_reason=...)`).

**Try this (20-40 min):** scratch folder mein `@strawberry.type class Document` (id, title, classification) aur `Query.document(id: int) -> Document | None` banao; `strawberry.Schema(query=Query).execute_sync("{ document(id: 1) { title } }")` chala ke `result.data` print karo, phir `print(schema)` se generated SDL padho.

**Read:** https://strawberry.rocks/docs
