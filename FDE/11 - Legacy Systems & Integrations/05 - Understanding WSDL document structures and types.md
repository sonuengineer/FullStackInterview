# Legacy Systems & Integrations

## Understanding WSDL document structures and types

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M02-02

### Kahani
Insurance customer ka policy system 2009 ka hai. Unka architect ek `PolicyService.wsdl` file email karta hai: "Saari details isme hain." 600 lines ka XML, koi docs nahi, koi Swagger nahi.
OmniGuard agent ko "policy P-1 ka status batao" answer karna hai, matlab is service ko call karna padega.
Aapne ChatGPT se poocha "ye kya hai", usne `rpc/encoded` wala example diya -- par is service ka binding `document/literal` tha, aur pehli call fail.
WSDL padhna aana chahiye: kaunse operations, kaunse fields required, kaunse types, aur endpoint kahan.

### What it is
**WSDL** (Web Services Description Language) = SOAP service ka machine-readable contract -- REST ke liye jo OpenAPI hai, waisa hi.
Iske 5 hisse: `types` (XSD schema = data shapes), `message` (input/output parts), `portType` (abstract operations), `binding` (SOAP version, style, soapAction), `service` (endpoint URL).

### Why it matters for an FDE
Banks, insurers, hospitals, airlines -- core systems aaj bhi SOAP pe hain. WSDL padh ke aap 10 minute mein bata sakte ho "ye call possible hai, ye fields chahiye" -- bina customer ke developer ka wait kiye.

### Key concepts
- **types / XSD** -- `complexType` + `sequence` = object; `minOccurs="0"` = optional; `maxOccurs="unbounded"` = list; `simpleType` + `enumeration` = enum.
- **portType -> binding -> service** -- kya (abstract operation) -> kaise (SOAP 1.1/1.2, style) -> kahan (`soap:address location`).
- **document/literal (wrapped)** -- body mein ek element jo XSD se validate hota hai; aaj ka default, WS-I compliant. **rpc/encoded** -- purana style, element name = operation name, `xsi:type` annotations; zeep jaise tools iske saath kamzor hain.
- **soapAction** -- SOAP 1.1 mein HTTP header; galat ho to kai servers request reject karte hain.
- **Namespaces** -- `targetNamespace` har element ka "package name" hai; galat namespace = server ke liye unknown element.

### Code example
`pip install lxml`

```python
# runnable
import tempfile
from pathlib import Path
from lxml import etree

WSDL = """<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:acme:policy" targetNamespace="urn:acme:policy">
 <types><xs:schema targetNamespace="urn:acme:policy" elementFormDefault="qualified">
  <xs:simpleType name="Status"><xs:restriction base="xs:string">
    <xs:enumeration value="ACTIVE"/><xs:enumeration value="LAPSED"/></xs:restriction></xs:simpleType>
  <xs:complexType name="Policy"><xs:sequence>
    <xs:element name="number" type="xs:string"/><xs:element name="premium" type="xs:decimal"/>
    <xs:element name="status" type="tns:Status"/>
    <xs:element name="claimId" type="xs:string" minOccurs="0" maxOccurs="unbounded"/></xs:sequence></xs:complexType>
  <xs:element name="GetPolicyRequest"><xs:complexType><xs:sequence>
    <xs:element name="policyNumber" type="xs:string"/>
    <xs:element name="includeClaims" type="xs:boolean" minOccurs="0"/></xs:sequence></xs:complexType></xs:element>
  <xs:element name="GetPolicyResponse"><xs:complexType><xs:sequence>
    <xs:element name="policy" type="tns:Policy"/></xs:sequence></xs:complexType></xs:element>
 </xs:schema></types>
 <message name="GetPolicyIn"><part name="parameters" element="tns:GetPolicyRequest"/></message>
 <message name="GetPolicyOut"><part name="parameters" element="tns:GetPolicyResponse"/></message>
 <portType name="PolicyPort"><operation name="GetPolicy">
   <input message="tns:GetPolicyIn"/><output message="tns:GetPolicyOut"/></operation></portType>
 <binding name="PolicyBinding" type="tns:PolicyPort">
   <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
   <operation name="GetPolicy"><soap:operation soapAction="urn:acme:policy/GetPolicy"/>
     <input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation></binding>
 <service name="PolicyService"><port name="PolicyPortSoap" binding="tns:PolicyBinding">
   <soap:address location="https://legacy.acme.example/soap/policy"/></port></service>
</definitions>"""
NS = {"w": "http://schemas.xmlsoap.org/wsdl/", "soap": "http://schemas.xmlsoap.org/wsdl/soap/",
      "xs": "http://www.w3.org/2001/XMLSchema"}

with tempfile.TemporaryDirectory() as d:
    path = Path(d) / "PolicyService.wsdl"
    path.write_text(WSDL, encoding="utf-8")                   # customers send files; we read from disk
    parser = etree.XMLParser(resolve_entities=False, no_network=True)   # never fetch remote DTDs/imports
    root = etree.parse(str(path), parser).getroot()

local = lambda qname: qname.split(":")[-1]                    # "tns:GetPolicyIn" -> "GetPolicyIn"
schema = root.find("w:types/xs:schema", NS)

def fields_of(element_name: str) -> list[dict]:
    el = schema.find(f"xs:element[@name='{element_name}']", NS)
    return [{"name": f.get("name"), "type": f.get("type"), "required": f.get("minOccurs", "1") != "0",
             "list": f.get("maxOccurs") == "unbounded"} for f in el.iterfind(".//xs:element", NS)]

contract = {}
for op in root.iterfind("w:portType/w:operation", NS):
    in_msg = local(op.find("w:input", NS).get("message"))
    part = root.find(f"w:message[@name='{in_msg}']/w:part", NS)
    b_op = root.find(f"w:binding/w:operation[@name='{op.get('name')}']", NS)
    contract[op.get("name")] = {
        "input_element": local(part.get("element")), "fields": fields_of(local(part.get("element"))),
        "soapAction": b_op.find("soap:operation", NS).get("soapAction"),
        "use": b_op.find("w:input/soap:body", NS).get("use")}

style = root.find("w:binding/soap:binding", NS).get("style")
endpoint = root.find("w:service/w:port/soap:address", NS).get("location")
enum = [e.get("value") for e in schema.iterfind("xs:simpleType[@name='Status']//xs:enumeration", NS)]
policy = [(e.get("name"), e.get("type"), e.get("maxOccurs", "1")) for e in schema.iterfind("xs:complexType[@name='Policy']//xs:element", NS)]

print("style/use:", style, contract["GetPolicy"]["use"], "| endpoint:", endpoint)
for f in contract["GetPolicy"]["fields"]:
    print("  input field:", f)
print("  Policy type:", policy, "| Status enum:", enum)
assert (style, contract["GetPolicy"]["use"]) == ("document", "literal")          # document/literal
assert contract["GetPolicy"]["fields"][0] == {"name": "policyNumber", "type": "xs:string", "required": True, "list": False}
assert contract["GetPolicy"]["fields"][1]["required"] is False                   # minOccurs="0"
assert ("claimId", "xs:string", "unbounded") in policy and enum == ["ACTIVE", "LAPSED"]
assert schema.get("targetNamespace") == "urn:acme:policy"
print("OK: WSDL dissected -> operations, fields, types, binding, endpoint")
```

