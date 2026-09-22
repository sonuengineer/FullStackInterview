# React Interview 2026: Ye 7 Points Hi Poochhe Jaate Hain (Hinglish)

> **Connects to**: [[33-react-performance-at-scale]] (rendering performance) aur [[51-fast-api-slow-page]] (page load).

## 1. State vs Derived State

**Rule:** ek hi source of truth rakho. Jo cheez already state se nikal sakti hai, use **state mat banao**.

```javascript
// GALAT - fullName ab sync mein rakhna padega, bug guarantee
const [first, setFirst] = useState(''), [last, setLast] = useState('');
const [fullName, setFullName] = useState('');

// SAHI - derived value render ke time compute karo
const fullName = first + ' ' + last;
// mehenga calculation ho tabhi useMemo
const sorted = useMemo(() => bigList.sort(cmp), [bigList]);
```

Interview line: *"Derived state duplicate truth banata hai, jo stale ho jaata hai."*

## 2. Rendering Model (rerender kyun hota hai)

- Component rerender hota hai jab: uska **state** badle, **props** badlein, ya **parent** rerender ho.
- `key` reconciliation decide karta hai. Array index ko key banana list reorder par galat item update karta hai. **Stable id** use karo.
- Key badalne par React purana component **unmount** karke naya mount karta hai - state chala jaata hai (accidental remount).

## 3. Effects: `useEffect` vs Event Handler

**Pehla sawaal:** ye kaam kisi *event* se hota hai ya *render ke baad sync* karne ke liye hai?

- Button click par API call -> **event handler**, useEffect nahi.
- External system se sync (subscription, timer, non-React widget) -> **useEffect**, cleanup ke saath.
- Dependency array galat ho to fetch loop ban jaata hai (har render par fetch -> state set -> render...). Cleanup mein **abort** karo:

```javascript
useEffect(() => {
  const ac = new AbortController();
  fetch('/api/user/' + id, { signal: ac.signal }).then(r => r.json()).then(setUser).catch(() => {});
  return () => ac.abort();          // stale response UI par nahi aayega
}, [id]);
```

## 4. Performance: memo/useMemo/useCallback "default" nahi hain

Pehle **measure** karo (React DevTools Profiler), phir fix karo. Warna aap har jagah memo lagake code ko slow + unreadable bana dete ho.

- `React.memo` tabhi kaam karega jab props ki **reference equality** bane - inline object/function props usko tod dete hain.
- Badi list = **virtualization** (react-window), memo se zyada faida ([[33-react-performance-at-scale]]).

## 5. Data Fetching + Caching

Har fetch ke 4 states hote hain: **loading, error, empty, success** - interview mein chaaron bolo.

React Query / SWR kya *actually* dete hain: cache + dedupe (same key ke do request ek ho jaate hain), background refetch, stale-while-revalidate, retry, aur request cancellation. Ye khud likhoge to yahi sab dobara likhna padega.

## 6. Forms: Controlled vs Uncontrolled

- **Controlled** (`value` + `onChange`): React ke paas truth, validation easy, lekin bade form mein har keystroke par rerender.
- **Uncontrolled** (`ref` / react-hook-form): DOM ke paas truth, tez, isliye 50+ fields wale forms mein behtar.
- Validation: schema (Zod/Yup) se, aur **server par dobara** - client validation sirf UX hai ([[66-blog-before-first-backend-job]]).

## 7. TypeScript + Component API

Invalid state ko **type level par impossible** banao:

```typescript
// discriminated union - "loading ke saath data" jaisa invalid combo ban hi nahi sakta
type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; data: User[] };
```

Props mein optional flags ki bheed (`isPrimary`, `isDanger`, `isGhost`) ki jagah `variant: 'primary' | 'danger' | 'ghost'` rakho.

## 🧠 Remember

> Ek source of truth (derived state nahi), rerender ka kaaran samjho (state/props/parent + keys), effects sirf sync ke liye, memo measure karke, fetching ke chaar states, bade forms uncontrolled, aur types se invalid state impossible.

## Quick Self-Test

1. Array index ko `key` banane se list reorder par kya galat hota hai?
2. Button click ki API call `useEffect` mein kyun nahi honi chahiye?
3. `React.memo` lagane ke baad bhi component rerender ho raha hai - sabse common wajah?
