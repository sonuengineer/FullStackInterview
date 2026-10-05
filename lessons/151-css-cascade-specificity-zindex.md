# CSS Cascade, Specificity Aur z-index Ki Ladai

> **Connects to**: [[150-css-layout-box-model-flexbox-grid]] (layout banane ke baad usko apply karwana), [[148-browser-rendering-pipeline]] (CSSOM cascade resolve karke banta hai) aur [[02-debugging-random-500-errors]] (same debugging instinct: guess mat karo, naapo).

## 1. "Maine Likha Hai, Lekin Apply Nahi Ho Raha"

Aapne likha:

```css
.btn { background: #2563eb; }
```

DevTools kholte ho -- aapki line **kati hui (struck through)** dikh rahi hai, aur koi doosri line jeet rahi hai. Aap `!important` lagate ho. Chal gaya. Aage badh gaye.

Do hafte baad kisi aur ko usi button ka color badalna hai. Unko aapka `!important` milta hai. Wo apna `!important` lagate hain, zyada specific selector ke saath. Chhe mahine baad codebase mein 400 `!important` hain aur koi bhi style confidently nahi badal sakta.

Ye CSS ki galti nahi hai. CSS ka ek **deterministic conflict-resolution algorithm** hai -- bilkul routing table ya permission resolution ki tarah. Aapko sirf uske rules pata hone chahiye. Pata hone ke baad "apply nahi ho raha" ek 20-second debug hai, guesswork nahi.

## 2. Cascade: Browser Winner Kaise Chunta Hai

Jab ek element par kai declarations match karti hain, browser **isi order mein** tie todta hai. Upar wala neeche wale ko dekhne hi nahi deta:

| # | Step | Detail |
|---|---|---|
| 1 | **Origin + importance** | user-agent -> author -> author `!important` -> user `!important`. Yaani aapka `!important` normal author CSS se upar hai |
| 2 | **Layers** (`@layer`) | Jo layer baad mein declare hui wo jeeti. Unlayered CSS layered se upar |
| 3 | **Inline style** | `style="..."` attribute, specificity se bhi upar (par `!important` se neeche) |
| 4 | **Specificity** | Selector ka score -- Section 3 |
| 5 | **Source order** | Barabar specificity par **jo baad mein likha hai wo jeeta** |

Step 5 wo hai jo sabse zyada bugs banata hai aur sabse kam yaad rahta hai: **same specificity par file ka order decide karta hai.** Isliye aapka `custom.css` library CSS ke **baad** load hona chahiye, warna aap specificity badhane ki ladai mein ghus jaayenge.

```html
<link rel="stylesheet" href="/vendor/bootstrap.css">
<link rel="stylesheet" href="/app.css">   <!-- baad mein = same specificity par jeet -->
```

Aur haan, cascade mein **DOM proximity ka koi role nahi hai**. "Ye selector element ke zyada paas hai" aisa concept CSS mein nahi hai (inheritance ek alag mechanism hai).

## 3. Specificity: Teen Number Ka Score

Specificity ek 3-tuple hai: **(ID, CLASS, TYPE)**. Isko left-to-right compare karo -- pehla column jeet gaya to baaki dekhe hi nahi jaate.

| Kya | Column | Example |
|---|---|---|
| ID | **A** | `#header` |
| Class, attribute, pseudo-class | **B** | `.btn`, `[type="text"]`, `:hover`, `:nth-child(2)` |
| Element type, pseudo-element | **C** | `div`, `a`, `::before` |
| `*`, `>`, `+`, `~`, `:where()` | -- | 0, kuch add nahi karta |

Worked examples:

| Selector | (A, B, C) | Note |
|---|---|---|
| `*` | 0,0,0 | |
| `p` | 0,0,1 | |
| `.btn` | 0,1,0 | **ek class 100 elements se bhaari hai** |
| `p.btn` | 0,1,1 | |
| `nav ul li a` | 0,0,4 | chaar elements, phir bhi ek class se haar jaata hai |
| `.nav .list .item` | 0,3,0 | |
| `a:hover` | 0,1,1 | `:hover` class count hoti hai |
| `#main .btn` | 1,1,0 | |
| `#main` | 1,0,0 | **`.a.b.c.d.e...` 100 classes se bhi jeet jaayega** |
| `style="..."` (inline) | -- | specificity se upar |
| koi bhi `!important` | -- | sabse upar (usi origin mein) |

