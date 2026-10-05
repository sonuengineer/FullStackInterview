# Core Web Vitals: LCP, INP, CLS Aur Asli Fixes

> **Connects to**: [[51-fast-api-slow-page]] (80ms API, 4.8s experience -- Vitals usi gap ko naapne ki language hai), [[148-browser-rendering-pipeline]] (ye metrics pipeline ke kis stage ko measure karte hain) aur [[20-sudden-latency-spike-checklist]] (server-side spike jo LCP mein dikhta hai).

## 1. Ek Email Jo Aapko Aayega

PM ka message: *"Google Search Console bol raha hai hamare 62% URLs 'Needs improvement' hain. LCP 4.1s, CLS 0.28. Ye theek karna hai is sprint mein."*

Aap backend dekhte ho: p95 API latency 90 ms, error rate 0.02%, CPU 30%. Sab green. Phir ye numbers kahan se aa rahe hain?

Kyunki ye **server metrics nahi hain**. Ye asli users ke Chrome se, asli phones par, asli network par collect hue hain. Aapka p95 server latency sirf ek chhoti line hai us timeline mein. Core Web Vitals wo language hai jisme "page slow lagta hai" ek number ban jaata hai -- aur jab aap unka matlab samajh lo, "slow" turant debuggable ho jaata hai.

## 2. Teen Metrics, Teen Alag Sawaal

| Metric | Asli sawaal | Pipeline mein kahan |
|---|---|---|
| **LCP** -- Largest Contentful Paint | "Main content **kab dikha**?" | Network + render |
| **INP** -- Interaction to Next Paint | "Click karne par page **kab respond kiya**?" | Main thread |
| **CLS** -- Cumulative Layout Shift | "Content **kood** to nahi raha?" | Layout |

Teeno jaan-boojh ke **user-perceived** hain, technical nahi. Isliye `load` event kahin nahi hai -- user ko `load` se matlab nahi, usko *dikhne* aur *chalne* se matlab hai.

### Thresholds

Likhne ke time par (**aaj ke numbers web.dev par confirm kar lo -- ye pehle badle hain, aur FID ko INP ne replace kiya hai**):

| Metric | Good | Needs improvement | Poor |
|---|---|---|---|
| LCP | <= 2.5 s | 2.5 - 4.0 s | > 4.0 s |
| INP | <= 200 ms | 200 - 500 ms | > 500 ms |
| CLS | <= 0.1 | 0.1 - 0.25 | > 0.25 |

Ek aur cheez jo log galat bolte hain: ye thresholds **p75 par** dekhe jaate hain -- aapke 75% page views. Average nahi. Matlab average acha ho sakta hai aur phir bhi aap fail ho sakte ho, bilkul p99 latency ki tarah ([[13-hidden-latency-bottleneck]]).

## 3. LCP -- "Main Content Kab Dikha"

LCP wo waqt hai jab viewport ka **sabse bada content element** paint hua. Candidate hota hai: `<img>`, `<video>` ka poster, background-image wala block, ya ek bada text block (H1, hero paragraph).

Ek baat clear karo: LCP element **time ke saath badalta hai**. Pehle H1 LCP tha, phir hero image aayi aur wo bada tha, to LCP element wo ban gaya. Element final decide hota hai jab user pehla interaction kare ya page hide ho jaaye. Chrome DevTools -> Performance -> timeline par LCP marker -> wo exactly kaun element hai, bata deta hai. **Pehle ye dekho, phir fix socho.**

LCP ke chaar sub-parts hote hain, aur fix isi par depend karta hai:

```
TTFB  ->  resource load delay  ->  resource load time  ->  render delay
```

