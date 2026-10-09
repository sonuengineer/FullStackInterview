# LLM Fundamentals & Prompting

## Using discriminator fields for union types

> Extended (slow track only) | Slow CP3 only | ~1.2 h

Kabhi LLM output "ek se zyada shape" ka hota hai: support message ya to `refund_request` (amount, order_id), ya `address_change` (new_address), ya `complaint` (severity). Plain `Union[A, B, C]` mein Pydantic har shape try karta hai -- errors confusing aate hain aur galat shape "match" ho sakti hai.
**Discriminated union** mein har model ka ek `Literal` tag field hota hai (`kind: Literal["refund_request"]`), aur `Annotated[A | B | C, Field(discriminator="kind")]` se Pydantic seedha tag dekh ke sahi model chunta hai.
JSON Schema mein ye `oneOf` + `discriminator.mapping` banta hai, LLM ko clear choice milti hai, aur error `loc` mein tag aata hai (jaise `refund_request.amount_minor`) -- repair-retry (M05-09) ke liye perfect.
FDE ko ye intent routing, multi-type document extraction aur agent "next action" outputs mein milega.
Yaad rakho: tag field hamesha required + `Literal` ho, aur unknown tag pe validation fail ho -- silently "other" mein mat daalo; fallback chahiye to explicit `kind: Literal["unknown"]` model rakho.

**Try this (20-40 min):** `omniguard/schemas.py` mein `Action = Annotated[Refund | AddressChange | Complaint, Field(discriminator="kind")]` banao, `TypeAdapter(list[Action])` se 5 fake LLM outputs validate karo (ek wrong tag, ek missing field), aur `.json_schema()` mein `oneOf` + `discriminator.mapping` check karo. Provider ka structured-output mode `oneOf` support karta hai ya nahi -- docs check karo; na kare to `anyOf` pe fallback test karo.

**Read:** https://docs.pydantic.dev/latest/concepts/unions/#discriminated-unions
