# Bundle Size Aur Code Splitting: 4 MB JS Kaise Bana

> **Connects to**: [[51-fast-api-slow-page]] (backend fast tha, page slow tha -- bundle us waterfall ka sabse bada bar hai) aur [[33-react-performance-at-scale]] (data aa jaane ke baad render slow hona). Yahan sawaal uske pehle ka hai: **JS pehunchne, parse hone aur chalne mein hi 4 second kahan gaye.** | [[148-browser-rendering-pipeline]] (parse and render cost) | [[149-core-web-vitals]] (what INP actually measures)

## 1. Story

Dashboard ka build output:

```
dist/assets/index-8f2c1a.js   4.21 MB  (gzip: 1.18 MB)
```

Laptop par page 1.1s mein khulta hai, sab khush. QA ka mid-range Android, 4G par: **9 seconds** blank screen. Ticket aata hai "app slow hai". Team ka pehla reaction: *"lazy loading laga dete hain."*

Ye galat order hai. **Pehle naapo, phir kaato.** Warna aap teen din lazy loading laga ke paayenge ki 2.8 MB to ek hi dependency thi.

## 2. Pehle Naapo -- Bundle Ke Andar Jhaanko

Do tools, dono 5 minute ke:

```bash
# 1. Bundler analyzer -- treemap: kaunsa module kitni jagah le raha hai
npm i -D rollup-plugin-visualizer       # Vite/Rollup
# Next.js: @next/bundle-analyzer (ANALYZE=true next build) | Webpack: webpack-bundle-analyzer

# 2. source-map-explorer -- FINAL minified bundle ko source map se wapas original
#    files mein map karta hai. Yahi "sach" hai, pre-bundle dependency graph nahi.
npx source-map-explorer dist/assets/*.js
```

```javascript
// vite.config.ts
import { visualizer } from 'rollup-plugin-visualizer';
export default { plugins: [visualizer({ filename: 'stats.html', gzipSize: true, brotliSize: true })] };
```

**Gzip/brotli size dekho, raw nahi.** Network par brotli jaata hai; 4.2 MB raw ka matlab ~1.1 MB wire par. Dono numbers matter karte hain par alag reasons se -- wire size download time decide karta hai, **raw size parse/compile time decide karta hai** (section 7).

## 3. Usual Suspects -- Lagbhag Hamesha Yahi Nikalte Hain

| Culprit | Kaise dikhta hai treemap mein | Typical cost |
|---|---|---|
| **Date library with all locales** | `moment/locale/*` ya `date-fns/locale/*` ke 150 chhote blocks | 200-500 KB |
| **Poora icon set** | `@mui/icons-material` ya `react-icons` ka ek bada block jahan aap 12 icons use karte ho | 300 KB-1 MB |
| **`lodash` wholesale** | `import _ from 'lodash'` -> poora 70 KB+ | 70-90 KB |
| **Ek hi dependency ke do versions** | treemap mein `node_modules/x` **do** jagah | dep ka size x2 |
| **Chart library har page par** | `chart.js`/`recharts`/`plotly` main chunk mein | 150-900 KB |
| **Poora `aws-sdk` / `firebase`** | ek hi bada blob | 300 KB-1.5 MB |
| **Syntax highlighter with all languages** | `highlight.js` ke 190 language files | 400 KB+ |
| **`core-js` over-shipping** | browserslist target bahut purana set kiya hua | 100-200 KB |

Duplicate version wali cheez sabse zyada miss hoti hai:

```bash
npm ls react      # do react? to hooks bhi toot sakte hain.  npm dedupe se hoist karo
```

## 4. Fixes, Payoff Ke Order Mein

### 4.1 Route-based code splitting (sabse bada payoff, sabse kam risk)

Login page ko admin dashboard ka chart code kyun chahiye? Nahi chahiye.