| Cause | Kaise pehchano | Fix (payoff ke order mein) |
|---|---|---|
| **TTFB slow** (server/DB/no cache) | TTFB 600 ms+ | Server-side fix -- query, cache, CDN. Yahan aapka backend skill seedha kaam aata hai ([[20-sudden-latency-spike-checklist]]) |
| **Hero image late discover** hui (CSS/JS ke andar chhupi thi) | Waterfall mein image bahut baad shuru hoti hai | `<img>` HTML mein rakho (CSS background nahi), `fetchpriority="high"`, `<link rel="preload">` |
| **Image bahut badi** | 2.4 MB PNG for a 600px slot | Sahi dimensions, WebP/AVIF, `srcset` for responsive |
| **Hero image par `loading="lazy"`** | LCP image lazy ho gayi | Above-the-fold image par **kabhi** lazy nahi -- `loading="eager"` |
| **Text LCP font ke wait mein** | FCP acha, LCP kharab | `font-display: swap` + font preload |
| **Client-side render** -- JS aane tak kuch nahi | Blank screen, phir sab ek saath | SSR/SSG, ya server se hero HTML bhejo |

```html
<!-- Hero image: discoverable, prioritized, sized, modern format -->
<link rel="preconnect" href="https://cdn.example.com">
<img src="/hero-1200.avif"
     srcset="/hero-600.avif 600w, /hero-1200.avif 1200w"
     sizes="(max-width: 640px) 100vw, 1200px"
     width="1200" height="630"
     fetchpriority="high" loading="eager" decoding="async" alt="">
```

> Backend dev ke liye sabse bada insight: **LCP ka ek bada hissa aapka TTFB hai.** Agar TTFB 800 ms hai, to 2.5 s ka budget ka ek-tihaai pehle hi gaya -- aur koi image optimization usko wapas nahi laayega.

## 4. INP -- "Click Ke Baad Page Zinda Hai Ya Nahi"

INP naapta hai: user ne interact kiya (click, tap, keypress) -- us input se **agla frame paint** hone tak kitna time laga. Ye **pehle ke FID ko replace karta hai**: FID sirf *input delay* naapta tha (handler shuru hone tak), INP poora cycle naapta hai -- delay + handler ka kaam + render. Yaani jhooth bolna mushkil ho gaya.

Teen hisse:

```
input delay  ->  processing time (aapka handler)  ->  presentation delay (render)
```

**Kyun 300 ms "toota hua" lagta hai:** human perception mein ~100 ms tak cheez "instant" lagti hai. 300 ms par user ko lagta hai click register hi nahi hua, to wo **dobara click karta hai** -- aur ab aapke paas duplicate submit bhi hai. Frontend ka slow INP seedha backend ka idempotency problem ban jaata hai.

Asli wajah almost always: **main thread par long task** ([[148-browser-rendering-pipeline]] -- ek hi thread sab karta hai).

| Cause | Fix |
|---|---|
| Handler mein bhaari sync kaam (10k rows filter/sort, bada `JSON.parse`) | Kaam todo (`scheduler.yield()`, `setTimeout 0`), ya Web Worker mein bhejo |
| Click par poora bada list re-render | Virtualize + memoize ([[33-react-performance-at-scale]]) |
| Har keystroke par API call + re-render | Debounce input, `useTransition` for non-urgent updates |
| Hydration ke dauran click | Code-split, hydration ka kaam kam karo |
| Third-party script main thread kha raha hai | `async`, ya poora hatao -- naapo kitna cost hai |

```javascript
// [X] Ek click, 420 ms ka block -- INP poor
button.onclick = () => {
  const rows = parseAndSort(bigArray);   // 400 ms sync
  render(rows);
};

// [OK] Pehle feedback do, phir kaam yield karte hue karo
button.onclick = async () => {
  setBusy(true);                                 // ye frame turant paint hoga -> INP acha
  await new Promise((r) => setTimeout(r, 0));    // browser ko paint karne do
  const rows = await parseAndSortChunked(bigArray, { chunk: 500 });
  render(rows);
};
```

Mental model: **INP ko kaam jaldi khatam karna nahi chahiye, usko *feedback* jaldi chahiye.** Spinner ya disabled state ka frame 50 ms mein paint ho gaya, to INP acha hai -- bhaari kaam uske baad chale to chalta hai.

