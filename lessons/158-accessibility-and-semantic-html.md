# Accessibility Aur Semantic HTML: Sirf Checkbox Nahi

> **Connects to**: [[100-react-interview-7-points-hinglish]] (React interview ke core points -- accessibility unka chhupa hua 8th point hai) aur [[33-react-performance-at-scale]] (dono mein lesson same hai: browser pehle se bahut kuch deta hai, hum use overwrite kar dete hain). | [[151-css-cascade-specificity-zindex]] (focus styles and stacking)

## 1. Story: Ek Div Jo Button Banna Chahta Tha

Designer ne card diya, developer ne likha:

```tsx
<div className="btn" onClick={handleDelete}>Delete</div>
```

Browser mein ye perfect dikhta hai. Click karo, chalta hai. Ship ho gaya.

Teen hafte baad do bugs aate hain:

1. Ek power user keyboard se form bharta hai -- Tab dabata hai, **Delete par focus hi nahi jaata**. Wo button tak pahunch hi nahi sakta.
2. Ek screen-reader user support ko likhta hai: *"form par Delete naam ki koi cheez nahi hai."*

Developer ka fix: `tabIndex={0}` laga diya. Ab focus jaata hai. User Enter dabata hai -- **kuch nahi hota**. Space dabata hai -- page **scroll** ho jaata hai.

## 2. Yahi Poora Lesson Hai, Ek Example Mein

`<div onClick>` aapko **ek** cheez deta hai: mouse click.

`<button>` aapko **chaar** cheezein muft deta hai:

| Behaviour | `<div onClick>` | `<button onClick>` |
|---|---|---|
| Tab se focusable | Nahi | **Haan** |
| Enter / Space se activate | Nahi | **Haan** (dono) |
| Screen reader kehta hai "Delete, button" | Nahi (text padh dega, role nahi) | **Haan** |
| Form submit / `disabled` state / native focus ring | Nahi | **Haan** |

> **Semantic HTML = accessibility jo aapko likhni nahi padti.** Jab aap `<div>` use karte ho, aap ye chaaron behaviours **khud likhne ka contract** sign kar rahe ho -- aur aap teen bhool jaaoge.

Yahi backend analogy hai: `<div>` ek raw TCP socket hai, `<button>` ek HTTP framework. Dono se kaam ho jaata hai; ek mein aapko headers, retries aur status codes khud likhne padte hain.

## 3. Elements Jo Behaviour Carry Karte Hain

Ye yaad rakhne wali list hai. In elements ko choose karna hi 80% accessibility hai:

| Element | Jo free milta hai | Galat version |
|---|---|---|
| `<button>` | focus, Enter+Space, `role="button"`, `disabled` | `<div onClick>` |
| `<a href="...">` | focus, Enter, right-click "open in new tab", browser history | `<div onClick={navigate}>` |
| `<label htmlFor="email">` | label par click -> input focus; screen reader input ka naam bolta hai | `<span>Email</span>` upar rakh dena |
| `<form onSubmit>` | Enter se submit, native validation, `required` | sirf `<button onClick>` |
| `<input type="email">` | mobile par sahi keyboard, built-in validation | `type="text"` |
| `<nav> <main> <header> <footer> <aside>` | **landmarks** -- screen reader user seedha "main content" par jump kar sakta hai | `<div className="nav">` |
| `<h1>`-`<h6>` | document outline -- screen reader ka table of contents | `<div className="text-2xl font-bold">` |
| `<ul>/<li>`, `<table>` + `<th scope>` | "list, 5 items"; row/column relationships navigate hote hain | `<div>` ka dher, CSS grid se bana "table" |
| `<dialog>` / `<details>` | open/close semantics, Escape (dialog) | custom div + state |

Heading order ka ek concrete rule, kyunki ye sabse zyada toota milta hai: **ek page par ek `<h1>`, aur levels skip nahi** (`h2` ke baad `h4` nahi) -- screen reader user heading list se page scan karta hai, jaise aap dekh ke scan karte ho. `<h4>` sirf isliye choose karna ki chhota chahiye tha, classic bug hai: size CSS ka kaam hai, level **structure** ka.

