# Legacy Systems & Integrations

## Constructing valid XML SOAP envelopes using Python libraries like Zeep

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M11-05

### Kahani
Insurance customer ki WSDL aapne padh li (M11-05). Ab OmniGuard ko `GetPolicy` call karna hai.
Pehla try: f-string se XML banaya. Policy number mein `&` aaya, XML toot gaya. Kisi ne namespace prefix galat likha, server ne generic "500 Internal Error" diya -- koi hint nahi.
Customer ka staging SOAP server sirf VPN pe hai, aur din mein do ghante band rehta hai. Har galti debug karne ke liye wait.
Sahi tareeka: WSDL se envelope **generate** karo (Zeep), offline build karke XML assert karo, aur sirf tab real server ko bhejo.

### What it is
**Zeep** = Python SOAP client. WSDL padh ke operations aur XSD types ko Python callables bana deta hai: `client.service.GetPolicy(policyNumber="P-1")`.
`client.create_message(client.service, "GetPolicy", ...)` envelope ko bina bheje `lxml` element ke roop mein deta hai -- tests aur debugging ke liye perfect.

### Why it matters for an FDE
Haath se likha XML escaping, namespaces aur element order mein galti karta hai, aur legacy servers error messages nahi dete. Zeep XSD ke against validate karke wahi galti aapke laptop pe pakad leta hai.

### Key concepts
- **Envelope** -- `soap-env:Envelope` > optional `Header` (auth, WS-Security) > `Body` > operation ka wrapper element (document/literal).
- **Offline build** -- `create_message` + `etree.tostring`; snapshot tests mein exact XML assert karo.
- **Client-side validation** -- missing required field = `zeep.exceptions.ValidationError`; unknown kwarg = `TypeError`, network se pehle.
- **Transport** -- `Transport(timeout=..., operation_timeout=...)`: WSDL load aur operation dono ke timeouts; custom transport se fake server bhi.
- **Endpoint override** -- `client.create_service(binding_qname, url)` se staging/prod URL config se aata hai, WSDL ke hardcoded address se nahi.

### Code example
`pip install zeep lxml`

```python
# runnable
import tempfile
from decimal import Decimal
from pathlib import Path
import requests, zeep
from lxml import etree
from zeep.transports import Transport

WSDL = """<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:acme:policy" targetNamespace="urn:acme:policy">
 <types><xs:schema targetNamespace="urn:acme:policy" elementFormDefault="qualified">
  <xs:complexType name="Policy"><xs:sequence><xs:element name="number" type="xs:string"/>
    <xs:element name="premium" type="xs:decimal"/><xs:element name="status" type="xs:string"/>
    <xs:element name="claimId" type="xs:string" minOccurs="0" maxOccurs="unbounded"/></xs:sequence></xs:complexType>
  <xs:element name="GetPolicyRequest"><xs:complexType><xs:sequence><xs:element name="policyNumber" type="xs:string"/>
    <xs:element name="includeClaims" type="xs:boolean" minOccurs="0"/></xs:sequence></xs:complexType></xs:element>
  <xs:element name="GetPolicyResponse"><xs:complexType><xs:sequence>
    <xs:element name="policy" type="tns:Policy"/></xs:sequence></xs:complexType></xs:element></xs:schema></types>
 <message name="In"><part name="parameters" element="tns:GetPolicyRequest"/></message>
 <message name="Out"><part name="parameters" element="tns:GetPolicyResponse"/></message>
 <portType name="PolicyPort"><operation name="GetPolicy"><input message="tns:In"/><output message="tns:Out"/></operation></portType>
 <binding name="PolicyBinding" type="tns:PolicyPort"><soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
  <operation name="GetPolicy"><soap:operation soapAction="urn:acme:policy/GetPolicy"/>
   <input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation></binding>
 <service name="PolicyService"><port name="P" binding="tns:PolicyBinding">
  <soap:address location="https://legacy.acme.example/soap/policy"/></port></service></definitions>"""

REPLY = b"""<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<p:GetPolicyResponse xmlns:p="urn:acme:policy"><p:policy><p:number>P-1&amp;2</p:number><p:premium>120.50</p:premium>
<p:status>ACTIVE</p:status><p:claimId>C1</p:claimId><p:claimId>C2</p:claimId></p:policy></p:GetPolicyResponse></s:Body></s:Envelope>"""

class FakeTransport(Transport):
    """Same interface zeep uses for HTTP; returns a canned reply instead of touching the network."""
    def __init__(self):
        super().__init__(timeout=5, operation_timeout=15)
        self.sent = []
    def post(self, address, message, headers):
        self.sent.append((address, message, headers))
        r = requests.Response()
        r.status_code, r._content, r.encoding = 200, REPLY, "utf-8"
        r.headers["Content-Type"] = "text/xml; charset=utf-8"
        return r

with tempfile.TemporaryDirectory() as d:
    path = Path(d) / "PolicyService.wsdl"
    path.write_text(WSDL, encoding="utf-8")
    fake = FakeTransport()
    client = zeep.Client(wsdl=str(path), transport=fake)

    env = client.create_message(client.service, "GetPolicy", policyNumber="P-1&2", includeClaims=True)
    xml = etree.tostring(env, pretty_print=True).decode()
    print(xml)
    ns = {"s": "http://schemas.xmlsoap.org/soap/envelope/", "p": "urn:acme:policy"}
    assert env.find("s:Body/p:GetPolicyRequest/p:policyNumber", ns).text == "P-1&2"
    assert "P-1&amp;2" in xml                                         # escaping done for us
    assert env.find("s:Body/p:GetPolicyRequest/p:includeClaims", ns).text == "true"   # xs:boolean
    try:
        client.create_message(client.service, "GetPolicy", includeClaims=True)
        raise AssertionError("should fail")
    except zeep.exceptions.ValidationError as e:
        print("caught before network:", e)
    try:
        client.service.GetPolicy(policyNumber="P-1", polcyNumber="typo")
        raise AssertionError("should fail")
    except TypeError:
        assert fake.sent == []                                        # nothing was sent

    staging = client.create_service("{urn:acme:policy}PolicyBinding", "https://staging.acme.example/soap/policy")
    policy = staging.GetPolicy(policyNumber="P-1&2")                  # full round trip via FakeTransport
    address, _, headers = fake.sent[0]
    assert address == "https://staging.acme.example/soap/policy"
    assert headers["SOAPAction"] == '"urn:acme:policy/GetPolicy"'
    assert policy.premium == Decimal("120.50") and policy.claimId == ["C1", "C2"]
    assert zeep.helpers.serialize_object(policy, dict)["number"] == "P-1&2"
print("OK: envelope built offline, validated, endpoint overridden, reply parsed to typed values")
```