```tsx
import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';

// Har lazy() ek alag chunk banata hai. Chunk tab download hota hai
// jab route pehli baar hit hoti hai.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Reports   = lazy(() => import('./pages/Reports'));   // charts isi ke andar
const Settings  = lazy(() => import('./pages/Settings'));

export default function App() {
  return (
    // fallback MUST be lightweight -- skeleton, spinner nahi
    <Suspense fallback={<PageSkeleton />}>
      <Routes>
        <Route path="/" element={<Home />} />           {/* eager: pehla paint */}
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </Suspense>
  );
}
```

Ek nuance jo interview mein achha lagta hai: lazy route ka chunk **click ke baad** download hota hai, yaani ek naya latency hop. Isliye **prefetch** karo -- link hover par, ya idle time par:

```tsx
const prefetchReports = () => import('./pages/Reports');   // warm the cache
<Link to="/reports" onMouseEnter={prefetchReports} onFocus={prefetchReports}>Reports</Link>
```

### 4.2 Dynamic `import()` for heavy below-the-fold widgets

Modal, rich-text editor, map, chart, PDF viewer, emoji picker -- ye sab **interaction par** chahiye, page load par nahi.

```tsx
function ExportButton() {
  const [busy, setBusy] = useState(false);
  async function onClick() {
    setBusy(true);
    // xlsx ~400 KB -- sirf us banda ke liye jo export dabaata hai
    const { utils, writeFile } = await import('xlsx');
    writeFile(utils.json_to_sheet(rows), 'report.xlsx');
    setBusy(false);
  }
  return <button onClick={onClick} disabled={busy}>Export</button>;
}
```

### 4.3 Tree-shaking -- aur wo kab kaam nahi karta

Log maante hain `import { debounce } from 'lodash'` chhota hai. Nahi.

```javascript
import _ from 'lodash';                    // poora 72 KB
import { debounce } from 'lodash';         // CJS hai -> bundler ko AB BHI poora lena padta hai
import debounce from 'lodash/debounce';    // ~2 KB  (per-file deep import)
import { debounce } from 'lodash-es';      // ~2 KB  (ESM build, shakeable)
```

Tree-shaking ke **teen** conditions hain, sab zaroori:

1. Library **ESM** ship karti ho (`"module"` ya `"exports"` mein ESM entry). CommonJS ka `require` static analyse nahi hota -- dynamic hai, isliye bundler kuch nahi kaat sakta.
2. Library `package.json` mein **`"sideEffects": false`** declare kare. Iske bina bundler maanta hai ki har module import hone par kuch global kaam kar sakta hai (prototype patch, CSS inject, polyfill register) -- aur safety ke liye use rakh leta hai.
3. Aapka **production build** ho. Dev server tree-shake nahi karta -- dev bundle dekhke panic mat karo.

```json
// aapki apni shared library ka package.json
{
  "sideEffects": ["*.css", "./src/polyfills.ts"],
  "exports": { ".": { "import": "./dist/index.mjs", "require": "./dist/index.cjs" } }
}
```

> `"sideEffects": false` jhooth bol diya aur kahin global patch tha -> prod mein mysteriously missing behaviour. Ye claim sach hona chahiye.

### 4.4 Heavy dep ko platform se replace karo

Sabse under-rated fix. Browser ke paas pehle se bahut kuch hai:

| Instead of | Platform |
|---|---|
| `moment` (290 KB) formatting ke liye | `Intl.DateTimeFormat`, `Intl.NumberFormat`, `Intl.RelativeTimeFormat` -- **0 KB** |
| `axios` (sirf JSON calls ke liye) | `fetch` + ek 20-line wrapper -- 0 KB |
| `uuid` | `crypto.randomUUID()` -- 0 KB |
| `lodash.debounce` | 8-line debounce, ya `AbortController` + `setTimeout` |
| `moment-timezone` | `Intl.DateTimeFormat(l, { timeZone })` |

```typescript
// 0 KB -- browser ke andar pehle se, aur locale data browser ke paas hai
new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(1234567.5);
new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date());
```

Aur jahan replace na ho sake, **chhota alternative** dekho: `date-fns` (per-function import) ya `dayjs` (2 KB) vs `moment`; `lightweight-charts` vs `plotly`.