- `XMLParser(resolve_entities=False, no_network=True)` -- WSDL bhi untrusted XML hai; remote imports/entities fetch mat karo (M11-07).
- `portType` se operation, `message/part@element` se input element, `types` mein us element ke fields -- yahi chain har WSDL mein follow karo.
- `minOccurs="0"` = optional, `maxOccurs="unbounded"` = list; ye do attributes JSON mapping (M11-09) mein bahut kaam aate hain.
- `binding` se style/use aur `soapAction`; `service` se endpoint. Prod WSDL mein aksar endpoint internal hostname hota hai -- customer se confirm karo.
- Real WSDLs mein `xs:import`/`wsdl:import` se schemas alag files mein hote hain; saari files local folder mein rakho.

Ye contrast yaad rakho (same operation, rpc/encoded style):

```xml
<soap:Body xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <ns:GetPolicy xmlns:ns="urn:acme:policy" soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
    <policyNumber xsi:type="xsd:string">P-1</policyNumber>
  </ns:GetPolicy>
</soap:Body>
```

### Mini-exercise (30-60 min)
`fde-exercises/m11/wsdl_inspect.py` CLI banao: `python wsdl_inspect.py PolicyService.wsdl` -> har operation ke liye input/output fields table (name, type, required, list), style/use, soapAction, endpoint.
- Public sample WSDL download karke local file pe test karo (e.g. W3Schools ya kisi public calculator service ka WSDL), plus upar wala.
- Acceptance: `rpc` style binding mile to warning print kare; `xs:import` mile to "missing local file" clear error.
- Output ko Markdown table mein save karo -- customer kickoff call mein yahi share karoge.

### Common pitfalls
- `targetNamespace` ignore karke element banana -- server "unknown element" ya silent empty response deta hai.
- WSDL ko runtime pe har request mein remote URL se fetch karna -- slow, fragile, aur SSRF/XXE risk. Version-controlled local copy rakho.
- `minOccurs` ko JSON "optional" samajhna par `nillable="true"` bhool jaana -- `xsi:nil` aur missing element alag cheezein hain.

### Checklist before moving on
- [ ] WSDL ke 5 hisse aur unka order (what -> how -> where) bata sakta hoon.
- [ ] Kisi operation ke required input fields WSDL se nikal sakta hoon.
- [ ] document/literal vs rpc/encoded ka farq samajh aata hai.
- [ ] WSDL parse karte waqt network/entities band rakhta hoon.

### Related
- M11-06 Constructing valid XML SOAP envelopes using Python libraries like Zeep
- M11-07 Parsing complex legacy XML responses safely
- M11-09 Converting XML payloads to modern JSON formats
- M02-02 Pydantic data validation

### Self-quiz
1. `portType`, `binding` aur `service` mein kya farq hai? REST/OpenAPI mein inke equivalents kya honge?
2. Ek field `minOccurs="0" maxOccurs="unbounded"` hai. JSON/Pydantic mein iska type kya banega?
3. Server har request pe "unknown element" de raha hai jabki field names sahi hain. Pehle kya check karoge?
4. WSDL ko runtime pe remote URL se load karna kyun risky hai?