## 5. CLS -- "Content Kood Kyun Raha Hai"

CLS wo score hai jo *unexpected* layout shifts jodta hai: kitna area khiska, kitni doori khiska. User-initiated shift (aapne accordion kholi) count nahi hota -- sirf wo jo apne aap ho jaaye.

Ye sabse irritating UX bug hai: aap "Reject" par tap karne ja rahe the, ad load hua, button neeche shift hua, aapne "Accept" dabaa diya.

| Cause | Kya hota hai | Fix |
|---|---|---|
| **Image/video without dimensions** | Browser 0 height maanta hai, image aane par neeche ka sab khiskta hai | `width` + `height` attributes, ya `aspect-ratio: 16/9` |
| **Injected banner / cookie bar / ad** | Content ke upar DOM insert hota hai | Jagah pehle se reserve karo (`min-height`), ya overlay/fixed banao jo flow mein na ho |
| **Web font swap** | Fallback font se real font par switch, metrics badalte hain | `font-display: optional`/`swap` + `size-adjust`, `font-family` fallback metrics match karo, font preload |
| **Late CSS** | Unstyled se styled jump | Critical CSS inline (see [[148-browser-rendering-pipeline]]) |
| **Skeleton ka size asli content se alag** | Skeleton 80px, content 140px -> shift | Skeleton ko exact dimensions do |

```css
/* Ek line jo bahut saara CLS maar deti hai */
img, video { max-width: 100%; height: auto; }   /* + HTML mein width/height attributes */

/* Dynamic slot ki jagah pehle reserve */
.ad-slot { min-height: 250px; }
```

CLS ka ek chhupa hua case: `position: fixed` ya `absolute` element shift nahi karta (wo flow mein nahi hai). Isliye promo bar ko flow mein daalne ke bajaye overlay banana often sahi answer hai.

## 6. Lab Data vs Field Data -- Yahi Sawaal Candidates Ko Girata Hai

Ye wo part hai jo interview mein senior/junior ka farak dikha deta hai.

| | **Lab data** | **Field data (RUM)** |
|---|---|---|
| Kahan se | Lighthouse, PageSpeed "Lab", CI | Asli users ke browsers |
| Kaise | Ek simulated device, ek throttled network, ek load | Hazaaron real sessions, p75 |
| Source | Aapka laptop / CI runner | Chrome UX Report (CrUX), `web-vitals` library |
| INP milega? | **Nahi** -- lab mein koi click nahi karta. Lighthouse TBT proxy deta hai | Haan, asli |
| Kaam | Regression pakadna, before/after compare | **Sach** -- Search Console aur ranking yahi dekhta hai |

Dono **poori tarah** disagree kar sakte hain, aur ye normal hai:

- **Lighthouse 98, field poor** -- aapke users 3-saal-purane Android par 4G par hain; lab ka emulated device unse fast hai. Ya aapka cache cold path kabhi test hua hi nahi.
- **Lighthouse 55, field good** -- lab aggressive throttling karta hai aur ek cold load leta hai; asli users ke paas warm cache aur achhe devices hain.

Isliye production practice ye hai: **field measure karo, lab se debug karo.**

```javascript
// Real users se Vitals bhejo -- yahi aapka "RUM for frontend" hai
import { onLCP, onINP, onCLS } from 'web-vitals';

function send(metric) {
  // sendBeacon page unload par bhi reliable hai, fetch nahi
  navigator.sendBeacon('/rum', JSON.stringify({
    name: metric.name,            // LCP | INP | CLS
    value: metric.value,
    rating: metric.rating,        // good | needs-improvement | poor
    id: metric.id,
    path: location.pathname,
    // debug ke liye sabse qeemti field: kaun element zimmedaar tha
    target: metric.attribution?.element ?? metric.attribution?.largestShiftTarget,
  }));
}
onLCP(send); onINP(send); onCLS(send);
```

