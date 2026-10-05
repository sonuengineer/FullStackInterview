# CSS Layout: Box Model, Flexbox vs Grid

> **Connects to**: [[148-browser-rendering-pipeline]] (layout pipeline ka wo stage hai jisko ye lesson control karta hai), [[151-css-cascade-specificity-zindex]] (style apply kyun nahi ho raha) aur [[100-react-interview-7-points-hinglish]] (component ke andar ka layout).

## 1. Aap CSS Likh Lete Ho, Par Bharosa Nahi Hai

Backend dev ka CSS workflow kuch aisa hota hai: Stack Overflow se snippet, `display: flex` thoka, `justify-content: center` try kiya, kaam nahi kiya, `align-items: center` try kiya, chal gaya, aage badh gaye. Kaam ho gaya -- par **kyun** chala, pata nahi. Aur isi wajah se jab layout toote, aap debug nahi kar sakte, sirf guess kar sakte ho.

Asli baat: CSS layout mein **teen** cheezein samajh lo, to 90% kaam deterministic ho jaata hai --

1. Box ka size kaise count hota hai (box model).
2. Ek axis ka kaam Flexbox, do axis ka Grid.
3. Centering aur margins ke do classic traps.

Baaki sab inke upar hai.

## 2. Box Model: Aapka 300px Wala Box 342px Kyun Hai

Har element ek box hai: **content -> padding -> border -> margin**.

```
+-------------- margin (bahar ki jagah, background nahi) ---------------+
|  +------------ border ----------------------------------------------+ |
|  |  +--------- padding (andar ki jagah, background haan) --------+  | |
|  |  |                      content                              |  | |
|  |  +-----------------------------------------------------------+  | |
|  +------------------------------------------------------------------+ |
+----------------------------------------------------------------------+
```

Default `box-sizing: content-box` mein `width: 300px` ka matlab hai **content** 300px. Padding aur border uske **upar** jude:

```css
.card { width: 300px; padding: 16px; border: 5px solid; }
/* Asli screen width = 300 + 16*2 + 5*2 = 342px  -> grid toot gaya */
```

Isliye duniya ka lagbhag har codebase pehli hi line mein ye likhta hai:

```css
*, *::before, *::after { box-sizing: border-box; }
```

`border-box` ke saath `width: 300px` ka matlab hai **total box 300px**, padding aur border usi 300 ke andar adjust ho jaate hain. Yaani aap jo likhte ho, wahi milta hai. Backend analogy: `content-box` "payload size" hai, `border-box` "packet size including headers" -- aur layout karte waqt aapko packet size chahiye hoti hai. Bonus: `width: 100%` + `padding` bhi finally expected behave karta hai -- yahi wo "input container se bahar nikal raha hai" wala bug hai.

## 3. Decision Rule: Flexbox Ya Grid

Internet par isko mystery bana diya gaya hai. Honest rule ek line ka hai:

> **Flexbox = ek dimension** (ek row *ya* ek column, content ko jagah batne do).
> **Grid = do dimensions** (rows *aur* columns ek saath, aap structure pehle define karte ho).

Doosra tareeka sochne ka: **Flex content-driven hai** (items apni size ke hisaab se settle hote hain), **Grid container-driven hai** (aap grid banate ho, items usme baithte hain).

| Case | Choice | Kyun |
|---|---|---|
| Navbar: logo left, links right | **Flex** | Ek row, items ki apni width |
| Button + icon side by side | **Flex** | Ek row, chhota |
| Form: label upar, input neeche, stacked | **Flex** (column) | Ek column |
| Toolbar jo wrap ho jaaye | **Flex** + `flex-wrap` | Ek row jo tootti hai |
| Card list, responsive, equal columns | **Grid** | Columns define karne hain |
| Page shell: header / sidebar / main / footer | **Grid** | Rows aur columns dono |
| Dashboard jahan ek widget 2 columns leta hai | **Grid** | Spanning Grid ka kaam hai |