- `create_message` -- envelope bina network ke; `assert` se namespace, escaping (`&amp;`) aur `true` boolean check.
- `ValidationError` / `TypeError` -- required field missing ya typo wala kwarg network se pehle pakda gaya; `fake.sent == []` iska proof.
- `FakeTransport.post` -- zeep ka asli HTTP hook override; tests mein canned reply, response parsing bhi real zeep code se hoti hai.
- `create_service(binding, url)` -- endpoint config se; WSDL mein likha prod URL kabhi bhi galti se hit na ho.
- Response mein `Decimal` aur list automatically -- XSD types ka fayda; `serialize_object` se plain dict (M11-09 JSON ke liye).

```python
# real version -- not run here, needs: pip install zeep; customer VPN + credentials
import os
import requests
from zeep import Client, Settings
from zeep.transports import Transport
from zeep.wsse.username import UsernameToken

session = requests.Session()
session.verify = os.environ.get("SOAP_CA_BUNDLE", True)          # customer's internal CA, never verify=False
transport = Transport(session=session, timeout=10, operation_timeout=20)
client = Client("wsdl/PolicyService.wsdl", transport=transport,     # local, version-controlled WSDL
                settings=Settings(strict=True, xml_huge_tree=False),
                wsse=UsernameToken(os.environ["SOAP_USER"], os.environ["SOAP_PASSWORD"]))  # if they use WS-Security
svc = client.create_service("{urn:acme:policy}PolicyBinding", os.environ["POLICY_SOAP_URL"])
policy = svc.GetPolicy(policyNumber="P-1")
```

### Mini-exercise (30-60 min)
OmniGuard: `omniguard/integrations/soap_client.py` banao.
- `PolicyClient(wsdl_path, endpoint, timeout)` -- `get_policy(number) -> dict` (`serialize_object`), endpoint/creds env se.
- `wsdl/` folder repo mein; tests `FakeTransport` se: envelope snapshot test (`tests/snapshots/get_policy.xml`), missing field, typo kwarg, reply parsing.
- Debug flag: `SOAP_DEBUG=1` pe sent/received XML log ho -- par `<password>`, `UsernameToken` aur PII fields redact karke.
- Agent tool `get_policy_status` isi client ko call kare; tool output sirf `number, status, premium`.

### Common pitfalls
- f-string se XML banana -- escaping, namespaces aur element order ki galtiyan; legacy server sirf "500" bolega.
- `verify=False` "kyunki customer ka cert internal hai" -- uska CA bundle lo; MITM risk security review mein pakda jayega.
- Timeouts na dena -- legacy SOAP servers minutes tak hang karte hain; worker pool khatam.

### Checklist before moving on
- [ ] Local WSDL se zeep client bana ke envelope offline print kar sakta hoon.
- [ ] Envelope ka snapshot test likha hai.
- [ ] Endpoint config se aata hai, WSDL ke address se nahi.
- [ ] Timeouts, TLS verify aur credentials env/secrets se set hain.

### Related
- M11-05 Understanding WSDL document structures and types
- M11-08 Handling SOAP faults and legacy error codes
- M11-09 Converting XML payloads to modern JSON formats
- M11-15 Sandboxing and staging before legacy production changes

### Self-quiz
1. `create_message` aur `client.service.Op(...)` mein kya farq hai? Tests mein kaunsa kyun?
2. WSDL ka `soap:address` prod URL hai. Aap staging pe kaise call karoge bina WSDL edit kiye?
3. Ek field ka naam galat likha. Zeep ke saath ye kab pakda jayega, aur f-string XML ke saath kab?
4. Server 30 s mein jawab nahi deta. Kaunsa timeout trigger hoga aur user ko kya milna chahiye?
