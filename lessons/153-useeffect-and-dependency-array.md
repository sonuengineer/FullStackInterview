# useEffect Aur Dependency Array: Stale Closure Ka Jaal

> **Connects to**: [[100-react-interview-7-points-hinglish]] (point 3 ka deep dive), [[138-closures-and-scope-real-bugs]] (yahi closure, ab React ke andar), [[137-event-loop-phases-and-microtasks]] (callback baad mein chalta hai) aur [[152-react-reconciliation-and-keys]] (render vs commit). | [[159-browser-event-loop-vs-node]] (frame budget and long tasks)

## 1. Pehla Sawaal, Jo Zyadatar Log Galat Dete Hain

Interview mein `useEffect` ka sawaal syntax ka nahi hota. Wo **intent** ka hota hai.

> `useEffect` ka kaam hai: React ke **bahar** ki kisi cheez ke saath sync rehna.

Bahar ki cheez = WebSocket, `setInterval`, browser API (`document.title`, `localStorage`, `IntersectionObserver`), ek non-React chart library, ya ek network request.

Agar aapka kaam in dono mein se kuch hai, to effect **galat jagah** hai:

| Aapka kaam | Sahi jagah |
|---|---|
| Kisi value se doosri value nikalna (total, filtered list, formatted date) | Seedha render mein calculate karo. Mehenga ho to `useMemo`. |
| User ne click/submit kiya, uske response mein kuch karna | **Event handler** |
| Prop badalne par poora internal state reset karna | `key` change ([[152-react-reconciliation-and-keys]]) |
| External system se subscribe/connect/observe karna | `useEffect` + cleanup |

### Galat #1 -- derived state ko effect se set karna

```tsx
const [items, setItems] = useState<Item[]>([]);
const [total, setTotal] = useState(0);

useEffect(() => {
  setTotal(items.reduce((s, i) => s + i.price, 0));   // GALAT
}, [items]);
```

Kya galat hai: React pehle purane `total` ke saath render + **commit** karta hai (user ek frame ke liye stale number dekhta hai), phir effect chalta hai, phir dobara render hota hai. Do render, ek stale frame, aur `total` ek duplicate source of truth ban gaya -- lesson 100 ka point 1.

```tsx
const total = items.reduce((s, i) => s + i.price, 0);   // bas.
```

### Galat #2 -- event ko state banakar effect se trigger karna

```tsx
const [submitted, setSubmitted] = useState(false);
useEffect(() => {
  if (submitted) postOrder(form);     // GALAT
}, [submitted]);
```

Problems: flag ko reset karna padega warna dobara submit nahi hoga; StrictMode mein ye do baar fire hoga; aur backend terms mein aapne ek **command** ko ek state-driven reconciliation loop bana diya -- jisme aap duplicate order ke liye khud invite bhej rahe ho ([[32-payment-idempotency-double-click]]).

```tsx
async function onSubmit() { await postOrder(form); }   // event ka kaam event handler mein
```

**Interview line:** *"Effect ek event ka response nahi hota. Effect ek state ka result hota hai -- 'jab tak app ki state X hai, bahar ki duniya ko X ke saath sync rakho'."*

## 2. Dependency Array: Teen Forms Ka Asli Matlab

```tsx
useEffect(fn);            // (a) har commit ke baad
useEffect(fn, []);        // (b) mount par ek baar, cleanup unmount par
useEffect(fn, [a, b]);    // (c) mount + jab a ya b Object.is se badlein
```

Ye framing yaad rakho, kyunki yahi bug se bachata hai:

> Dependency array ek **list nahi, ek claim hai**. Aap React se keh rahe ho: "mera effect sirf in values par depend karta hai." Agar claim jhooti hai, React aapko stale value dega -- aur wo chup-chaap dega.

`[]` ka matlab "ek baar chalao" nahi hai. Uska matlab hai **"mera effect kisi bhi reactive value ko nahi padhta"**. Zyadatar `[]` bugs isi jhooth se aate hain.

## 3. Stale Closure: Counter Jo Hamesha 0 Dikhata Hai

```tsx
function Timer() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      console.log('count is', count);   // hamesha "count is 0"
      setCount(count + 1);              // hamesha 0 + 1 = 1
    }, 1000);
    return () => clearInterval(id);
  }, []);                                // jhoothi claim: count padh rahe ho

  return <p>{count}</p>;
}
```

