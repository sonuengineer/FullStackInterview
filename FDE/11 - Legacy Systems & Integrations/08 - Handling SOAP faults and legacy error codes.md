# Legacy Systems & Integrations

## Handling SOAP faults and legacy error codes

> Extended (slow track only) | Slow CP7 only | ~1.2 h

SOAP error do tarah se aata hai. Pehla: **SOAP Fault** -- `Body` ke andar `Fault` element (SOAP 1.1: `faultcode`, `faultstring`, `detail`; SOAP 1.2: `Code/Value`, `Reason/Text`, `Detail`), aksar HTTP 500 ke saath. Zeep isko `zeep.exceptions.Fault` banata hai (`.message`, `.code`, `.detail` as lxml element).
Doosra, zyada khatarnak: HTTP 200 + normal response, par andar `<ReturnCode>E1042</ReturnCode>` ya `<Status>-7</Status>` -- legacy apps errors ko data ki tarah bhejte hain. Inko check nahi kiya to agent "success" bol dega.
FDE ka kaam: customer se error code table maango, ek mapping banao -- `{code: (category, retryable, user_message)}` -- jaise `Client`/validation = retry mat karo, `Server`/timeout/"system busy" = bounded retry (M14-02), auth = alert.
Agent/LLM ko raw fault string mat dikhao (internal hostnames, stack traces leak hote hain); clean category + safe message do, raw detail sirf redacted logs mein.
Yaad rakho: legacy system mein "200 OK" ka matlab sirf "message pahunch gaya" hai, "kaam ho gaya" nahi.

**Try this (20-40 min):** M11-06 wale `FakeTransport` se teen replies banao -- SOAP 1.1 Fault, HTTP 200 with `<ReturnCode>E1042</ReturnCode>`, aur 503 -- aur ek `call_policy()` wrapper likho jo teeno ko apne `LegacyError(category, retryable)` mein map kare, tests ke saath.

**Read:** https://docs.python-zeep.org/en/master/client.html
