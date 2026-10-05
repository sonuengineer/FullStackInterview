# React Component Testing: Behaviour, Implementation Nahi

> **Connects to**: [[100-react-interview-7-points-hinglish]] (state vs derived state, rendering model, fetching ke chaar states -- sab yahan test ho rahe hain) aur [[07-cors-error-fix]] (test mein network kaise fake hota hai, aur browser mein kyun nahi chalta). | [[158-accessibility-and-semantic-html]] (why getByRole works)

## 1. Ek Hi Philosophy, Ek Line Mein

React Testing Library (RTL) ki poori soch yahi hai:

> **Test wo karo jo user karta hai aur dekhta hai -- wo nahi jo component andar store karta hai.**

Iska seedha matlab:

```jsx
// GALAT -- implementation test kar rahe ho
expect(wrapper.state('isOpen')).toBe(true);
expect(wrapper.find('Dropdown').prop('items')).toHaveLength(3);
const instance = wrapper.instance(); instance.handleSubmit();

// SAHI -- user ka experience test kar rahe ho
await userEvent.click(screen.getByRole('button', { name: /filters/i }));
expect(screen.getByRole('listbox')).toBeVisible();
expect(screen.getAllByRole('option')).toHaveLength(3);
```

Dono "same cheez" test kar rahe lagte hain. Farak refactor ke din dikhta hai.

Maan lo aap `useState` hata kar `useReducer` laaye, ya ek `isOpen` ko `status: 'open' | 'closed'` kar diya. UI bilkul same hai, user ko kuch farak nahi. Pehla test **fail** hota hai -- jabki kuch nahi toota. Doosra test pass rehta hai -- kyunki behaviour nahi badla.

Ab ulta case: aapne galti se dropdown ko `display: none` ya `aria-hidden` kar diya. State ab bhi `isOpen: true` hai -- pehla test **pass** hota hai jabki feature toot gayi. Doosra fail hota hai.

Yaani implementation test **ulta** chalta hai: refactor par shor machata hai, asli bug par chup rehta hai. Isi liye shallow rendering (`enzyme` ka `shallow`) RTL mein jaan-boojh kar nahi hai -- shallow mein child render hi nahi hota, to user jo dekhta hai wo test mein maujood hi nahi.

## 2. Query Priority -- Philosophy Code Mein

RTL ki query order random nahi hai, wo "user kaise dhoondta hai" ka order hai:

| Priority | Query | Kab |
|---|---|---|
| 1 | `getByRole('button', { name: /save/i })` | Default. Button, link, heading, textbox, checkbox, dialog, table |
| 2 | `getByLabelText('Email')` | Form fields -- user label padh kar hi field bharta hai |
| 3 | `getByPlaceholderText` | Label na ho tab (par label hona chahiye) |
| 4 | `getByText(/order placed/i)` | Non-interactive text, messages |
| 5 | `getByDisplayValue` | Filled-in form ka current value |
| 6 | `getByTestId('order-row')` | **Escape hatch** -- jab kuch aur na bache |

Aur ek bahut achha side effect, jo interview mein bolne layak hai:

> Agar aap `getByRole` se element nahi dhoond paa rahe, to aksar aapke markup mein **accessibility problem** hai.

Example -- ye bahut common hai:

```jsx
<div className="btn" onClick={save}>Save</div>
```

`getByRole('button', { name: 'Save' })` fail hoga. Kyun? Kyunki ye button nahi hai: keyboard se focus nahi hota, Enter/Space se chalta nahi, screen reader ise button nahi bolta. Test aapko bug bata raha hai, test "difficult" nahi hai. Fix `<button onClick={save}>Save</button>` hai, `data-testid` nahi.

Isi tarah `getByLabelText('Email')` fail hone ka matlab aksar ye hai ki input ka label `htmlFor`/`id` se juda nahi hai -- yaani label par click karne se field focus nahi hota.

`getByTestId` kab theek hai: ek list ka row container pakadna, ek chart/canvas, ek third-party widget ka wrapper -- jahan koi semantic role hi nahi hai.

## 3. Sirf Teen Cheezein Test Karni Hain