UI `0` se `1` jaata hai aur wahin ruk jaata hai. Console hamesha `0` print karta hai.

**Hua kya:** [[138-closures-and-scope-real-bugs]] ka exact rule, naye kapdon mein. React ka har render ek **alag function call** hai, aur us call ke andar `count` ek `const` hai -- ek shared mutable box nahi. Pehle render mein `count === 0` tha. `[]` ki wajah se effect sirf us pehle render mein chala, aur interval callback ne **us render ke scope ka backpack** pakad liya. Baad ke renders naye `count` banate rahe, par wo interval callback ko kabhi dikhe hi nahi.

Timing bhi wahi hai: callback timers phase mein chalta hai, sync render ke baad ([[137-event-loop-phases-and-microtasks]]).

### Teen fix -- aur teeno ka matlab alag hai

**(a) Dep add karo -- "mujhe har nayi value par re-sync karna hai"**

```tsx
useEffect(() => {
  const id = setInterval(() => setCount(count + 1), 1000);
  return () => clearInterval(id);
}, [count]);     // sahi, par har second interval destroy + recreate -> drift
```

Correct hai, imaandari se ye bhi bolo ki cost hai: har tick par ek naya timer, to exact 1000ms spacing nahi milti.

**(b) Functional updater -- "mujhe value padhni hi nahi hai"**

```tsx
useEffect(() => {
  const id = setInterval(() => setCount((c) => c + 1), 1000);   // c = latest, React deta hai
  return () => clearInterval(id);
}, []);          // ab [] ki claim sach hai
```

Ye is case ka **best** jawab hai: ek hi timer, aur `[]` jhooth nahi bol raha, kyunki effect `count` ko padh hi nahi raha.

**(c) Ref -- "latest value padhni hai, par uspar re-sync nahi karna"**

```tsx
const countRef = useRef(count);
useEffect(() => { countRef.current = count; });   // har commit ke baad latest

useEffect(() => {
  const id = setInterval(() => analytics.track('tick', { count: countRef.current }), 5000);
  return () => clearInterval(id);
}, []);
```

Ref ek mutable box hai jo renders ke beech zinda rehta hai, aur usko badalna re-render trigger nahi karta. Jab aapko "latest cheez chahiye par uske badalne par effect dobara setup nahi karna" -- yahi pattern hai. React ki `useEffectEvent` family isi pattern ko official banane ki koshish hai; tab tak ye ref wala version standard hai.

Decision rule:

| Chahiye | Fix |
|---|---|
| Value badle to effect dobara chale | dep array mein daalo |
| Sirf next value likhni hai | functional updater |
| Latest value padhni hai, re-sync nahi | ref |

## 4. Cleanup: Sabse Zyada Skip Kiya Jaane Wala Hissa

Effect se return kiya gaya function **cleanup** hai. Wo do waqt chalta hai:

1. Agle effect run se **pehle** (jab deps badle), aur
2. Component **unmount** par.

Order important hai: purana connection pehle band hota hai, phir naya khulta hai.

```tsx
useEffect(() => {
  const socket = connectToRoom(roomId);
  socket.on('message', onMessage);
  return () => socket.close();     // roomId badla -> purana room pehle band
}, [roomId]);
```

Cleanup bhool gaye to kya hota hai? User 10 rooms switch karta hai -> 10 sockets khule, dus listeners attached, har message ab **kai baar** UI mein aata hai, aur unmounted component ke closures memory mein zinda rehte hain. Ye frontend ka wahi leak hai jo server par EventEmitter ke saath hota hai ([[146-eventemitter-and-listener-leaks]], [[22-nodejs-memory-leak-debugging]]).

Cleanup ki zarurat hai: subscriptions, `addEventListener`, timers/intervals, `IntersectionObserver`/`ResizeObserver`, non-React widget instances (`chart.destroy()`), aur in-flight requests (`AbortController` -- poora pattern lesson 155 mein).

## 5. StrictMode Do Baar Kyun Chalata Hai (Aur Ye Feature Hai)

React 18+ mein development mein `<StrictMode>` har component ko mount -> unmount -> remount karta hai. Matlab aapka effect dikhta hai: **setup, cleanup, setup**.

