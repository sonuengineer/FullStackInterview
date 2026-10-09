# Legacy Systems & Integrations

## Converting XML payloads to modern JSON formats

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M11-05, M11-06, M02-02

### Kahani
Logistics customer ka shipment system XML deta hai. OmniGuard ka frontend aur LLM tools JSON chahte hain. Kisi ne online "xml2json" library lagayi.
Shipment mein 3 items the to `items` list bana. Agle din ek shipment mein 1 item tha -- library ne list ki jagah object bana diya, frontend crash: `items.map is not a function`.
Weight `"12.50"` string tha, `delivered` `"Y"`, aur khali `<eta/>` empty string -- LLM ne "ETA is blank" ko "delivered already" samjha.
Aur security scan ne pakda: parser DTD entities resolve kar raha tha.
Fix: safe parser, explicit list fields, aur Pydantic se typed contract.

### What it is
**XML -> JSON conversion** = namespaces, attributes, repeated elements aur text-only types ko ek **stable JSON contract** mein map karna.
Generic converters guess karte hain; production mein aap schema (WSDL/XSD ya customer ka sample) se explicit mapping aur Pydantic model banate ho.

### Why it matters for an FDE
Har legacy integration ka output finally aapke API, UI ya LLM tool mein JSON ban ke jaata hai. Unstable shape = random crashes; galat types = galat answers jo confident lagte hain.

### Key concepts
- **Repeated elements -> lists** -- XSD mein `maxOccurs="unbounded"` wale fields ko hamesha list banao, chahe 0 ya 1 item ho.
- **Attributes** -- `<weight unit="kg">12.5</weight>` -> `{"weight": 12.5, "weight_unit": "kg"}`; naming convention ek baar decide karo.
- **Namespaces** -- `{uri}local` se match karo, prefix (`ns2:`) pe kabhi nahi; JSON keys mein sirf local name.
- **Type coercion** -- Pydantic: `Decimal`, `date`, `"Y"/"N"` -> bool, empty element -> `None`.
- **Safe parsing** -- `defusedxml` DTD/entity/external refs pe exception deta hai (XXE, billion laughs -- M11-07).

### Code example
`pip install defusedxml pydantic`

```python
# runnable
import json
from datetime import date
from decimal import Decimal
from typing import Annotated, Optional
import defusedxml.ElementTree as DET
from defusedxml import EntitiesForbidden
from pydantic import BaseModel, BeforeValidator

LEGACY = """<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
 <ns2:ShipmentResult xmlns:ns2="urn:acme:shipping" xmlns:x="urn:acme:ext">
  <ns2:shipment id="SH-1">
   <ns2:weight unit="kg">12.50</ns2:weight><ns2:delivered>N</ns2:delivered><ns2:eta/>
   <ns2:item sku="A1">Pump</ns2:item><ns2:item sku="B2">Valve</ns2:item>
   <x:note>fragile</x:note></ns2:shipment>
  <ns2:shipment id="SH-2">
   <ns2:weight unit="kg">3</ns2:weight><ns2:delivered>Y</ns2:delivered><ns2:eta>2026-10-12</ns2:eta>
   <ns2:item sku="C3">Gasket</ns2:item></ns2:shipment>
 </ns2:ShipmentResult></s:Body></s:Envelope>"""

local = lambda tag: tag.split("}")[-1]                     # "{urn:acme:shipping}item" -> "item"
def naive(el):                                             # what many xml2json libs do
    out = {}
    for c in el:
        v = naive(c) if len(c) else c.text
        out[local(c.tag)] = [out[local(c.tag)], v] if local(c.tag) in out else v
    return out
FORCE_LIST = {"item"}                                      # from the XSD: maxOccurs="unbounded"
def to_dict(el) -> dict:
    out = dict(el.attrib)                                  # element's own attributes: id, sku
    for c in el:
        key = local(c.tag)
        if key in FORCE_LIST:
            out.setdefault(key, []).append(to_dict(c))     # always a list, even for 1 item
        elif len(c):
            out[key] = to_dict(c)
        else:
            out[key] = (c.text or "").strip()
            for ak, av in c.attrib.items():
                out[f"{key}_{ak}"] = av                    # <weight unit="kg"> -> weight_unit
    if len(el) == 0 and el.text and el.text.strip():
        out["value"] = el.text.strip()                     # leaf with attributes: <item sku=..>Pump</item>
    return out

YesNo = Annotated[bool, BeforeValidator(lambda v: {"Y": True, "N": False}.get(v, v))]
class Item(BaseModel):
    sku: str
    value: str
class Shipment(BaseModel):
    id: str
    weight: Decimal
    weight_unit: str
    delivered: YesNo
    eta: Annotated[Optional[date], BeforeValidator(lambda v: v or None)] = None
    item: list[Item] = []
    note: Optional[str] = None

root = DET.fromstring(LEGACY)                              # defusedxml: rejects DTD entity tricks
ns = {"s": "http://schemas.xmlsoap.org/soap/envelope/", "sh": "urn:acme:shipping"}
nodes = root.findall("s:Body/sh:ShipmentResult/sh:shipment", ns)
raw = [naive(n) for n in nodes]
print("naive item types:", [type(r["item"]).__name__ for r in raw])    # ['list', 'str'] -> unstable!
ships = [Shipment.model_validate(to_dict(n)) for n in nodes]
print(json.dumps([s.model_dump(mode="json") for s in ships])[:300])
assert [type(r["item"]).__name__ for r in raw] == ["list", "str"]
assert all(isinstance(s.item, list) for s in ships) and len(ships[1].item) == 1
assert ships[0].weight == Decimal("12.50") and ships[0].weight_unit == "kg"
assert ships[0].delivered is False and ships[0].eta is None and ships[0].note == "fragile"
assert ships[1].eta == date(2026, 10, 12) and ships[1].item[0].sku == "C3"
evil = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>'
try:
    DET.fromstring(evil)
    raise AssertionError("XXE should be blocked")
except EntitiesForbidden:
    pass
print("OK: namespaces, attributes, stable lists, typed JSON, XXE blocked")
```

