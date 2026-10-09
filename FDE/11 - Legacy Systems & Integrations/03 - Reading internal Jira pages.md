# Legacy Systems & Integrations

## Reading internal Jira pages

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M06-01, M12-07

### Kahani
SaaS customer ki support team chahti hai ki OmniGuard "pichle 90 din ke billing bugs" aur Confluence runbooks se answer de. Pehle version mein kisi ne Jira ka HTML page scrape kiya -- login cookie, JavaScript-rendered page, aur har release ke baad selectors toot gaye.
Doosri problem: RAG index mein `{"type":"doc","content":[...]}` jaisa raw JSON chala gaya, retrieval mein garbage.
Teesri: HR project ke confidential tickets bhi index ho gaye, kyunki API token ek Jira admin ka tha.
Sahi tareeka: official REST API, JQL se scoped query, ADF/storage format ko clean text mein convert, aur har chunk pe permission metadata.

### What it is
**Jira Cloud REST API v3** -- JQL search endpoint issues return karta hai; `description` aur comments **ADF** (Atlassian Document Format, nested JSON) mein aate hain.
**Confluence** pages ka body "storage format" (XHTML with `ac:` macros) mein aata hai. FDE ka kaam: inko paginate karke fetch karna, clean text banana, aur metadata ke saath RAG pipeline mein dena.

### Why it matters for an FDE
Har enterprise customer ka tribal knowledge Jira/Confluence mein hai. Scraping toot-ti hai, admin token se sab kuch leak hota hai, aur dirty text se retrieval quality gir jaati hai.

### Key concepts
- **JQL** -- `project = BILL AND updated >= -90d ORDER BY updated DESC`; `fields` param se sirf zaroori fields mangao (payload chhota, PII kam).
- **Pagination** -- naya search endpoint (`/rest/api/3/search/jql`) `nextPageToken` deta hai; purana `startAt`/`total` wala deprecate ho raha hai -- apne instance ke liye docs check karo.
- **ADF -> text** -- recursive walk: `text` nodes jodo, `paragraph`/`listItem`/`heading` ke baad newline.
- **Auth** -- Cloud pe Basic `email:api_token` (service account ka) ya OAuth 2.0 (3LO) with read scopes only (e.g. `read:jira-work`). Data Center pe Personal Access Token.
- **Permission metadata** -- har chunk pe `project`, `security_level`, `url`; retrieval time pe user ke access se filter (M12-07).

### Code example
`pip install httpx lxml`

```python
# runnable
import base64
import httpx
import lxml.html

def adf_to_text(node: dict) -> str:
    """Flatten Atlassian Document Format into plain text with line breaks between blocks."""
    if node.get("type") == "text":
        return node.get("text", "")
    if node.get("type") == "hardBreak":
        return "\n"
    inner = "".join(adf_to_text(c) for c in node.get("content", []))
    block = node.get("type") in {"paragraph", "heading", "listItem", "codeBlock", "blockquote"}
    return inner.strip() + "\n" if block else inner

def storage_to_text(xhtml: str) -> str:
    """Confluence storage format -> text. Macros (ac:*) are dropped; extend if you need code blocks."""
    root = lxml.html.fragment_fromstring(xhtml, create_parent="div")
    for el in [e for e in root.iter() if isinstance(e.tag, str) and e.tag.startswith("ac:")]:
        el.drop_tree()
    lines = [" ".join(el.text_content().split()) for el in root.iter("p", "li", "h1", "h2", "h3", "td")]
    return "\n".join(l for l in lines if l)

PAGES = [  # two pages of a fake /rest/api/3/search/jql response
    {"issues": [{"key": "BILL-1", "fields": {"summary": "Invoice total wrong", "updated": "2026-09-01T10:00:00.000+0000",
        "project": {"key": "BILL"}, "description": {"type": "doc", "version": 1, "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "Tax applied "}, {"type": "text", "text": "twice", "marks": [{"type": "strong"}]}]},
            {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "EU customers only"}]}]}]}]}}}],
     "nextPageToken": "tok2"},
    {"issues": [{"key": "BILL-2", "fields": {"summary": "Refund stuck", "updated": "2026-09-05T08:00:00.000+0000",
        "project": {"key": "BILL"}, "description": None}}], "isLast": True},
]

calls = []
def fake_jira(req: httpx.Request):
    calls.append(req)
    if req.url.path.startswith("/wiki/api/v2/pages/"):
        return httpx.Response(200, json={"id": "42", "title": "Refund runbook", "body": {"storage": {"value":
            "<h1>Refunds</h1><p>Check <strong>Stripe</strong> first.</p><ac:structured-macro ac:name='toc'/><ul><li>Escalate after 48h</li></ul>"}}})
    return httpx.Response(200, json=PAGES[1] if req.url.params.get("nextPageToken") == "tok2" else PAGES[0])

token = base64.b64encode(b"svc-omniguard@example.com:fake-api-token").decode()   # real: from secrets manager
http = httpx.Client(base_url="https://example.atlassian.net", transport=httpx.MockTransport(fake_jira),
                    headers={"Authorization": f"Basic {token}", "Accept": "application/json"}, timeout=10.0)

def search_issues(jql: str, fields: list[str], page_size: int = 50):
    params = {"jql": jql, "fields": ",".join(fields), "maxResults": page_size}
    while True:
        data = http.get("/rest/api/3/search/jql", params=params).raise_for_status().json()
        yield from data["issues"]
        if data.get("isLast") or not data.get("nextPageToken"):
            break
        params["nextPageToken"] = data["nextPageToken"]

docs = []
for issue in search_issues("project = BILL AND updated >= -90d ORDER BY updated DESC", ["summary", "description", "updated", "project"]):
    f = issue["fields"]
    body = adf_to_text(f["description"]) if f["description"] else ""
    docs.append({"id": issue["key"], "text": f"{f['summary']}\n{body}".strip(), "acl_project": f["project"]["key"],
                 "url": f"https://example.atlassian.net/browse/{issue['key']}", "updated": f["updated"]})

page = http.get("/wiki/api/v2/pages/42", params={"body-format": "storage"}).json()
docs.append({"id": "conf-42", "text": page["title"] + "\n" + storage_to_text(page["body"]["storage"]["value"]), "acl_project": "SUPPORT"})

for d in docs:
    print(d["id"], "|", d["text"].replace("\n", " / "))
assert [d["id"] for d in docs] == ["BILL-1", "BILL-2", "conf-42"] and len(calls) == 3
assert docs[0]["text"] == "Invoice total wrong\nTax applied twice\nEU customers only"
assert "toc" not in docs[2]["text"] and "Escalate after 48h" in docs[2]["text"]
assert calls[0].url.params["fields"] == "summary,description,updated,project"
print("OK: JQL pagination, ADF and storage format -> clean text with ACL metadata")
```