### 4.5 Kaam server par bhejo

Sabse sasta JS wo hai jo browser mein hi nahi jaata:

- **Markdown/HTML sanitize, syntax highlight, PDF generate, CSV parse** -- server par karo, result bhejo. Highlight.js ke 190 languages browser mein kyun?
- **SSR / RSC**: Next.js server components ka code client bundle mein nahi jaata.
- **Aggregation**: 5 API calls aur client-side joins ki jagah ek BFF endpoint ([[51-fast-api-slow-page]]). Isse payload bhi chhota hota hai ([[48-huge-json-payloads]]).

## 5. Bytes Metric Nahi Hai -- Main-Thread Time Hai

Ye lesson ka sabse important section hai, aur yahi interview mein log miss karte hain.

500 KB gzip JS **download hone ke baad** ye hota hai:

```
download -> parse -> compile (V8 bytecode) -> execute (module init, framework boot) -> render
                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                     ye poora main thread par, SYNCHRONOUSLY
```

Aur main thread ek hi hai ([[137-event-loop-phases-and-microtasks]] ka wahi core idea, browser side par). Jab tak ye chal raha hai:

- koi click handle nahi hoga
- koi paint nahi hoga
- user ka tap 300 ms queue mein baithega -> **INP kharab**

Rough mental numbers (mid-range Android, ~3-5x slower than a laptop):

| Raw JS | Mid-range phone par parse+compile+execute |
|---|---|
| 200 KB | ~150-300 ms |
| 1 MB | ~1-2 s |
| 4 MB | ~4-8 s |

Do consequences:

1. **Raw (uncompressed) size** parse cost decide karta hai, gzip size nahi. Brotli ne wire par 4 MB ko 1 MB kiya, par parse ko 4 MB hi karna hai.
2. Bundle **chhota** karna aur bundle **baad mein** load karna -- dono main-thread time hi bachate hain. Lazy chunk ka code tab chalta hai jab user us feature par jaata hai, yaani cost **distributed** ho gaya.

Naapne ke liye: Lighthouse ka **"Reduce unused JavaScript"**, DevTools **Coverage** tab (kitna shipped code actually chala), aur **Performance** panel ka "Scripting" bar. Lab numbers ke saath **field data (RUM / CrUXes)** bhi dekho -- aapka laptop jhooth bolta hai ([[51-fast-api-slow-page]]).

> Target jo bolne layak hai: **main thread par koi bhi task 50 ms se lamba na ho** (long task). Bundle isi target ka sabse bada violator hai.

## 6. Caching Aur Vendor Chunk Hash Churn

Code splitting ka ek chhupa faida: **cache granularity**.

Ek 4 MB single bundle: aapne ek typo fix kiya -> hash badla -> user ne poore 4 MB dubara download kiye. Isliye log vendor chunk alag karte hain:

```
vendor-a91f3c.js   (react, router -- saal mein 4 baar badalta hai)
app-77b2e0.js      (aapka code -- din mein 3 baar badalta hai)
```

**Lekin ek classic galti**: agar vendor chunk ka hash **har deploy par** badal raha hai, to ye split bekaar hai -- user har deploy par 1 MB dubara utha raha hai. Wajah aksar:

- **Module order / IDs shift** ho jaate hain, jisse chunk content badal jaata hai bhale dependency same ho. (Modern Rollup/webpack 5 deterministic IDs use karte hain -- verify karo, assume nahi.)
- Sab dependencies ko **ek** vendor chunk mein daal diya, aur usme ek aisa package bhi hai jo aap har hafte bump karte ho.
- Build mein **timestamp / build id** inject ho raha hai jo shared chunk mein land kar raha hai.

Verify karna trivial hai: bina kuch change kiye do consecutive builds karo aur `ls dist/assets` ke hashes compare karo -- vendor hash **same** hona chahiye. Serving side ke rules:

| File | Cache-Control |
|---|---|
| `app-77b2e0.js` (hashed) | `public, max-age=31536000, immutable` |
| `index.html` | `no-cache` (ya short max-age) -- yahi naye hashes point karta hai |

