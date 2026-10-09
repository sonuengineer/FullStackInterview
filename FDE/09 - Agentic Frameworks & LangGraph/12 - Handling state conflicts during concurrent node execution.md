# Agentic Frameworks & LangGraph

## Handling state conflicts during concurrent node execution

> Extended (slow track only) | Slow CP9 only | ~1.2 h

M09-09 mein do branches ek hi superstep mein chali thin. Ab socho dono ne same key `status` likhi -- ek ne "pass", doosre ne "fail". Kaunsa jeete? Agar framework chup-chaap "last writer wins" kare to result **finish order** pe depend karega -- aaj pass, kal fail, bina code change ke.
LangGraph isliye bina reducer wali key pe ek step mein do writes ko error maanta hai (`InvalidUpdateError`, message kuch aisa: "Can receive only one value per step. Use an Annotated key to handle multiple values.") -- exact text version pe depend karta hai.
Teen fixes: (1) **reducer** lagao (`Annotated[list, operator.add]` ya apna merge function, e.g. "worst severity wins"); (2) **alag keys** do (`mfa_status`, `log_status`) aur ek join node final `status` nikale; (3) branches ko sequential karo agar order sach mein matter karta hai.
Custom reducer **deterministic aur order-independent** hona chahiye (commutative): `max(severity)` theek, "append aur first item lo" galat.
FDE ke liye: ye bug sirf load ke under ya slow customer API pe dikhta hai -- isliye parallel nodes ke har shared key ka merge rule design time pe likho.

**Try this (20-40 min):** M09-09 ke async MiniGraph mein ek check add karo: ek superstep mein non-reducer key do baar likhi jaaye to `ValueError` (merge loop mein har step ke likhe gaye keys ka ek `written` set rakho). Phir `worst_severity(a, b)` reducer likho aur test karo ki branches ka finish order badalne pe bhi result same rehta hai.

**Read:** https://docs.langchain.com/oss/python/langgraph/graph-api
