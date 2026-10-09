# Modern API Development

## Executing queries vs mutations

> Extended (slow track only) | Slow CP2 only | ~1.2 h

GraphQL mein **query** = read (REST ka GET), **mutation** = write (POST/PUT/DELETE). Dono usually ek hi `POST /graphql` endpoint pe jaate hain, isliye HTTP method se read/write ka fark nahi dikhta -- operation type se dikhta hai.
Execution fark: query ke top-level fields parallel resolve ho sakte hain, jabki mutation ke top-level fields spec ke hisaab se **serially** (likhe hue order mein) chalte hain taaki side effects predictable rahein.
Mutation design: input type lo (`CreateDocumentInput`, Pydantic `DocumentCreate` jaisa), changed object + errors return karo, aur retry-safe banao (client-generated id ya idempotency key, M14-01) -- network retry pe duplicate document nahi banna chahiye.
FDE angle: GraphQL errors aksar HTTP 200 ke saath `errors` array mein aate hain -- customer ka monitoring sirf status codes dekhta hai to failures miss honge. Logging/alerting mein `errors` field parse karo.
Caching bhi alag hai: queries cache ho sakti hain (persisted queries, GET), mutations kabhi nahi.

**Try this (20-40 min):** Strawberry schema mein `@strawberry.mutation def create_document(self, title: str) -> Document` add karo; ek request mein do mutations bhejo jo ek shared list mein append karein aur order verify karo; phir galat type ka input bhej ke dekho response mein `errors` array kya kehta hai.

**Read:** https://graphql.org/learn/queries/
