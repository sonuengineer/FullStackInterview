# Enterprise Graph Architecture

## Ontologies vs taxonomies

> Extended (slow track only) | Slow CP5 only | ~1.2 h

**Taxonomy** = sirf ek hierarchy, ek hi relation "is-a / broader-than": `Electronics > Laptops > Gaming Laptops`. E-commerce categories, ICD disease codes, product catalogs -- sab taxonomy hain.
**Ontology** = taxonomy + rules aur multiple relation types: "Supplier SUPPLIES Part", "Part IS_COMPONENT_OF Product", "Shipment must have exactly one Supplier". Yeh batata hai kaun se node types hain, kaun se edges allowed hain, aur unke properties kya hain -- basically graph ka schema + meaning.
FDE isse GraphRAG (M17-09) extraction pe milta hai: agar LLM ko allowed labels aur relation types (ontology) nahi diye, toh woh `WORKS_AT`, `EMPLOYED_BY`, `EMPLOYEE_OF` teen alag edges bana dega aur queries toot jaayengi.
Customer ke paas aksar already ek taxonomy hoti hai (category master, SKOS vocabulary, SNOMED) -- usko reuse karo, naya invent mat karo.
Ek baat yaad rakho: chhota start karo -- 5-8 node labels aur 8-12 relation types ki ek "lightweight ontology" kaafi hai; formal OWL reasoning tabhi jab customer usse sach mein use kare.

**Try this (20-40 min):** Ek logistics customer ke liye YAML mein lightweight ontology likho: `labels` (Shipment, Supplier, Port, Ticket, Product), `relations` (`SUPPLIED_BY: Shipment -> Supplier`, etc.), aur har label ki required properties. Phir ek alag `categories` taxonomy (Product types, 3 levels) likho aur note karo ki dono mein kya fark hai.

**Read:** https://www.w3.org/TR/skos-primer/
