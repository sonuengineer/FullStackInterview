# Identity & Access Management

## SAML assertions

> Extended (slow track only) | Slow CP7 only | ~1.2 h

**SAML 2.0** = XML based SSO protocol, OIDC se pehle ka enterprise standard. Do players: **IdP** (Identity Provider -- ADFS, Entra ID, Okta, Ping) jo user ko login karata hai, aur **SP** (Service Provider -- aapka app) jo trust karta hai. User browser se IdP pe login karta hai, IdP ek signed **assertion** browser ke through SP ke **ACS URL** pe POST karta hai.
Assertion ke andar: `Issuer`, `Subject/NameID` (user), `Conditions` (`NotBefore`, `NotOnOrAfter`, `AudienceRestriction` = aapka SP entity id), `AuthnStatement` (kab, kaise login hua), aur `AttributeStatement` (email, groups, roles) -- poora XML-DSig se signed.
FDE ko ye kahan milega: bade banks, government, pharma -- jahan ADFS ya purane IdP chal rahe hain aur "hum OIDC enable nahi karenge, SAML metadata lo" sunne ko milta hai. Aksar aap ek broker (Entra ID, Auth0, Keycloak) beech mein rakhte ho jo SAML le aur aapke app ko OIDC/JWT de -- isse app code M12-02 jaisa hi rehta hai.
Ek baat yaad rakho: **SAML XML khud kabhi parse/verify mat karo** -- XML signature wrapping attacks ne kai bade products tode hain. Maintained library (python3-saml, pysaml2) ya broker use karo, aur signature, audience, time window, `InResponseTo` sab check hone chahiye.

**Try this (20-40 min):** samltool.com ya mocksaml.com jaisa test IdP lo, ek sample SAML Response decode karo (base64 -> XML) aur usme Issuer, NameID, Audience, NotOnOrAfter aur group attributes pehchano. Phir `defusedxml` se parse karke ye fields Python mein nikaalo (sirf padhne ke liye -- verification library ka kaam hai) aur ek line likho ki inme se kaunsa check fail hone pe aap login reject karoge.

**Read:** https://docs.oasis-open.org/security/saml/Post2.0/sstc-saml-tech-overview-2.0.html
