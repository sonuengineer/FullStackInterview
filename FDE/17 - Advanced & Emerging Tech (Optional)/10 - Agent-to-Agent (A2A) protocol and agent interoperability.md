# Advanced & Emerging Tech (Optional)

## Agent-to-Agent (A2A) protocol and agent interoperability

> Extended (slow track only) | Slow CP10 only | ~1.2 h

**A2A** ek open protocol hai (Google ne shuru kiya, ab Linux Foundation project) jisse alag-alag vendors/frameworks ke agents ek doosre se baat kar sakein. Har agent ek **Agent Card** publish karta hai (JSON: naam, skills, endpoint, auth requirements), client agent usse discover karta hai aur ek **task** bhejta hai; task ka lifecycle hota hai (submitted -> working -> input-required -> completed/failed), messages/artifacts HTTP + JSON-RPC pe, long tasks ke liye streaming ya push notifications.
**MCP vs A2A:** MCP = agent-to-*tool* (model ko DB, API, files dena); A2A = agent-to-*agent* (ek opaque agent ko poora kaam delegate karna, jiska andar ka prompt/tools aapko nahi dikhte). Dono saath use ho sakte hain.
FDE isse tab milta hai jab customer ke paas pehle se ek vendor agent hai (CRM, HR, ticketing) aur aapka agent usse kaam karwana chahta hai bina custom integration ke.
Ek baat yaad rakho: protocol abhi naya hai aur fields/versions badal rahe hain -- implement karne se pehle current spec padho; aur remote agent ko untrusted maano (auth, timeouts, output validation, prompt injection -- M13-02).

**Try this (20-40 min):** Spec padhke ek sample Agent Card JSON likho ek "invoice-lookup" agent ke liye (skills, endpoint, auth scheme). Phir ek sequence diagram (ASCII) banao: aapka orchestrator -> card discovery -> task send -> input-required -> completed, aur har step pe likho kya fail ho sakta hai aur aap kaise handle karoge.

**Read:** https://a2a-protocol.org/latest/
