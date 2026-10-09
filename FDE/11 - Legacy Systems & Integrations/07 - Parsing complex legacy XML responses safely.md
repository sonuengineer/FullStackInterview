# Legacy Systems & Integrations

## Parsing complex legacy XML responses safely

> Extended (slow track only) | Slow CP7 only | ~1.2 h

Legacy systems ke XML responses aksar "complex" hote hain: 5-6 namespaces, default namespace jo prefix ke bina aata hai, CDATA ke andar escaped XML, 50 MB batch exports, aur kabhi kabhi DTD bhi.
Sabse bada risk security ka hai: **XXE** (`<!ENTITY x SYSTEM "file:///etc/passwd">` se server files padhna ya internal URLs hit karna) aur **billion laughs** (nested entities jo memory phula ke process gira dete hain).
Rule: untrusted XML hamesha `defusedxml` se parse karo (`defusedxml.ElementTree.fromstring`, ya `defusedxml.lxml` style hardening) -- ye DTD/entities/external references pe exception phenkta hai. lxml direct use karna ho to `etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=False)`; zeep mein `Settings(forbid_dtd=True, forbid_entities=True, forbid_external=True)`.
Bade files ke liye `iterparse` + `elem.clear()` se streaming karo, poora tree memory mein mat lo. Namespaces ke liye hamesha explicit `ns` map aur `{uri}local` names -- prefixes server badal sakta hai, URI nahi.
Ek baat yaad rakho: XML parser bhi ek attack surface hai -- "ye to internal system hai" kehke hardening skip mat karo.

**Try this (20-40 min):** Ek billion-laughs payload (10 levels nested entities) aur ek XXE payload banao; `defusedxml.ElementTree.fromstring` pe dono ka exception type print karo, phir 20 MB generated XML ko `lxml.etree.iterparse` se stream karke peak memory (`psutil`) compare karo vs `etree.parse`.

**Read:** https://docs.python.org/3/library/xml.html#xml-vulnerabilities