Aur sach ye hai: **dono ek saath use hote hain.** Page shell Grid, uske andar ka navbar Flex. Ye competing technologies nahi hain.

## 4. Flexbox: Jo Properties Asli Mein Use Hoti Hain

```css
.nav {
  display: flex;
  flex-direction: row;           /* row (default) | column | row-reverse */
  gap: 16px;                     /* margin hacks ki zaroorat khatam */
  justify-content: space-between;/* MAIN axis par distribution */
  align-items: center;           /* CROSS axis par alignment */
  flex-wrap: wrap;               /* jagah na ho to nayi line */
}
```

### Wo ek cheez jo sabko confuse karti hai: axes

`justify-content` aur `align-items` fixed directions nahi hain. Wo **main axis** aur **cross axis** par kaam karte hain, aur main axis `flex-direction` decide karta hai:

| `flex-direction` | Main axis | `justify-content` kya karta hai | `align-items` kya karta hai |
|---|---|---|---|
| `row` | horizontal | left-right distribution | **vertical** alignment |
| `column` | vertical | **top-bottom** distribution | **horizontal** alignment |

Yahi wajah hai ki `flex-direction: column` lagane ke baad aapka `justify-content: center` "kaam karna band" kar deta hai -- usne band nahi kiya, uska axis ghoom gaya.

Mental model: **`justify` = flow ke saath, `align` = flow ke across.**

### `flex: 1` ke andar kya hai

`flex` teen properties ka shorthand hai: `flex-grow flex-shrink flex-basis`.

```css
.item { flex: 1; }        /* = flex: 1 1 0%   -> extra jagah lo, sikudo bhi, basis 0 */
.item { flex: 1 1 auto; } /* basis = content size, uske baad grow/shrink */
.item { flex: 0 0 240px; } /* fixed 240px, na badhega na ghatega -- sidebar pattern */
.item { flex: 2; }        /* iske siblings jo flex:1 hain, unse 2x extra jagah */
```

Jo bug sabse zyada aata hai: `flex: 1` vs `flex: 1 1 auto`. `flex: 1` ka basis **0** hai, isliye saare items **equal** ho jaate hain chahe content kitna bhi ho. `flex: 1 1 auto` content ko base maanta hai, isliye bade content wala item bada rehta hai. Jab "sab columns equal chahiye the par nahi hue", wajah yahi hoti hai.

```css
/* Classic sidebar + content, ek line mein */
.layout { display: flex; gap: 24px; }
.sidebar { flex: 0 0 260px; }     /* fixed */
.main    { flex: 1; min-width: 0; } /* baaki sab -- min-width:0 overflow bug rokta hai */
```

> `min-width: 0` wala trick yaad rakho: flex item ka default `min-width: auto` hai, isliye lamba text ya `<pre>` block container se bahar nikal jaata hai. Ye frontend ka chhupa hua classic hai.

## 5. Grid: Teen Cheezein Kaafi Hain

```css
.shell {
  display: grid;
  grid-template-columns: 240px 1fr;   /* sidebar + rest */
  grid-template-rows: auto 1fr auto;  /* header, main, footer */
  min-height: 100vh;
  gap: 16px;
}
```

`1fr` = "available space ka ek hissa". Percentage se behtar hai kyunki `gap` ko apne aap account karta hai -- `width: 50%` + gap = overflow, `1fr` + gap = perfect.

### Ek pattern jo zaroor yaad rakho

Responsive card grid **bina ek bhi media query**:

```css
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 20px;
}
```

Padhne ka tareeka: "jitne columns fit ho jaayein banao, har column minimum 260px aur zyada jagah ho to barabar baant do." 1200px par 4 columns, 800px par 3, phone par 1. Aapne ek bhi breakpoint nahi likha.

`auto-fit` vs `auto-fill`: `auto-fit` khaali columns **collapse** kar deta hai (items phail jaate hain), `auto-fill` khaali tracks rakh leta hai (items apni min width par rehte hain). Zyadatar cases mein `auto-fit` chahiye hota hai.

### Named areas -- page shell readable ho jaata hai