Mental model: ye **base-10 ka number nahi hai**, ye lexicographic comparison hai. `0,3,0` vs `1,0,0` mein ID wala jeetega, chahe aap 50 classes jod do. Isliye "ek ID zyada laga dete hain" wali strategy ek dead end hai.

Do tricky cases jo interview mein poochhe jaate hain:

```css
/* :is() aur :not() apne ANDAR ke sabse bhaari argument ki specificity lete hain */
:is(#main, .side) p { }     /* -> 1,0,1  (ID se aayi) */
:not(.hidden) p { }         /* -> 0,1,1 */

/* :where() ki specificity ZERO hai -- chahe andar ID ho */
:where(#main, .side) p { }  /* -> 0,0,1  (sirf p count hua) */
```

`:where()` ka yahi asli use hai: **reset aur default styles likho jinhe koi bhi override kar sake bina ladai ke.** Design system aur CSS framework isi se base styles dete hain.

```css
/* Default jo aasaani se override ho jaaye */
:where(.card) { padding: 16px; border-radius: 8px; }
/* Ab .card { padding: 24px; } ek simple class se jeet jaayegi */
```

## 4. Inline Style Aur `!important` -- Dono Trap Hain

**Inline style aapki stylesheet se kyun jeetta hai:** cascade mein wo specificity ke *upar* ka step hai (Section 2 ka step 3). Isliye jab koi JS library (chart lib, drag-drop, animation lib, `element.style.x = ...`) inline style likh deti hai, to aapki external CSS bina `!important` ke usko nahi badal sakti.

Yahi ek legitimate `!important` use-case hai: **third-party ka inline style override karna.** Aur isko comment karo, warna agla banda nahi samjhega.

```css
/* vendor widget inline height likhta hai; iske bina layout toot jaata hai */
.vendor-widget { height: auto !important; }
```

**`!important` kaam kyun karta hai aur phir bhi galat kyun hai:** wo poora specificity system bypass kar deta hai. Problem ye nahi ki wo kaam karta hai -- problem ye hai ki usne aapka **escape hatch khatam kar diya**. Agli baar override karne ke liye kisi ko `!important` + higher specificity chahiye hoga, uske baad kisi ko aur. Ye ek ratchet hai: specificity sirf badh sakti hai.

> Rule: `!important` tabhi, jab aap wo CSS control nahi karte jisko override kar rahe ho. Apni hi CSS ke against `!important` lagana ek design smell hai -- matlab selectors already bahut specific ho chuke hain.

Debug karne ka tareeka (guess nahi): **DevTools -> Elements -> Styles panel.** Winning declaration sabse upar, haarne wali struck-through. Uske saath file aur line number dikhta hai. Agar aapki property list mein hi nahi hai, to teen possibilities: selector match nahi kar raha, property invalid hai (typo/unsupported value -- DevTools warning icon dikhata hai), ya wo property us element par apply hi nahi hoti (jaise `width` on inline element).

## 5. Stacking Context: `z-index: 9999` Fail Kyun Hota Hai

Ye wo part hai jo interviews ko pasand hai aur jo 90% log nahi jaante. Aur ye wo bug hai jo aapko production mein zaroor milega.

Pehle do rules:

1. **`z-index` sirf positioned elements par kaam karta hai** (`relative`, `absolute`, `fixed`, `sticky`) -- ya flex/grid items par. `position: static` wale par `z-index` silently ignore hota hai.
2. **`z-index` sirf apne stacking context ke *andar* compare hota hai.**

Rule 2 hi asli khel hai.

**Stacking context** ek self-contained layering box hai. Uske andar ke saare children isi box ke andar sort hote hain, aur poora box apne parent ke andar **ek single unit** ki tarah place hota hai. Bilkul process aur thread jaisa: thread priorities apne process ke andar compare hoti hain; OS pehle process ko schedule karta hai.

Backend analogy: ye **nested namespacing** hai. `z-index: 9999` ek *relative* priority hai apne namespace ke andar -- global nahi.

### Stacking context kaun banata hai

| Property | Note |
|---|---|
| `position: relative/absolute/fixed/sticky` + `z-index` != `auto` | Sabse common |
| `transform` (koi bhi value, `none` ke alawa) | **Yahan chhupa bug hota hai** |
| `opacity` < 1 | `opacity: 0.99` bhi |
| `filter`, `backdrop-filter` | |
| `will-change` with ek aisi property jo context banati hai | |
| `isolation: isolate` | Ye **deliberately** banane ke liye hai |
| `contain: paint`, `content-visibility` | |
| Root element `<html>` | Base context |
| `position: fixed` / `sticky` | `z-index: auto` ke saath bhi (fixed) |

