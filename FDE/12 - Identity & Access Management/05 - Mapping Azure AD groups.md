# Identity & Access Management

## Mapping Azure AD groups

> Extended (slow track only) | Slow CP7 only | ~1.2 h

Microsoft **Entra ID** (pehle Azure AD) wala customer sabse common hai. Do tarike se permissions aapke token mein aati hain: **group claims** (`groups` claim mein group **object ids** -- GUIDs, naam nahi) ya **app roles** (app registration mein define kiye roles jaise `OmniGuard.Analyst`, `roles` claim mein aate hain). App roles recommend karo: naam stable, sirf aapke app ke liye relevant, aur customer ka admin users/groups ko roles assign karta hai.
Groups use karne pade to mapping config mein rakho: `{"<group-object-id>": "analyst"}` -> M12-06 ke internal roles. Display names pe kabhi map mat karo -- rename hote rehte hain, aur unique bhi nahi hote.
**Group overage gotcha:** user bahut saare groups mein hai (JWT ke liye limit lagbhag 200) to Entra token mein `groups` claim hi nahi bhejta, uski jagah ek overage indicator (`_claim_names` / `hasgroups`) aata hai, aur groups Microsoft Graph se fetch karne padte hain. Exact limits aur claim shape version ke hisaab se badalte hain -- **check the docs**. Isse bachne ke liye "groups assigned to the application" filter ya app roles use karo.
Yaad rakho: roles/groups claims token issue hote waqt fix ho jaate hain -- kisi ko group se hataya to effect agle token pe aayega (M12-08 ka TTL yahan matter karta hai). Aur multi-tenant app mein `tid` (tenant id) claim zaroor check karo.

**Try this (20-40 min):** ek fake Entra-style JWT payload banao (M12-02 ke key pair se) jisme `tid`, `roles: ["OmniGuard.Analyst"]` aur `groups: [<2 GUIDs>]` ho, aur ek doosra jisme `groups` ki jagah `_claim_names: {"groups": "src1"}` ho. `map_entra_claims(claims) -> set[str]` likho jo app roles ko pehle use kare, GUIDs ko config se map kare, unknown ko ignore kare, aur overage pe ek `NeedsGraphLookup` exception de. Teen pytest cases likho.

**Read:** https://learn.microsoft.com/en-us/security/zero-trust/develop/configure-tokens-group-claims-app-roles