```css
.shell {
  display: grid;
  grid-template-columns: 240px 1fr;
  grid-template-rows: auto 1fr auto;
  grid-template-areas:
    "header  header"
    "sidebar main"
    "footer  footer";
}
.shell > header { grid-area: header; }
.shell > aside  { grid-area: sidebar; }
.shell > main   { grid-area: main; }
.shell > footer { grid-area: footer; }
```

Ye CSS ek ASCII diagram hai -- 6 mahine baad bhi padhne par samajh aa jaayega. Aur mobile par poora layout badalna ek `grid-template-areas` rewrite hai, DOM touch kiye bina.

## 6. Do Classic Trap

### Trap 1: `margin: 0 auto` vertically centre kyun nahi karta

```css
.box { width: 400px; margin: 0 auto; }   /* horizontally centred [OK] */
.box { height: 200px; margin: auto 0; }  /* vertically centred [X] -- kuch nahi hua */
```

Wajah: normal document flow mein `auto` **horizontal** margin bachi hui width ko barabar baant deta hai. Par vertical direction mein block ki height content se decide hoti hai aur "bachi hui height" ka concept hi nahi hota -- browser `auto` vertical margin ko **0** treat karta hai.

Fix: flow se nikalo ya ek layout context do.

```css
/* Aaj ka jawab -- dono axis, ek line */
.parent { display: grid; place-items: center; min-height: 100vh; }

/* Flex item par auto margin ACTUALLY vertically kaam karta hai -- yahan free space exist karta hai */
.parent { display: flex; height: 300px; }
.child  { margin: auto; }
```

Interesting detail jo interview mein acha lagta hai: **flex/grid container ke andar `margin: auto` dono axis par kaam karta hai**, kyunki wahan free space defined hai. `margin-left: auto` ek flex item ko akela right mein dhakel dena ka sabse saaf tareeka hai (navbar ka "last item right").

### Trap 2: Collapsing margins

```html
<div class="a">A</div>   <!-- margin-bottom: 30px -->
<div class="b">B</div>   <!-- margin-top: 20px -->
```

Aapko lagta hai gap 50px hoga. Actually **30px** hota hai -- adjacent vertical margins **collapse** ho ke bade wala jeet jaata hai.

Aur isse zyada surprising version: parent-child.

```css
.parent { background: #eee; }       /* padding/border kuch nahi */
.child  { margin-top: 40px; }
/* Child ka margin parent ke BAHAR nikal jaata hai -- parent khud 40px neeche khisak jaata hai */
```

Kyun exist karta hai: CSS ka original use-case documents tha, jahan do paragraph ke beech "40px gap" chahiye hota tha, "40+40" nahi.

Collapsing kab **nahi** hoti -- yahi aapka fix list hai:

- Parent par `padding` ya `border` ho.
- Parent `display: flex` / `grid` ho (flex/grid items ke margins kabhi collapse nahi hote).
- `overflow: hidden/auto` ho (naya block formatting context).
- Element absolutely positioned ho.

Practical advice jo real codebases follow karte hain: **vertical spacing ke liye `margin-top` par mat jiyo -- Flex/Grid parent par `gap` use karo.** `gap` collapse nahi hota, predictable hai, aur last child ke baad extra space nahi chhodta.

## 7. Mobile-First Media Queries: `min-width` Kyun Jeeta Hai

```css
/* Mobile-first: base styles sabke liye, phir upar build karo */
.cards { display: grid; grid-template-columns: 1fr; gap: 16px; }

@media (min-width: 640px)  { .cards { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 1024px) { .cards { grid-template-columns: repeat(4, 1fr); } }
```

`max-width` wale (desktop-first) approach se teen problems hoti hain:

1. **Default sabse mehnga case ban jaata hai.** Phone ko desktop ke saare styles parse karke phir override karne padte hain. Mobile-first mein phone ko sirf base milta hai.
2. **Override ki ladai.** `max-width` queries ulte order mein overlap karti hain, to aap `!important` aur specificity hacks tak pahunch jaate ho ([[151-css-cascade-specificity-zindex]]).
3. **Soch ka direction.** Chhoti screen par aapko priority decide karni padti hai ("sabse zyada zaroori kya hai?"). Badi screen par aap sirf jagah bharte ho. Mobile-first product ko behtar banata hai, sirf CSS ko nahi.

Dono mix karne se overlap ke bugs aate hain -- ek project mein ek direction chuno aur usi par raho. Aur breakpoints "iPhone 14 ki width" se mat chuno; **wahan chuno jahan aapka layout dikhne mein toot raha ho**.

> Aaj ka upgrade: bahut saare cases mein media query ki zaroorat hi nahi -- `repeat(auto-fit, minmax())`, `clamp()` for font sizes, aur `aspect-ratio` sab intrinsically responsive hain. Container queries (`@container`) component-level par wahi kaam karti hain.

## 8. Common Galtiyan

- **Global `border-box` set na karna** -- phir poori life padding ke liye width minus karte raho.
- **`gap` ke bajaye `margin-right` + `:last-child` hack** -- `gap` Flex aur Grid dono mein chalta hai, isko default banao.
- **Flex item par `min-width: 0` bhoolna** -- lamba text/`pre`/`table` container tod dega.
- **`flex: 1` aur `flex: 1 1 auto` ko same maanna** -- basis 0 vs content, equal columns ka poora farak yahi hai.
- **Grid ko "advanced" samajh ke sab Flex se karna** -- nested flex wrappers ki 4 layers Grid ki 3 lines se zyada mehngi aur kam readable hain.
- **Vertical spacing `margin-top` se karna, aur breakpoints device names se chunna** -- pehla collapsing margins se silently tootta hai, doosra tab tootta hai jab naya phone aata hai.

## 9. Interview Mein Kaise Bolna Hai

*"Box model content, padding, border, margin hai, aur `content-box` mein width sirf content ki hoti hai -- isliye hum globally `border-box` set karte hain taaki `width: 300px` ka matlab asli 300px ho. Layout choose karne ka mera rule simple hai: ek axis ka kaam Flexbox, do axis ka Grid -- navbar aur toolbar Flex, page shell aur card grid Grid, aur dono nested use hote hain. Flex mein `justify-content` main axis par hai aur `align-items` cross axis par, aur main axis `flex-direction` se badalta hai -- isliye column karne par dono ka role swap lagta hai. `flex: 1` actually `1 1 0%` hai, isliye items equal ho jaate hain; `1 1 auto` content ko base maanta hai. Responsive card grid main `repeat(auto-fit, minmax(260px, 1fr))` se karta hoon, bina media query. Aur spacing ke liye `gap` use karta hoon, `margin-top` nahi, kyunki vertical margins collapse ho jaate hain."*

## 🧠 Remember

> Globally `border-box`, phir ek hi sawaal: **ek direction mein arrange karna hai ya do?** Ek ka jawab Flexbox, do ka Grid. `justify` flow ke saath chalta hai aur `align` uske across -- aur spacing `gap` se do, `margin` se nahi, kyunki vertical margins collapse hote hain.

## Quick Self-Test

1. `width: 300px; padding: 20px; border: 2px solid` wala box screen par kitna chaudha hoga -- `content-box` mein aur `border-box` mein?
2. Aapne `flex-direction: column` kiya aur `justify-content: center` ne horizontal centering band kar di. Kya hua, aur ab kya likhoge?
3. `flex: 1` aur `flex: 1 1 auto` mein farak kya hai, aur "sab columns equal chahiye" ke liye kaunsa?
4. `margin: 0 auto` horizontally centre karta hai par `margin: auto 0` vertically nahi -- kyun? Aur flex container ke andar jawab kaise badal jaata hai?
5. `repeat(auto-fit, minmax(260px, 1fr))` plain English mein kya kehta hai, aur `auto-fill` se kya badal jaayega?
6. Mobile-first `min-width` queries desktop-first `max-width` se kis teen tarah se behtar hain?