Componen test ko overthink karne ki zarurat nahi. Teen category hain.

**A) Diye gaye props par sahi cheez render hoti hai**

```jsx
it('out of stock par price aur disabled button dikhta hai', () => {
  render(<ProductCard product={{ name: 'Keyboard', pricePaise: 249900, inStock: false }} />);

  expect(screen.getByRole('heading', { name: 'Keyboard' })).toBeInTheDocument();
  expect(screen.getByText('Rs 2,499')).toBeInTheDocument();          // formatting bug yahin pakda jaata hai
  expect(screen.getByRole('button', { name: /add to cart/i })).toBeDisabled();
});
```

Edge case ko priority do, happy path ko nahi: `inStock: false`, empty list, `null` user, bahut lamba naam, zero items. Happy path to aap browser mein roz dekh rahe ho; empty state wo hai jo 3 mahine baad toot kar prod mein jaata hai.

**B) User interaction se expected visible change hota hai**

```jsx
it('quantity badhane par total update hota hai', async () => {
  const user = userEvent.setup();
  render(<CartRow item={{ name: 'Keyboard', pricePaise: 100000, qty: 1 }} />);

  await user.click(screen.getByRole('button', { name: /increase quantity/i }));

  expect(screen.getByTestId('row-total')).toHaveTextContent('Rs 2,000');
  expect(screen.getByRole('spinbutton', { name: /quantity/i })).toHaveValue(2);
});
```

**`userEvent` use karo, `fireEvent` nahi.** Wajah: `fireEvent.click(el)` sirf ek `click` event dispatch karta hai. Asli user click karta hai to browser pehle `pointerdown`, `mousedown`, `focus`, `pointerup`, `mouseup`, phir `click` deta hai -- aur disabled element par kuch nahi deta.

Isliye `fireEvent` se aise bugs pass ho jaate hain:

- `onFocus`/`onBlur` wali validation chalti hi nahi (jaise "blur par error dikhao").
- `disabled` button par `fireEvent.click` handler chala deta hai -- user se ye possible hi nahi.
- `fireEvent.change(input, { target: { value: 'abc' }})` poori value ek saath set karta hai; asli typing se har keystroke par `onChange` chalta hai. Debounce, max-length, aur "pehle char par suggestion" wala code untested reh jaata hai.

`userEvent.type()` sach mein char-by-char type karta hai. Yahi wajah hai ki `userEvent` async hai -- `await` lagana zaroori hai, aur `userEvent.setup()` test ke start mein.

**C) Async states dikhte hain (loading -> success/error/empty)**

[[100-react-interview-7-points-hinglish]] mein fetch ke chaar states aaye the: **loading, error, empty, success**. Test mein chaaron likho:

```jsx
it('loading dikhata hai, phir orders', async () => {
  render(<OrdersPage />);

  expect(screen.getByRole('status')).toHaveTextContent(/loading/i);

  expect(await screen.findByRole('table')).toBeInTheDocument();   // findBy = query + wait
  expect(screen.getAllByRole('row')).toHaveLength(4);             // 1 header + 3 data
  expect(screen.queryByRole('status')).not.toBeInTheDocument();   // spinner chala gaya
});
```

Teen query family ka farak yaad rakho -- 90% RTL confusion yahi hai:

| Family | Milta nahi to | Async? | Kab |
|---|---|---|---|
| `getBy*` | throw | Nahi | Abhi maujood hona chahiye |
| `queryBy*` | `null` | Nahi | **Absence** check karne ke liye (`not.toBeInTheDocument`) |
| `findBy*` | throw (timeout ke baad) | Haan | Jo baad mein aayega |

Aur: **`setTimeout`/`sleep` kabhi nahi.**

```jsx
await new Promise(r => setTimeout(r, 1000));          // mat likho
expect(screen.getByText('Done')).toBeInTheDocument();
```

Ye do tarah se galat hai -- slow machine (CI) par 1000 ms kam pad jaayega (flaky fail), aur fast machine par aap 1000 ms har run mein bekar jalaa rahe ho. `findBy*` ya `waitFor` poll karte hain: jaise mil gaya, aage badh gaye.

