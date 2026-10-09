# Modern API Development

## Writing efficient data resolvers

> Extended (slow track only) | Slow CP2 only | ~1.2 h

**Resolver** = wo function jo GraphQL schema ke ek field ki value laata hai; client jitne fields maangta hai utne resolvers chalte hain -- aur har nested object pe dobara.
Efficient resolvers ke 3 rules: (1) resolver patla rakho -- business logic service/repository layer mein, aur DB session/current user `info.context` se lo (M02-03 ka DI idea); (2) costly fields (jaise `summary` jo LLM call karta hai) ka alag resolver rakho taaki maanga na jaaye to chale hi nahi; (3) I/O wale resolvers `async` rakho taaki ek slow field baaki ko block na kare.
FDE context: customer ka dashboard ek query mein 50 documents + har ek ka owner + summary maangta hai -- naive resolvers 51 DB calls aur 50 LLM calls kar dete hain. Yahi agla topic (N+1, M02-08) hai.
Security bhi resolver level pe: har resolver pe tenant/authorization check, warna nested field ke raaste doosre tenant ka data leak ho sakta hai.
Yaad rakho: GraphQL mein "ek request" ka matlab "ek DB query" nahi hota -- har resolver ka cost alag se socho.

**Try this (20-40 min):** M02-06 wale schema mein `Document.owner` resolver add karo jo ek global counter badhaye; 20 documents ki list query chala ke counter print karo. M02-08 mein ye number 1 pe laana hai.

**Read:** https://strawberry.rocks/docs/types/resolvers