## 4. Chaar Cheezein Jo Interviewer Actually Poochhta Hai

### 4.1 Keyboard Navigation Aur Focus Order

Rule: **jo mouse se ho sakta hai, keyboard se hona chahiye.** Test ek minute ka hai -- mouse chhodo, sirf Tab / Shift+Tab / Enter / Space / Escape / arrows se poora flow karo. Aur yaad rakho: focus order **DOM order** follow karta hai, visual order nahi -- isliye CSS se reorder karna (`order`, `row-reverse`, `position: absolute`) focus ko visual order se tod deta hai, aur user ko focus page mein koodta dikhta hai.

```tsx
// Positive tabIndex kabhi mat use karo
<input tabIndex={3} />    // X -- poore document ka tab order tod deta hai
<div tabIndex={0} />      // OK -- "natural order mein focusable bana do"
<div tabIndex={-1} />     // OK -- "sirf programmatically .focus() kar sakte hain"
```

### 4.2 Visible Focus Styles

```css
/* Ye ek BUG hai, feature nahi */
*:focus { outline: none; }
```

Focus ring hata diya aur replacement nahi diya -> keyboard user ko **pata hi nahi** wo kahan hai. Page usable nahi raha. Designer ko "ugly blue ring" se problem hai? Replace karo, remove mat karo:

```css
/* :focus-visible -- ring sirf keyboard/assistive navigation par, mouse click par nahi.
   Yahi designers ka actual objection solve karta hai. */
:focus-visible { outline: 2px solid #1a73e8; outline-offset: 2px; border-radius: 3px; }

/* High-contrast / forced-colors mode mein ring zinda rahe */
@media (forced-colors: active) { :focus-visible { outline: 2px solid CanvasText; } }
```

### 4.3 Accessible Name -- Label vs `aria-label` vs Placeholder

Har interactive element ka ek **accessible name** hona chahiye: wo string jo assistive tech bolti hai. Priority order (simplified):

`aria-labelledby` > `aria-label` > `<label for>` / wrapping label > element ka text content > `title` > `placeholder`

Teen rules:

1. **Placeholder label nahi hai.** Wo type karte hi gayab ho jaata hai, contrast usually fail karta hai, aur translate/autofill ke saath flaky hai. Visible `<label>` do.
2. **Visible text ho to `aria-label` mat lagao.** `<button aria-label="Submit form">Save</button>` -- voice-control user "Save" bolega aur match fail hoga, kyunki accessible name "Submit form" hai. Ye "bad ARIA" ka sabse common case hai.
3. **Icon-only button ko naam chahiye** -- yahan `aria-label` sahi jagah hai.

```tsx
// Sahi: visible label, programmatically tied
<label htmlFor="email">Email</label>
<input id="email" type="email" autoComplete="email"
       aria-describedby="email-err" aria-invalid={!!error} />
{error && <p id="email-err" role="alert">{error}</p>}

// Icon-only button: visible text nahi hai, to aria-label; icon khud ko hide karo
<button aria-label="Close dialog" onClick={close}><XIcon aria-hidden="true" /></button>

<input placeholder="Email" />   // X Galat: placeholder ko label maan liya
```

`role="alert"` wali line important hai: error dikhne par screen reader use **turant** padh dega (live region), warna blind user ko pata hi nahi chalega ki submit fail kyun hua.

### 4.4 Colour Contrast

Numbers yaad rakho, ye aksar poochhe jaate hain (WCAG 2.1 AA):

| Content | Minimum ratio |
|---|---|
| Normal text (< 18.66px / not bold) | **4.5 : 1** |
| Large text (>= 24px, ya >= 18.66px bold) | **3 : 1** |
| UI component borders, icons, focus indicator | **3 : 1** |

Aur: **colour alone information nahi carry kar sakta.** "Red field = error" colour-blind user ke liye kuch nahi kehta -- icon, text ya border-style bhi do. Chart mein bhi same baat: colour + pattern/label.

Yahi reason hai ki light-grey-on-white placeholder text (`#bbb` on `#fff` = ~1.9:1) hamesha audit fail karta hai.

## 5. ARIA -- Ek Rule Jo Baaki Sab Se Zyada Important Hai