Dhyan do: `transform` aur `opacity` -- wahi do properties jo [[148-browser-rendering-pipeline]] mein hum cheap animation ke liye recommend karte hain -- **chup-chaap stacking context bana deti hain**. Isliye animation add karne ke baad modal ka layering tootna ek classic combination hai.

### Asli bug: modal overlay ke peeche chala gaya

```html
<div class="card">            <!-- transform: translateY(-2px) on hover -->
  <button>Open</button>
  <div class="modal">...</div> <!-- z-index: 9999 -->
</div>
<div class="overlay"></div>    <!-- z-index: 1000 -->
```

```css
.card    { transform: translateY(0); }     /* <- STACKING CONTEXT ban gaya */
.modal   { position: fixed; z-index: 9999; }
.overlay { position: fixed; z-index: 1000; }
```

Result: modal overlay ke **peeche** hai, bhale uska `z-index` 9999 hai.

Kyun: `.modal` ka 9999 `.card` ke **andar** compare hota hai. Root context mein `.card` khud ka effective z-index `auto` (~0) hai. `.overlay` root context mein 1000 par hai. To comparison asli mein **0 vs 1000** hai -- 9999 vs 1000 nahi. Modal ke 9999 ko root level par koi dekh hi nahi raha.

Bonus pain: `.card` par `transform` hone se uske andar ka `position: fixed` bhi **viewport ke bajaye card ke relative** ho jaata hai -- `fixed` modal centred hona band ho jaata hai. Ek hi property se do bugs.

### Fixes, behtar se bakwaas ke order mein

```javascript
// 1. [BEST] Modal ko DOM mein body ke neeche portal karo -- root stacking context mein
createPortal(<Modal />, document.body);   // React
// Native: document.body.appendChild(modalEl)
```

```css
/* 2. Parent se context-creating property hatao (ya hover par hi lagao) */
.card { transform: none; }
.card:hover { transform: translateY(-2px); }  /* ab bhi context banta hai -- sirf hover par */

/* 3. Modal ko top layer mein le jao -- browser handle karta hai, z-index ki zaroorat nahi */
dialog::backdrop { background: rgb(0 0 0 / 0.5); }
/* <dialog> + el.showModal() -> top layer, saare stacking contexts se upar */

/* 4. [X] Ye kaam NAHI karega -- aur yahi log try karte hain */
.modal { z-index: 999999; }
```

`<dialog>` + `showModal()` aaj ka sahi jawab hai: wo element ko **top layer** mein daalta hai, jo poore stacking context system se bahar hai. Focus trap aur Esc handling muft milti hai.

**Debug karne ka tareeka:** DevTools -> Elements -> apne element par `z-index` dhundo, phir **parents ko upar jaake check karo** ki kisi par `transform`, `opacity`, `filter` ya `z-index` hai ya nahi. Chrome mein Layers panel bhi contexts dikhata hai. Pehla sawaal hamesha: *"mera element kis stacking context mein hai?"*

Aur ek discipline jo production mein bachata hai: **z-index ko tokens mein rakho**, random numbers mat likho.

```css
:root { --z-dropdown: 10; --z-sticky: 20; --z-overlay: 30; --z-modal: 40; --z-toast: 50; }
```

## 6. Specificity Ko Flat Rakhne Wale Patterns (Aur Wo Exist Kyun Karte Hain)

Saare modern CSS approaches ek hi problem solve karte hain: **specificity ko low aur flat rakho taaki override predictable rahe.**

| Approach | Kaise | Specificity |
|---|---|---|
| **BEM** -- `.card__title--large` | Nesting ki jagah flat class names | Hamesha `0,1,0` |
| **CSS Modules** -- `styles.title` | Build time par class name unique ban jaata hai (`title_x7f2a`) | `0,1,0`, collision impossible |
| **Utility classes** (Tailwind) -- `class="p-4 flex gap-2"` | Ek class ek declaration | Sab barabar; order source se |
| **`@layer`** | Explicit priority buckets (`reset`, `base`, `components`, `utilities`) | Layer order specificity se **pehle** decide karta hai |
| **`:where()`** | Zero-specificity defaults | `0,0,0` |