- `naive` -- 2 items pe list, 1 item pe string: wahi bug jo Kahani mein frontend crash karta hai.
- `FORCE_LIST` -- XSD ke `maxOccurs="unbounded"` se banta hai; `item` hamesha list of `{sku, value}`.
- `weight_unit` -- attribute ko sibling key banaya; `id`/`sku` jaise element ke apne attributes direct keys.
- Pydantic `BeforeValidator` -- `"Y"/"N"` -> bool, `""` -> `None`; `Decimal` money/weight ke liye (float nahi).
- `DET.fromstring(evil)` -- `EntitiesForbidden`; stdlib `xml.etree` ya default lxml pe ye payload trust karna risky hai.

### Mini-exercise (30-60 min)
OmniGuard `omniguard/integrations/soap_client.py` mein `policy_to_json(xml_bytes) -> dict` add karo.
- FORCE_LIST WSDL se auto-generate karo (M11-05 ka `maxOccurs` parser reuse).
- Pydantic `PolicyOut` model; API response aur agent tool output dono isi model se.
- Golden tests: 0, 1, 3 claims wale samples -> JSON shape same; `{"claimId": []}` 0 pe.
- Security test: DTD/entity payload -> 400 with "unsupported XML", 500 nahi.

### Common pitfalls
- Generic xml2json library pe bharosa -- single-vs-list aur attribute naming random; contract khud define karo.
- Money ko `float` -- `0.1 + 0.2` wali problem invoices mein; `Decimal` aur JSON mein string ya fixed precision.
- Namespace prefix pe match (`ns2:item`) -- server upgrade pe prefix `ns3` ho gaya, parser silently khali result.

### Checklist before moving on
- [ ] Repeated elements hamesha list bante hain, 1 item pe bhi.
- [ ] Attributes, namespaces aur empty elements ka mapping rule likha hua hai.
- [ ] Pydantic model types coerce karta hai, aur galat data pe clear error.
- [ ] Untrusted XML `defusedxml` se parse hota hai.

### Related
- M11-05 Understanding WSDL document structures and types
- M11-07 Parsing complex legacy XML responses safely
- M02-02 Pydantic data validation
- M05-08 Validating LLM responses natively against type hints

### Self-quiz
1. Naive converter 1 item pe object kyun bana deta hai, aur aap ise permanently kaise fix karoge?
2. `<eta/>` aur element ka na hona -- JSON mein dono ko same treat karna chahiye ya alag? Kab?
3. Weight ke liye `float` vs `Decimal` -- LLM tool output ke liye kya choose karoge?
4. XXE attack mein attacker kya padh sakta hai, aur `defusedxml` kis step pe rokta hai?