Ab is data ko route, device type aur country se slice karo. Yahan aapka backend observability instinct seedha apply hota hai: **p75 dekho, average nahi; aur dimension ke hisaab se slice karo** -- warna ek slow route poore site ka score kharab dikha dega.

## 7. Kaam Kis Order Mein Karoge

1. **Field data pakdo** (CrUX / `web-vitals`). Bina iske aap andhere mein optimize karoge.
2. **Kaun route aur kaun metric fail hai** -- sab kuch ek saath mat theek karo.
3. **Attribution dekho**: LCP ka element kaun, CLS ka shift kaun, INP ka interaction kaun.
4. **TTFB pehle** -- wo aapka ghar hai aur wo LCP ka floor set karta hai.
5. **CLS sabse sasta win hai** -- `width`/`height` attributes aur reserved slots, ek afternoon ka kaam.
6. **INP ke liye long tasks todo** -- feedback frame pehle, kaam baad mein.
7. **Lab test CI mein lagao** regression rokne ke liye, par pass/fail field par judge karo.

## 8. Common Galtiyan

- **Average dekhna** -- thresholds p75 par hain.
- **Lighthouse score ko goal maan lena** -- wo ek weighted lab number hai, aapki ranking aur users field data par chalte hain.
- **INP ko FID samajhna** -- INP poora interaction naapta hai, isliye jo pages FID mein pass ho rahe the wo INP mein fail hote hain.
- **Hero image par `loading="lazy"` lagana** -- ye LCP ko seedha kharab karta hai. Lazy sirf below-the-fold ke liye.
- **CLS ke liye `transform` se element hilana aur khush ho jaana** -- transform-based movement CLS mein count nahi hota, par agar wo user-visible jump hai to UX problem waise hi hai.
- **"Vitals SEO ka kaam hai"** -- nahi, ye product metric hai; slow INP double-submits aur abandoned carts banata hai.

## 9. Interview Mein Kaise Bolna Hai

*"Teen metrics: LCP main content kab dikha, INP interaction ke baad agla paint kab hua -- ye FID ko replace karta hai -- aur CLS kitna unexpected layout shift hua. Thresholds roughly 2.5s / 200ms / 0.1 hain, p75 par naape jaate hain. LCP ko main chaar parts mein todta hoon -- TTFB, resource discovery, download, render delay -- aur usually jeet TTFB aur hero image ke discovery par hoti hai: image HTML mein, `fetchpriority=high`, sahi size aur AVIF/WebP, aur kabhi `loading=lazy` nahi. INP ka reason almost always main thread par long task hota hai, to main pehle ek feedback frame paint karta hoon phir kaam chunks mein ya worker mein karta hoon. CLS ke liye images ko dimensions aur dynamic slots ko reserved height. Aur sabse important: main lab data se debug karta hoon par judge field data se, kyunki Lighthouse 95 ke saath bhi real users poor ho sakte hain."*

## 🧠 Remember

> LCP = "dikha kab?", INP = "respond kab kiya?", CLS = "kooda kitna?" -- teeno p75 par real users se naape jaate hain. Lighthouse ek lab simulation hai jo aapko *kahan dekho* batata hai; sirf field data batata hai *kya sach hai*.

## Quick Self-Test

1. Aapka LCP 4.2 s hai aur TTFB 900 ms. Image optimize karne se pehle aap kya karoge, aur kyun?
2. INP ne FID ko replace kyun kiya -- INP aisa kya naapta hai jo FID chhod deta tha?
3. Lighthouse 97 deta hai par Search Console "poor LCP" bolta hai. Dono sach kaise ho sakte hain, aur aap kis par kaam karoge?
4. Hero image par `loading="lazy"` lagane se kaun metric kharab hoga aur kyun?
5. Teen alag-alag cheezein batao jo CLS banati hain, aur har ek ka fix.