Aur agar chunks bahut zyada chhote kar diye (50 chunks), to HTTP/2 par bhi per-request overhead aur dependency waterfall banta hai. **Sweet spot: route-level + heavy-widget-level, har component par nahi.**

## 7. CI Mein Budget Lagao, Warna Wapas Chadh Jaayega

Bundle size ek **ratchet** hai -- koi ek PR mein 300 KB dep add karega aur kisi ko pata nahi chalega. Isliye initial chunk par ek **hard number** lagao aur PR par fail karao: `size-limit` (`package.json` mein `{ "path": "dist/assets/index-*.js", "limit": "180 KB" }`), `bundlesize`, ya Lighthouse CI.

## 8. Common Galtiyan

- **Naapne se pehle fix karna.** Teen din splitting karne se pehle 10 minute treemap dekho.
- **Gzip size dekhke relax ho jaana** -- parse cost raw size par hai.
- **Har component ko `lazy()` kar dena** -- chunk waterfall aur spinner-flash, net loss.
- **`Suspense` fallback mein heavy skeleton** -- fallback hi ek naya render cost ban gaya.
- **Dev bundle size dekhke panic** -- dev mein tree-shaking aur minification off hote hain; aur `import { x } from 'lib'` ko automatically shakeable maan lena (section 4.3 ki teen conditions).
- **Lazy route par error boundary na lagana** -- chunk load fail (deploy ke baad purana hash 404) par poora app white screen. Ye real incident hai: ek `ErrorBoundary` jo chunk-load error par reload kare, must-have hai ([[02-debugging-random-500-errors]] ka frontend version).
- **Duplicate dependency versions ignore karna.**

## 9. Interview Mein Kaise Bolna Hai

*"Pehla step measure hai -- `source-map-explorer` ya bundler analyzer se treemap, gzip aur raw dono. Usually 70% weight 3-4 culprits mein hoti hai: date library with locales, poora icon set, lodash wholesale, ya ek dependency ke do versions. Phir payoff ke order mein: route-based splitting with `React.lazy` + `Suspense` plus hover prefetch, heavy widgets par dynamic `import()`, deep/ESM imports for tree-shaking -- jo sirf tab chalta hai jab lib ESM ho aur `sideEffects: false` ho -- aur jahan possible ho platform APIs (`Intl`, `crypto.randomUUID`, `fetch`) se dep replace karna. Important baat: metric bytes nahi, main-thread time hai -- 500 KB ko bhi parse, compile aur execute hona hai, aur wahi INP kharab karta hai, isliye main long tasks aur Coverage dekhta hoon. End mein caching: hashed chunks par `immutable`, `index.html` par `no-cache`, aur verify karta hoon ki vendor hash har deploy par na badle, warna split ka cache-faida zero hai. Aur CI mein size budget, warna size wapas chadh jaata hai."*

## 🧠 Remember

> Pehle bundle ko naapo (`source-map-explorer`/analyzer), kaato nahi -- weight 3-4 culprits mein hoti hai. Phir route-split, dynamic import, deep ESM imports aur platform APIs. Aur yaad rakho: **bytes metric nahi, main-thread time hai** -- 500 KB ko bhi parse, compile aur execute hona hai, aur hashed-chunk caching bekaar hai agar vendor hash har deploy par badalta rahe.

## Quick Self-Test

1. `import { debounce } from 'lodash'` poora lodash kyun le aata hai, aur `lodash-es` se kya badal jaata hai?
2. `"sideEffects": false` ka matlab kya hai, aur galat declare karne par prod mein kya tootega?
3. Gzip ne bundle 4 MB se 1 MB kar diya -- phone par parse time kis number par depend karta hai aur kyun?
4. Vendor chunk alag hai par hash har deploy par badal raha hai. Faida kya bacha, aur shak kahan karoge?
5. Aapne 40 components `lazy()` kar diye aur page aur slow ho gaya. Kya ho raha hai?
