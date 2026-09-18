# The API Is Fast, But Users Say It's Slow (80ms Backend, 4.8s Experience)

> **Similar-question flag**: this is close to [[33-react-performance-at-scale]] (backend fine, browser is the bottleneck). That lesson was about **rendering a big list** after data arrives. This one is about the **whole page-load timeline**: everything that happens between the user pressing Enter and seeing something usable.

## 1. Story

Backend: 80ms. Database: 20ms. Yet users wait 4.8 seconds before the page is usable. Where did the other 4.7 seconds go?

## 2. The Key Insight

Your 80ms is the time **one API call** spends on **your server**. The user experiences the **whole journey**:

`DNS -> TCP/TLS handshake -> download HTML -> download + parse + execute JavaScript -> render -> fetch data (maybe many calls, maybe one after another) -> render again -> images/fonts load`

The backend is one small slice of that timeline.

## 3. Where to Investigate (in This Order)

**1. Open the browser's Network tab (waterfall view).** It shows every request on a timeline. Look for:
- A **request waterfall**: call A must finish before call B starts, then C. Five sequential 80ms calls plus network latency each is already over a second. This is [[13-hidden-latency-bottleneck]] happening in the browser: fix it by running independent calls in parallel, or by adding one endpoint that returns everything the page needs.
- **Huge JavaScript bundles**: a 3 MB bundle must be downloaded, parsed, and executed before anything useful appears, especially slow on mid-range phones.
- **Large unoptimized images** or web fonts blocking text from showing.

**2. Check network distance.** 80ms on the server can be 300ms+ for a user on the other side of the world. Static assets should come from a **CDN**, and repeat visits should hit the browser cache (correct `Cache-Control` headers).

**3. Check how the page renders.** A pure client-side-rendered app shows a blank screen until JS loads, runs, *then* fetches data. Server-side rendering or static generation can show content much earlier.

**4. Run Lighthouse / Core Web Vitals.**
- **TTFB** (Time To First Byte): server + network. Yours is probably fine.
- **LCP** (Largest Contentful Paint): when the main content appears. This is likely where the 4.8s shows up.
- **INP** (Interaction to Next Paint): how quickly the page responds to clicks and typing.

**5. Measure real users, not just your laptop.** Real User Monitoring (RUM) shows what people on slow phones and 4G actually experience; your fast dev machine on office Wi-Fi hides most of this.

## 4. Fixes, Matched to Cause

| Finding | Fix |
|---|---|
| Sequential API calls | Parallelize, or one aggregated endpoint (BFF) |
| Huge JS bundle | Code-splitting, lazy loading, remove unused libraries |
| Blank screen until JS runs | SSR / static generation, skeleton UI |
| Slow assets far from user | CDN + caching headers |
| Heavy images | Compress, modern formats (WebP/AVIF), lazy-load below the fold |
| Slow after load | See [[33-react-performance-at-scale]] |

## 5. Mental Model

> "The API is fast" measures one slice of the timeline. Users feel the whole timeline. Measure end-to-end from the user's device, then find the biggest bar in the waterfall.

## 6. Flow

```mermaid
flowchart LR
  A[DNS + TLS] --> B[HTML]
  B --> C["JS bundle 3MB: download + parse + run"]
  C --> D["API call 1 (80ms)"]
  D --> E["API call 2 (waits for 1)"]
  E --> F["API call 3 (waits for 2)"]
  F --> G[Render + images]
```

## 7. Common Mistakes

- Treating backend latency as "the" latency and closing the ticket.
- Testing only on a fast laptop and fast network, never on a mid-range phone on mobile data.

## 8. 🧠 Remember

> An 80ms API can still produce a 4.8s page: check the network waterfall for sequential calls, bundle size, and distance to the user, and measure what real users experience, not just what your server logs.

## 9. Quick Self-Test

1. What does TTFB measure, and why can it be good while LCP is terrible?
2. How does a request waterfall turn five fast calls into a slow page?
3. Why can a big JavaScript bundle hurt more on phones than on laptops?