BEM ka asli point naming beauty nahi hai -- wo har selector ko **ek class** par rakhta hai, yaani saari cheezein `0,1,0` par hoti hain aur winner source order se decide hota hai, jo aap control kar sakte ho. Yahi reason hai ki mature codebases `nav ul li a.active span` jaise selectors ban kar deti hain: wo selector `0,1,4` hai aur usko override karne ke liye agle banda ko usse bhi badtameez selector likhna padega.

Aur `@layer` is problem ka proper solution hai, kyunki wo specificity se **upar** decide karta hai:

```css
@layer reset, base, components, utilities;   /* priority yahin fix ho gayi */

@layer components { #sidebar .nav-link { color: blue; } }  /* specificity 1,1,0 */
@layer utilities  { .text-red { color: red; } }            /* specificity 0,1,0 */
/* .text-red JEETEGA -- utilities layer baad mein declare hui hai.
   Pehle isi ke liye !important lagana padta tha. */
```

## 7. Common Galtiyan

- **Specificity ko base-10 number samajhna** -- ye tuple comparison hai; ek ID ko 100 classes nahi haraa sakti.
- **`z-index` static element par lagana** -- `position` ya flex/grid item ke bina ignore ho jaata hai.
- **`z-index` ko global samajhna** -- wo sirf apne stacking context ke andar compare hota hai.
- **Modal ko component ke andar hi rakhna** -- koi bhi parent `transform`/`opacity` add karte hi layering toot jaayegi. Portal to body.
- **Apni hi CSS ke against `!important`** -- iska matlab selectors bahut specific ho gaye hain; root cause wo hai.
- **Library CSS aapki CSS ke baad load karna** -- source order se aap silently haar rahe ho.
- **Selector ko specific karke jeetna** -- aaj jeet, kal ek aur ladai. Flat rakho.

## 8. Interview Mein Kaise Bolna Hai

*"Cascade pehle origin aur importance dekhta hai, phir layers, phir inline style, phir specificity, aur barabari hone par source order -- jo baad mein likha wo jeeta. Specificity ek (ID, class, type) tuple hai jo lexicographically compare hota hai, isliye ek ID ko kitni bhi classes nahi haraa sakti. Inline style specificity se upar hai, isliye jab koi JS library inline style likhti hai to `!important` ke bina override nahi hota -- aur mere liye `!important` ka sirf wahi valid use hai: jo CSS main control nahi karta. z-index ke liye main yaad rakhta hoon ki wo sirf apne stacking context ke andar compare hota hai, aur `transform`, `opacity` < 1, `filter` ya `will-change` naya context bana dete hain. Isliye `z-index: 9999` wala modal ek `transform` wale card ke andar overlay ke peeche chala jaata hai -- fix hai modal ko body mein portal karna ya `<dialog>` ka top layer use karna, z-index badhana nahi. Aur architecture level par main specificity flat rakhta hoon -- flat classes, CSS modules, utilities, `@layer` -- aur defaults `:where()` mein likhta hoon kyunki uski specificity zero hoti hai."*

## 🧠 Remember

> CSS random nahi hai: origin -> layer -> inline -> specificity -> source order, aur specificity ek tuple hai, number nahi. Aur `z-index: 9999` tab fail hota hai jab element kisi parent ke stacking context mein phasa ho -- `transform` ya `opacity < 1` wo context chup-chaap bana deti hai, to modal ko body mein portal karo, number mat badhao.

## Quick Self-Test

1. `#main p` aur `.a.b.c.d.e p` -- kaun jeetega aur kyun? Agar specificity exactly barabar hoti to kya decide karta?
2. Aapki stylesheet ek element ka color nahi badal pa rahi, aur DevTools mein inline style dikh raha hai. Kya ho raha hai, aur `!important` ke alawa aapka option kya hai?
3. `:is(#main, .side) p`, `:not(.x) p` aur `:where(#main, .side) p` -- teeno ki specificity batao.
4. Ek modal ka `z-index: 9999` hai, overlay ka `1000` hai, aur modal phir bhi peeche hai. Pehla cheez kya check karoge, aur fix kya hoga?
5. `transform: translateY(-2px)` jaisa "harmless" CSS modal ka layering kaise tod deta hai -- aur `position: fixed` par uska doosra side effect kya hai?
6. `@layer` ka istemaal `!important` ki jagah kaise le leta hai?