```jsx
await waitFor(() => expect(mockOnSave).toHaveBeenCalledTimes(1));   // non-DOM assertion ke liye
```

`waitFor` sirf tab jab assertion DOM query na ho. DOM ke liye `findBy*` zyada saaf hai.

## 4. Network: Boundary Par Mock Karo (MSW)

Teen options hain, aur farak bada hai.

```jsx
// Option 1: hook mock -- sabse kharab
vi.mock('./useOrders', () => ({ useOrders: () => ({ data: fakeOrders, isLoading: false }) }));
```

Ab aapka test component ke saath-saath **mock ko bhi** test kar raha hai. Asli `useOrders` -- jisme URL banta hai, query params lagte hain, error 401 handle hoti hai, retry hoti hai -- bilkul untested. Aur `useOrders` ka shape badlo to component theek rahega par test jhooth bolega.

```jsx
// Option 2: global fetch stub -- thoda behtar, phir bhi bhangur
global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => fakeOrders });
```

Ye URL, method, headers, query string -- kuch verify nahi karta. Aapka code `/api/order` (typo) hit kare ya `/api/orders`, test same green. Aur axios/ky par ye kaam hi nahi karta.

```jsx
// Option 3: MSW -- HTTP boundary par
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const server = setupServer(
  http.get('/api/orders', ({ request }) => {
    const url = new URL(request.url);
    if (url.searchParams.get('status') === 'paid') return HttpResponse.json({ data: paidOrders });
    return HttpResponse.json({ data: allOrders });
  })
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

Ye exactly wahi rule hai jo backend side par tha ([[164-integration-tests-with-real-database]] wala): **jo aapka hai use asli chalao, jo doosre ka hai use boundary par mock karo.** Aapka data-fetching code, hooks, cache, error mapping -- sab aapka hai, wo asli chalna chahiye. Dusri team ka HTTP server aapka nahi, wo fake.

MSW ke do extra practical faide:

- `onUnhandledRequest: 'error'` -- aapke component ne koi unexpected API call ki to test fail. Accidental extra request (double fetch, infinite effect loop) yahin pakda jaata hai, jo [[100-react-interview-7-points-hinglish]] ka `useEffect` dependency bug hai.
- Error path test karna trivial ho jaata hai:

```jsx
it('server 500 par error state dikhata hai, crash nahi', async () => {
  server.use(http.get('/api/orders', () => new HttpResponse(null, { status: 500 })));
  render(<OrdersPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/kuch galat hua|try again/i);
});
```

Ek dhyan: MSW node mein request intercept karta hai, isliye **CORS yahan exist hi nahi karta**. Test green hone ka matlab nahi ki browser mein CORS theek hai -- wo [[07-cors-error-fix]] wala alag problem hai aur usko ek chhota e2e ya staging hit hi pakadta hai.

## 5. `act` Warning Ka Asli Matlab

```
Warning: An update to OrdersPage inside a test was not wrapped in act(...)
```

Log ise shaant karne ke liye random `act()` lapet dete hain. Warning actually ye keh rahi hai:

> **Test khatam samajh kar aage badh gaya, par component ne uske baad state update kiya.**

Yaani ek pending async kaam tha jiska aapne wait nahi kiya -- fetch resolve hua, `setState` chala, par us waqt tak test ka assertion nikal chuka tha. Ye flakiness ka direct source hai: kabhi update assertion se pehle aayega, kabhi baad mein.

Teen common wajah aur unka fix:

| Wajah | Fix |
|---|---|
| Fetch ke baad render hota hai, aapne `getBy*` use kiya | `await screen.findBy*` |
| `userEvent` ko `await` nahi kiya | `await user.click(...)` |
| Component test ke baad bhi kaam kar raha hai (timer, subscription) | Timer/subscription ka cleanup effect mein `return () => ...`; `vi.useFakeTimers()` + `advanceTimersByTime` |

Yaani `act` warning ko **suppress karne ki cheez nahi, padhne ki cheez** samjho -- wo aksar ek missing cleanup (memory leak, stale response) ki taraf ishaara karti hai, bilkul us `AbortController` wale case jaisa.

## 6. React Mein Kya Test **Nahi** Karna

Bahut saara effort yahan barbaad hota hai:

- **`useMemo`/`useCallback` ka hona.** Ye implementation detail hai aur performance ka maslaa hai. Iska test "profiler" hai, assertion nahi. Aur yaad rakho `React.memo` tabhi kaam karta hai jab props reference-stable hon -- wo baat test nahi, measurement se pata chalti hai.
- **CSS aur layout.** `expect(el).toHaveStyle({ marginTop: '8px' })` ek constant ko dusri jagah likhna hai. jsdom mein real layout nahi hota -- width, overflow, z-index, responsive -- kuch compute hi nahi hota. Visual regression tool (Chromatic/Percy) ya aapki aankh iska sahi tool hai.
- **Library ka behaviour.** React Router navigate karta hai, React Query cache karta hai, Zod validate karta hai -- unke maintainers ne test likhe hain. Aap apna **usage** test karo: "Save par user `/orders` par pahuncha", not "router ne push kiya".
- **Hook ko microscope ke neeche.** Ek chhota `useDebounce` ya `useLocalStorage` ka apna test theek hai. Par ek bade data-fetching hook ka alag test aksar component test ka duplicate hota hai -- component ke through test karo.

Aur jahan component test sach mein kaafi nahi hai, wahan **e2e** (Playwright/Cypress) ki jagah banti hai:

| Cheez | Component test (jsdom) | E2E (asli browser) |
|---|---|---|
| Ek screen ka behaviour | Haan, 50 ms | Overkill |
| Poora login -> checkout -> payment flow | Nahi | Haan, 3-5 critical flow |
| Asli CORS, cookies, `Secure`/`SameSite` | Nahi | Haan |
| File upload, download, clipboard | Flaky/limited | Haan |
| Layout, visual regression | Nahi | Haan |

Mota rule: **component test bahut saare, e2e sirf 3-5** -- wo flows jinke tootne par paisa rukta hai. E2E slow aur flaky hote hain; unki ginti control mein rakhni padti hai.

## 7. Worth The Time Ya Nahi

Component test ka ROI unequal hai, to priority yahi rakho:

1. **Form + validation** -- yahan sabse zyada branch hain aur manually test karna sabse boring hai.
2. **Paisa/irreversible action wale component** -- checkout, delete confirmation, quantity.
3. **Async states** -- loading/error/empty, kyunki developer sirf happy path dekh kar merge karta hai.
4. **Wo component jisme bug aa chuka hai** -- bug fix ke saath ek test; yahi sabse honest coverage hai.

Skip: ek line wrapper component, pure presentational `<Badge>`, aur jo page aap roz manually chalate ho aur jiska logic na ho.

## 🧠 Remember

> RTL ka ek hi niyam hai: **user jo karta aur dekhta hai wo test karo, component jo store karta hai wo nahi.** Isliye `getByRole` pehle (aur jab wo kaam na kare, galti aksar aapke markup ki accessibility mein hai), `userEvent` not `fireEvent`, `findBy*` not `setTimeout`, aur network MSW se HTTP boundary par fake karo -- hook ya `fetch` ko mock karke nahi. `act` warning fix karne ki cheez hai, chhupane ki nahi.

## Quick Self-Test

1. Aapne `useState` ko `useReducer` se replace kiya, UI same hai. Kaunsa test fail hoga aur kyun wo test hi galat tha?
2. `fireEvent.click` se pass hone wale do bug batao jo `userEvent.click` pakad leta.
3. `getByRole('button', { name: 'Save' })` fail ho raha hai. Pehla shaq kis par, aur `data-testid` lagana kyun galat jawab hai?
4. `getBy*`, `queryBy*`, `findBy*` -- absence check karne ke liye kaunsa, aur kyun baaki do nahi?
5. Hook mock karne se MSW tak -- exactly kaunsa code untested reh jaata hai jab aap `useOrders` ko mock karte ho?
6. `act` warning aa rahi hai. Wo aapko component ke baare mein kya bata rahi hai, aur `act()` lapet dena fix hai ya nahi?