Log sabse pehle yahi poochhte hain: "mera API do baar call ho raha hai, StrictMode hata doon?"

Nahi. Ye ek **test** hai, bug nahi:

> Jo effect do baar chalne se toot jaata hai, wo effect production mein bhi tootega -- kyunki React kabhi bhi deps badalne par use dobara chala sakta hai.

Do baar chalna aapko batata hai ki cleanup missing hai ya galat hai. Sahi fix: cleanup likho (socket close, interval clear, request abort/ignore). Production build mein ye double-invoke hota hi nahi.

Aur ha, StrictMode aapke component function ko bhi do baar call karta hai -- isliye render ke andar side effect (counter badhana, array push karna, `localStorage` likhna) turant pakda jaata hai. Render pure hona chahiye; yahi [[152-react-reconciliation-and-keys]] ka "render sirf ek function call hai" wala rule enforce ho raha hai.

## 6. Infinite Loop Ka Classic: Object Deps

```tsx
useEffect(() => { load(options); }, [options]);   // options parent mein inline bana hai
```

Agar parent `options={{ status: 'open' }}` inline pass kar raha hai, to har render par **naya object reference** -> `Object.is` fail -> effect har render par chala -> usne state set kiya -> phir render -> infinite loop.

Teen fix, preference ke order mein:

```tsx
useEffect(() => { load({ status, page }); }, [status, page]);   // (a) primitives par depend karo
const options = useMemo(() => ({ status, page }), [status, page]);   // (b) reference stable karo
// (c) object effect ke andar hi banao
```

Same baat functions ke saath: `useCallback` ke bina banaya gaya callback dep array mein daalna same loop deta hai.

Aur lint rule (`react-hooks/exhaustive-deps`) ko disable comment se chup karana **worst** option hai -- wo warning aapka jhooth pakad rahi hai. Ya dep add karo, ya code ko aisa banao ki dep ki zarurat hi na pade (updater/ref).

## 7. useEffect vs useLayoutEffect

`useEffect` commit ke **baad**, browser paint ke **baad** chalta hai -- async, paint block nahi karta. 95% cases ka default yahi hai.

`useLayoutEffect` commit ke baad par paint se **pehle** synchronously chalta hai. Isliye wahan jo DOM change karoge wo user ko kabhi flicker mein nahi dikhega. Use sirf tab jab aapko DOM **measure** karke usi frame mein adjust karna hai -- tooltip ko viewport ke andar position karna, scroll position restore karna, text width naap kar truncate karna. Cost: ye paint ko block karta hai, isliye yahan heavy kaam ya fetch nahi. Aur SSR par ye chalta hi nahi (server par DOM nahi hai), isliye React warning deta hai.

## 8. Common Galtiyan

- Derived value ko effect + state se banana (do render + stale frame).
- Event ka kaam effect mein daalna, ek boolean flag ke through.
- `[]` ko "ek baar chalao" samajhna, jabki wo "mujhe koi reactive value nahi chahiye" ka claim hai.
- Cleanup chhodna -- sabse common production leak.
- `exhaustive-deps` warning ko disable karna.
- Dep array mein inline object/function daalna -> infinite loop.
- StrictMode ko "bug" samajh kar hata dena.

## 🧠 Remember

> Effect ek event ka jawab nahi, ek state ka **sync** hai -- aur dependency array ek list nahi, ek **claim** hai: "mera effect sirf in values ko padhta hai"; wo claim jhoothi hui to React aapko pehle render ka backpack chup-chaap pakda deta hai.

## Quick Self-Test

1. `useEffect(fn, [])` ka precise matlab kya hai -- "ek baar chalo" se better wording mein?
2. Interval wale counter mein `setCount(count + 1)` hamesha `1` kyun deta hai, aur `setCount(c => c + 1)` kyun `[]` ko sach bana deta hai?
3. "Latest value padhni hai par uspar re-sync nahi karna" -- kaunsa tool, aur wo re-render kyun nahi karta?
4. Cleanup exactly kab-kab chalta hai, aur `roomId` badalne par order kya hota hai?
5. StrictMode ka double-invoke ek feature kaise hai? Ek aisa bug batao jo wo pakadta hai.
6. `useLayoutEffect` kis ek case mein zaroori hai, aur uski cost kya hai?