- `search_issues` -- generator, `nextPageToken` follow karta hai jab tak `isLast`; memory mein poora result nahi rakhta.
- `fields=` -- sirf 4 fields; Jira issue mein 100+ custom fields hote hain, bina filter ke payload bhaari aur PII zyada.
- `adf_to_text` -- marks (bold) ignore, blocks ke baad newline. Tables, mentions, `inlineCard` jaise nodes ke liye cases badhane padenge.
- `storage_to_text` -- `ac:` macros drop; block elements se lines. Code macros chahiye to `ac:plain-text-body` alag se nikalo.
- `acl_project` -- har doc pe permission tag; retrieval layer isse user ke allowed projects se filter karegi.

### Mini-exercise (30-60 min)
OmniGuard: `omniguard/integrations/jira.py` mein `JiraReader` banao.
- Config: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` (env), `JIRA_JQL`. Token service account ka, sirf zaroori projects pe browse permission.
- `iter_documents()` -> `{"id","text","acl_project","url","updated"}`; ingestion M06 pipeline mein chunk + embed.
- Incremental sync: last run ka `updated` timestamp store karo, agli baar `updated >= "<ts>"` JQL.
- Tests `httpx.MockTransport` se: 2 pages, empty description, 401 (clear error message), 429 with `Retry-After`.

### Common pitfalls
- Admin ya personal token se index karna -- RAG ab wo dikhayega jo asking user ko dekhna allowed nahi.
- Rate limits (429) ignore karna -- Atlassian Cloud throttle karta hai; `Retry-After` honour karo, backoff lagao (M14-02).
- Deleted/moved issues index mein reh jaate hain -- periodic full reconcile ya delete events (webhooks) chahiye.

### Checklist before moving on
- [ ] JQL + `fields` + pagination wala search loop likh sakta hoon.
- [ ] ADF aur Confluence storage format ko clean text mein convert karna aata hai.
- [ ] Har document pe permission metadata hai.
- [ ] Token least-privilege service account ka hai, secrets manager mein.

### Related
- M11-04 Automating ticket creation
- M06-01 Fixed-size and semantic chunking
- M06-08 Metadata filtering
- M12-07 Enforcing data-level permissions in retrieval layers
- M14-02 Exponential backoff strategies

### Self-quiz
1. Jira HTML scrape karne ke bajaye REST API kyun? Teen reasons do.
2. `fields` param na do to kya nuksaan hai (cost aur security dono)?
3. User X ko HR project dikhna allowed nahi. Aapka index aur retrieval ye kaise ensure karta hai?
4. Incremental sync mein ek issue delete ho gaya. Wo index se kaise hatega?
