# What's the Difference Between a URI and a URL?

## 1. The Short Answer

- **URI (Uniform Resource Identifier)** - a string that **identifies** a resource.
- **URL (Uniform Resource Locator)** - a URI that also tells you **where the resource is and how to get it** (a scheme/protocol plus a location).
- **URN (Uniform Resource Name)** - a URI that **names** a resource in a permanent way, without saying where it is.

**Every URL is a URI. Not every URI is a URL.**

## 2. Simple Analogy

> Your **name** identifies you (like a URN). Your **home address** identifies you *and* says how to find you (like a URL). Both are "identifiers" (URIs), but only the address lets someone actually reach you.

## 3. Examples

| String | Is it a URI? | URL? | Why |
|---|---|---|---|
| `https://shop.com/orders/42?tab=items#summary` | Yes | Yes | Scheme + host tell you how and where to fetch it |
| `mailto:help@shop.com` | Yes | Yes (commonly treated as one) | Scheme says how to reach it |
| `urn:isbn:9780134685991` | Yes | No | Names a book, doesn't say where to get it |
| `/orders/42` | A relative reference | Not by itself | Needs a base URL to become a full URL |

## 4. Anatomy of a URL

```
https://user@shop.com:443/orders/42?tab=items#summary
\___/   \__/ \______/ \_/\________/ \_______/ \_____/
scheme  user   host   port  path      query   fragment
```

- **scheme**: how to access it (`https`, `ftp`, `mailto`)
- **host + port**: where
- **path**: which resource on that server
- **query**: parameters
- **fragment**: a spot inside the page - handled by the browser, **never sent to the server**

## 5. Does It Matter in Practice?

In everyday web development, people use "URL" for web addresses and nobody minds. The distinction matters in specs, APIs, and some library names (Java has both `java.net.URI` and `java.net.URL`; in the browser, `new URL(...)` parses full URLs). In an interview, the one-liner above plus one URN example is enough.

## 6. 🧠 Remember

> A URI identifies; a URL identifies and locates. Every URL is a URI, but a URN like `urn:isbn:...` is a URI that names something without telling you where to find it.