> **No ARIA is better than bad ARIA.**

ARIA kuch bhi **karta nahi** -- wo sirf assistive tech ko bataati hai ki element kya **claim** kar raha hai. Behaviour aapko dena hai. Galat ARIA active jhooth hai, aur jhooth se better hai chup rehna.

Concrete traps:

```tsx
// Trap 1: role diya, behaviour nahi. Ye ab "button" HONE KA DAAWA kar raha hai
// par keyboard se activate nahi hota. Pehle se zyada confusing.
<div role="button" onClick={save}>Save</div>

// Agar div hi use karna hai (usually nahi karna chahiye), poora contract do:
<div
  role="button"
  tabIndex={0}
  onClick={save}
  onKeyDown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); save(); }
  }}
>Save</div>
// ...yaani <button> ko dubara likhna. Isliye: <button> use karo.

// Trap 2: aria-hidden ek focusable element par.
// Screen reader kehta hai "yahan kuch nahi hai" par Tab usme ghus jaata hai
// -> user ko ek INVISIBLE focus stop milta hai. Debug karna painful hai.
<button aria-hidden="true">Skip</button>        // X
<button hidden>Skip</button>                     // OK (focus bhi nahi jaayega)
<div aria-hidden="true"><SomeIcon /></div>       // OK (focusable kuch nahi hai)

// Trap 3: redundant role -- element pehle se wahi role rakhta hai
<button role="button">   <nav role="navigation">   // X dono bekaar
```

Teen ARIA attributes jo **genuinely** chahiye hote hain, kyunki HTML inka equivalent nahi deta:

- `aria-expanded` -- accordion/dropdown trigger par, open/closed state batane ke liye.
- `aria-current="page"` -- nav mein active link.
- `aria-live="polite"` / `role="status"` -- async update (toast, "3 results found", save confirmation) announce karne ke liye. SPA mein ye critical hai: route change par kuch announce hi nahi hota jab tak aap na karein.

## 6. Modal Checklist -- Sabse Zyada Toota Hua Widget

Modal har codebase mein hai aur lagbhag har jagah galat hai. Checklist:

- [ ] **Focus andar jaaye** jab modal khule (pehla focusable element, ya heading)
- [ ] **Focus trap**: Tab aur Shift+Tab modal ke andar hi cycle karein, background par na jaayein
- [ ] **Escape** se band ho
- [ ] **Focus wapas** us trigger par jaaye jisne modal khola tha (warna user page ke top par phenk diya jaata hai)
- [ ] `role="dialog"` + **`aria-modal="true"`** + `aria-labelledby` modal ke heading par
- [ ] Background content **inert** (`inert` attribute ya `aria-hidden` wrapper par) -- taaki screen reader peeche ka content na padhe
- [ ] Body scroll lock (ye UX hai, par isi checklist mein miss hota hai)

Sabse bada shortcut: **native `<dialog>` + `showModal()`** -- focus trap, Escape, `::backdrop` aur inert background browser se free milte hain.

```tsx
function ConfirmDialog({ open, onClose, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      opener.current = document.activeElement;   // kisne khola tha, yaad rakho
      el.showModal();                            // focus trap + Escape + inert, free
    } else if (el.open) {
      el.close();
      (opener.current as HTMLElement | null)?.focus();   // wapas lautao
    }
  }, [open]);

  return (
    <dialog ref={ref} aria-modal="true" aria-labelledby="cd-title" onClose={onClose}>
      <h2 id="cd-title">Delete order?</h2>
      {children}
      <button onClick={onClose}>Cancel</button>
    </dialog>
  );
}
```

Radix, React Aria ya Headless UI yahi sab handle karti hain. **Apna modal zero se likhna** sabse common avoidable a11y bug source hai.

## 7. 5 Minute Mein Kaise Test Karein

Koi automated tool poora a11y check nahi karta -- axe jaise tools **~30-40%** issues pakadte hain. Isliye teen manual steps zaroori hain:

1. **Mouse chhodo, Tab karo.** Poora flow keyboard se. Dekho: focus ring dikh raha hai? Order logical hai? Modal mein trap hai? Kuch invisible focus stop hai?
2. **Browser 200% zoom** karo (ya 320px width par dekho). Text clip ho raha hai? Horizontal scroll? Fixed-height containers mein content kat raha hai? Ye low-vision users ka primary tool hai.
3. **axe chalao.** `axe DevTools` browser extension, ya CI mein (`npm i -D @axe-core/playwright`):

```typescript
import AxeBuilder from '@axe-core/playwright';

test('checkout page: no critical a11y violations', async ({ page }) => {
  await page.goto('/checkout');
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(violations.filter(v => v.impact === 'critical')).toEqual([]);
});
```

Bonus (2 min): OS ka screen reader on karo -- Windows par **NVDA** (free) ya Narrator, Mac par **VoiceOver** (Cmd+F5) -- aur apna form bharne ki koshish karo. Ye experience kisi table se zyada sikhata hai.

## 8. Common Galtiyan

- **`<div onClick>`** (section 1) aur **`outline: none`** bina replacement -- sabse common do.
- **Placeholder ko label maanna**, ya **`aria-label` visible text par** laga ke naam badal dena (voice control tod deta hai).
- **`aria-hidden` focusable element par** -- invisible focus stop.
- **Heading level size ke liye choose karna**, structure ke liye nahi.
- **SPA route change par kuch announce na karna** -- screen reader user ko lagta hai page change hi nahi hua. Route change par heading par focus karo ya live region update karo.
- **Image par `alt` bhool jaana** -- decorative image par `alt=""` (empty, present) do, attribute hata na do.
- **"a11y QA ka kaam hai"** -- QA `<div>` ko `<button>` nahi bana sakta; ye element-choice hai, yaani developer ka kaam.
- **Compliance mindset**: checkbox tick karne ke liye 40 `aria-*` daal dena, aur widget pehle se zyada toot jaana.

## 9. Interview Mein Kaise Bolna Hai

*"Mera default semantic HTML hai, kyunki wo accessibility free deta hai: `<button>` focusable hai, Enter aur Space par activate hota hai, aur apna role announce karta hai -- `<div onClick>` teenon nahi deta. Phir chaar cheezein main specifically check karta hoon: keyboard se poora flow (focus order DOM order hai, CSS reorder use tod deta hai), `:focus-visible` ring -- `outline: none` bina replacement ek bug hai, har control ka accessible name (`<label htmlFor>`, icon-only par `aria-label`, placeholder label nahi hai), aur contrast 4.5:1 normal text par. ARIA minimum rakhta hoon kyunki no ARIA better than bad ARIA hai -- ARIA behaviour nahi deti, sirf claim karti hai, aur `aria-hidden` kisi focusable element par ek invisible focus stop bana deta hai. Modal ke liye native `<dialog>` ya ek tested library, kyunki focus trap, Escape, return-focus aur inert background khud likhna galat ho jaata hai. Test: Tab se poora flow, 200% zoom, aur axe -- axe sirf ~40% pakadta hai, isliye manual pass zaroori hai."*

## 🧠 Remember

> `<div onClick>` focusable nahi hai, Enter/Space par kuch nahi karta, aur apna role announce nahi karta -- `<button>` teenon free deta hai. **Semantic HTML wo accessibility hai jo aapko likhni nahi padti**, aur jahan ARIA lagao wahan yaad rakho: no ARIA is better than bad ARIA, kyunki ARIA claim karti hai, behaviour nahi deti.

## Quick Self-Test

1. `<div onClick>` par `tabIndex={0}` laga diya -- ab bhi kaunsi do cheezein missing hain?
2. `outline: none` ko bug kyun kehte hain, aur `:focus-visible` designer ka objection kaise solve karta hai?
3. `<button aria-label="Submit form">Save</button>` -- isme kya tootta hai aur kis user ke liye?
4. `aria-hidden="true"` ek focusable button par lagane se user ko exactly kya experience hota hai?
5. Modal ke chaar keyboard requirements batao, aur ek browser feature jo chaaron free deta hai.
6. Normal text aur UI borders ke liye contrast ratio kya hai, aur "sirf colour se error dikhana" kyun fail hai?
