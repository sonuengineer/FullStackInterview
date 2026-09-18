# Search System -- HLD + LLD (Part 6: Implement It -> Interview Answers -> Whiteboard -> Cheat Sheet)

> Is file mein prompt ke **Parts 26-30** hain: coding round mein "Implement a search engine" kaise solve karein, 30-second answer, 5-minute answer, whiteboard par diagram kis order mein banana hai, aur poore Search System (Parts 1-5) ki final cheat sheet.
> Part 5 ka 3-line recap: humne dekha ki **scaling ladder** kya hai (Postgres FTS -> single ES node -> 6 primary shards x 1 replica -> alias-swap reindex -> read replicas aur suggestions ka alag index), **failure par degrade karna hai, die nahi** (Redis stale cache -> Postgres `pg_trgm` top 20 with `degraded: true` -> phir 503), aur **consistency** mein ES ek derived index hai jise Postgres se outbox + Kafka feed karta hai, `version_type: external` se out-of-order messages safe hote hain.
> **Ye last file hai -- yahi revision file hai.** Interview se ek raat pehle sirf PART 30 padh lena kaafi hai. Parts 1-5 mein humne design **samjha**; yahan usko **bolna, likhna aur draw karna** seekhenge.

---

## PART 26 -- Code Design Question: "Implement a search engine"

### Pehle samjho: ye do bilkul alag sawaal hain

Jab interviewer bolta hai "implement a search engine", uska matlab do mein se ek hota hai:

| Kaun sa round | Interviewer kya sun-na chahta hai | Tumhara jawab |
|---|---|---|
| **Coding / LLD round** (zyadatar yahi) | Inverted index tumne khud banaya hai ya sirf naam suna hai? BM25 likh sakte ho? Top-k efficiently nikaalte ho ya `sort()` maar dete ho? | **100 lines TypeScript, zero dependencies** -- `tokenize` + `InvertedIndex` + BM25 `search` + bounded heap + trie |
| **System design round** | Production mein tum Lucene dobara nahi likhoge -- tum Elasticsearch ke saamne sahi query banaoge | **`query-builder.ts`** -- spec wali canonical DSL, filter vs query context, function_score |

Isliye is Part ke do halves hain: **(a) from scratch**, **(b) production**.

> Interview line jo har interviewer ko pasand aati hai: "Main pehle 50 line mein inverted index aur BM25 likh deta hoon, taaki ye clear ho ki Elasticsearch andar kya kar raha hai. Uske baad main wahi query Elasticsearch DSL mein likhunga -- kyunki production mein main Lucene dobara nahi likhunga."

> Connection: Rate Limiter ke Part 26 mein bhi yahi pattern tha -- in-memory class, injectable clock, "production mein storage badlega, algorithm nahi". Yahan bhi wahi: **algorithm same hai (inverted index + BM25), storage aur distribution badal jaati hai.**

---

## (a) Mini search engine from scratch -- TypeScript

### Step 1 -- Clarify (1-2 minute, typing se pehle)

> "Code likhne se pehle chaar-paanch cheezein confirm kar leta hoon."

| Question | Mera assumption (agar interviewer bole "you decide") |
|---|---|
| Corpus kitna bada? Memory mein aa jaayega? | In-memory, ~10K documents. Disk/segments ka zikr karunga par likhunga nahi |
| Query semantics: **AND** ya **OR**? | **AND** (sab terms match karein) -- e-commerce mein "iphone case" par sirf cases chahiye. OR + `minimum_should_match` fallback bhi bolunga |
| Ranking chahiye ya sirf matching? | Ranking chahiye -- warna ye `LIKE` se behtar kaise hua? **BM25** |
| Phrase search chahiye (`"red cotton shirt"` exact order)? | v1 mein nahi -- bag of words. Positions store karne padenge, woh extension hai |
| Documents update/delete honge? | v1 mein append-only. Delete ka jawab **tombstone + merge** hai (Lucene wahi karta hai) |
| Typo tolerance? | v1 mein nahi. Fuzzy = term dictionary mein edit-distance expansion, mehenga -- design mein bolunga |
| Autocomplete bhi chahiye? | Haan -- **prefix trie** with precomputed top-N per node |
| Top-k chahiye ya saare results? | Top-k (k = 10 ya 24). **Isliye main sort nahi karunga, bounded min-heap use karunga** |
| Concurrency? | Single process, synchronous. Node ka event loop synchronous code todta nahi |

> Interview tip: sirf **"AND ya OR?"** ye ek sawaal poochne se hi interviewer samajh jaata hai ki tumne search pehle kiya hai.

### Step 2 -- Logic pehle bolo (code se pehle, Hinglish mein)

> "Teen structures chahiye.
>
> **Ek:** `tokenize()` -- text ko searchable units mein todna. Lowercase (kyunki `Mobile` aur `mobile` ek hi cheez hai), non-alphanumeric par split, stop words (`the`, `for`, `with`) hataana kyunki woh har document mein hain matlab unki information value zero hai, aur ek chhota stemmer taaki `cases` aur `case` ek hi term ban jaayein.
>
> **Do:** `InvertedIndex` -- `term -> [{docId, tf}]`. Postings **badhte hue docId** mein insert hongi, kyunki intersection sorted lists par hi sasta hota hai. Saath mein har doc ki length aur average doc length, kyunki BM25 ko length normalization chahiye.
>
> **Teen:** `search(query)` -- query ko usi analyzer se tokenize karo (ye bahut important hai: index-time aur query-time analyzer match karne chahiye, warna `Cases` kabhi match nahi karega), phir postings intersect karo -- **sabse chhoti list se shuru**, kyunki AND ka result usse bada ho hi nahi sakta. Phir har surviving doc ko **BM25** se score karo aur top-k ek **bounded min-heap** se nikaalo -- pure sort O(n log n) hai, heap O(n log k) hai, aur k chhota hai.
>
> Autocomplete ke liye alag structure: **prefix trie**, jisme har node par top-10 suggestions pehle se stored hain. Index time par kaam karke query time O(prefix length) kar diya -- yahi trade ES ke edge n-gram mein bhi hai."

Ab code.

### Step 3 -- `tokenize()` (analyzer)

```ts
// analyzer.ts -- yahi cheez ES mein "analyzer" kehlati hai:
// char filter -> tokenizer -> lowercase -> stop words -> stemmer
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'with', 'in', 'on', 'at', 'to', 'is', 'are', 'by', 'this', 'that',
]);

/** Bahut chhota Porter-style stemmer -- sirf plural aur -ing. Production mein snowball use karo. */
export function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) {
    let base = w.slice(0, -3);
    if (base.length > 2 && base[base.length - 1] === base[base.length - 2]) base = base.slice(0, -1);
    return base;                                   // running -> runn -> run
  }
  if (w.endsWith('sses')) return w.slice(0, -2);   // glasses -> glass
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'; // batteries -> battery
  if (w.endsWith('ss')) return w;                  // wireless -> wireless (s mat hatao)
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);         // cases -> case
  return w;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length === 0) continue;
    if (STOP_WORDS.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}
```

**Code Explanation:**

- `STOP_WORDS` ek `Set` hai, array nahi -- lookup O(1). 50M documents par har token ke liye ye lookup chalega, toh `includes()` (O(n)) yahan bewakoofi hoti.
- Stop words hataate kyun hain? Kyunki `the` **har** document mein hai. IDF formula usko waise bhi ~0 weight dega, lekin uski **postings list 50M lambi** hogi -- woh disk aur intersection dono ko mehenga karti hai. Isliye index se hi nikaal do.
- `stem()` pehle `-ing` handle karta hai kyunki woh sabse specific rule hai. `base[len-1] === base[len-2]` -- doubled consonant undouble: `running -> runn -> run`. Yahi Porter step 1b ka simplified version hai.
- Order **bahut important** hai: `sses` -> `ies` -> `ss` -> `s`. Agar `s` wala rule pehle likh dete toh `wireless -> wireles` ho jaata (galat) aur `glasses -> glasse` (bhi galat).
- `w.endsWith('ss') return w` -- ye rule hi `wireless`, `class`, `glass` ko bachaata hai.
- `text.toLowerCase().split(/[^a-z0-9]+/)` -- lowercase **pehle**, phir split, taaki regex `a-z` kaafi ho. `iPhone-15` -> `["iphone", "15"]`.
- **Sabse important cheez:** yahi `tokenize` index time **aur** query time dono par chalega. Agar dono alag ho gaye toh index mein `case` pada hai aur query `cases` dhoondh rahi hai -> zero results. Part 1 ki "iphon cover -> zero results" problem ka aadha hissa yahi hai.
- Real ES mein `product_index` analyzer (lowercase + en_stop + en_stemmer) aur `product_search` analyzer (usmein extra `syn_graph`) -- **thode alag** hain, jaan boojh ke: synonyms sirf search time par lagte hain taaki synonym list badalne par reindex na karna pade.

### Step 4 -- `InvertedIndex` class

```ts
export interface Doc { productId: string; title: string; description: string }
export interface Posting { docId: number; tf: number }

const K1 = 1.2;   // term frequency saturation
const B = 0.75;   // field length normalization strength

export class InvertedIndex {
  private readonly postings = new Map<string, Posting[]>();
  private readonly docs: Doc[] = [];
  private readonly docLengths: number[] = [];
  private totalLength = 0;

  addDocument(doc: Doc): number {
    const docId = this.docs.length;          // monotonically increasing -> postings sorted
    this.docs.push(doc);

    const tokens = tokenize(doc.title + ' ' + doc.description);
    const tfMap = new Map<string, number>();
    for (const t of tokens) tfMap.set(t, (tfMap.get(t) ?? 0) + 1);

    for (const [term, tf] of tfMap) {
      let list = this.postings.get(term);
      if (list === undefined) { list = []; this.postings.set(term, list); }
      list.push({ docId, tf });               // append = still sorted by docId
    }

    this.docLengths[docId] = tokens.length;
    this.totalLength += tokens.length;
    return docId;
  }

  get docCount(): number { return this.docs.length }
  get termCount(): number { return this.postings.size }
  get avgDocLength(): number { return this.docs.length === 0 ? 0 : this.totalLength / this.docs.length }

  postingsFor(term: string): Posting[] { return this.postings.get(term) ?? [] }
  doc(docId: number): Doc { return this.docs[docId] }
  docLength(docId: number): number { return this.docLengths[docId] }

  /** IDF -- rare term = zyada weight. Lucene wala same "probabilistic with +1" variant. */
  idf(term: string): number {
    const df = this.postingsFor(term).length;
    const N = this.docCount;
    return Math.log(1 + (N - df + 0.5) / (df + 0.5));
  }

  /** BM25 -- ek term ka ek doc par contribution. */
  bm25(term: string, tf: number, docId: number): number {
    const dl = this.docLength(docId);
    const norm = 1 - B + B * (dl / this.avgDocLength);
    return this.idf(term) * ((tf * (K1 + 1)) / (tf + K1 * norm));
  }
}
```

**Code Explanation:**

- `postings: Map<string, Posting[]>` -- yahi **poora inverted index** hai. "Kaun se documents mein ye term hai" -- forward direction (doc -> terms) ki ulti. Postgres ka `ILIKE '%x%'` yahi structure nahi rakhta, isliye usko har row padhni padti hai.
- `docId = this.docs.length` -- naya doc hamesha sabse bada docId leta hai, aur hum `push` karte hain. Nateeja: **har postings list automatically docId-ascending sorted hai.** Isi par poora intersection algorithm tika hai. Lucene mein bhi docIds segment ke andar sequential hote hain, isliye delta encoding itni achhi kaam karti hai.
- `tfMap` pehle banate hain, seedha postings mein push nahi karte -- warna ek doc mein `case` 3 baar aane par 3 postings ban jaatin. Ek doc ka ek term = **ek** posting with `tf: 3`.
- `docLengths[docId] = tokens.length` + `totalLength` -- BM25 ko document length aur average length dono chahiye. Isliye ye index ke saath hi maintain karo, query time par calculate mat karo.
- `idf` formula: `ln(1 + (N - df + 0.5) / (df + 0.5))`. `df` = kitne docs mein term hai. `df` chhota (rare term) -> numerator bada -> idf bada. Bahar ka `1 +` isliye hai ki idf kabhi **negative** na ho -- purane BM25 mein agar term aadhe se zyada docs mein ho toh idf negative ho jaata tha, matlab common term match karne par score **ghat** jaata. Lucene ne wahi `1 +` wala variant liya hai.
- `+0.5` -- smoothing. `df = N` (har doc mein term) par bhi divide-by-zero nahi hota.
- `norm = 1 - B + B * (dl / avgdl)` -- `B = 0.75` matlab 75% length normalization. Chhota document (`dl < avgdl`) -> `norm < 1` -> denominator chhota -> **score zyada**. Yahi woh signal hai jo "iPhone 15 Case" (chhota title) ko "iPhone 15 Pro Max 256GB Blue Titanium 5G Smartphone with A17 Pro Chip..." (lamba title) se upar rakhta hai.
- `(tf * (K1 + 1)) / (tf + K1 * norm)` -- **tf saturation.** `K1 = 1.2` decide karta hai ki tf ka fayda kitni jaldi flat ho jaata hai. Ye hi TF-IDF aur BM25 ka sabse bada farq hai: TF-IDF mein tf linear hai, toh spammer title mein "case case case case case" likh ke score 5x kar sakta tha. BM25 mein woh 5x nahi milta -- neeche numbers mein dikhata hoon.
- `K1` aur `B` constants hain; ES mein inhe `similarity` setting se tune kar sakte ho, lekin **90% cases mein default hi sahi hai** -- ye bhi ek achha interview point hai (don't over-tune).

### Step 5 -- BM25 ko haath se samjho (numbers ke saath)

Poora formula:

```
                         tf(t, d) * (k1 + 1)
BM25(q, d) = SUM   idf(t) * -------------------------------------------
            t in q               tf(t, d) + k1 * (1 - b + b * dl / avgdl)

idf(t) = ln( 1 + (N - df(t) + 0.5) / (df(t) + 0.5) )

N      = total documents
df(t)  = kitne documents mein term t hai
tf(t,d)= document d mein term t kitni baar
dl     = document d ki length (tokens)
avgdl  = saare documents ki average length
k1     = 1.2  (tf saturation)
b      = 0.75 (length normalization)
```

Hamare 5 sample products par (neeche main() ka real output): `N = 5`, `avgdl = 12.20`, doc lengths `[15, 12, 13, 11, 10]`.

Term `case`: `df = 2` (P2 aur P3 mein).

```
idf(case) = ln(1 + (5 - 2 + 0.5) / (2 + 0.5)) = ln(1 + 3.5/2.5) = ln(2.4) = 0.8755
```

| Doc | tf | dl | norm = 1 - 0.75 + 0.75*(dl/12.2) | tf-part = tf*2.2 / (tf + 1.2*norm) | score = idf * tf-part |
|---|---|---|---|---|---|
| P3 `iPhone 15 Case Cover Transparent` | **3** | 13 | 0.25 + 0.75*1.0656 = **1.0492** | 6.6 / (3 + 1.2590) = **1.5497** | 0.8755 * 1.5497 = **1.3567** |
| P2 `Spigen Silicone Case for iPhone 15 Pro Max` | 2 | 12 | 0.25 + 0.75*0.9836 = **0.9877** | 4.4 / (2 + 1.1852) = **1.3814** | 0.8755 * 1.3814 = **1.2093** |

P3 jeeta kyunki uska `tf` zyada hai (3 vs 2) -- word "case" us document ka **main topic** hai.

Ab saturation dekho. Maan lo P3 mein `case` 3 ki jagah **6** baar hota (seller ne keyword stuffing ki):

```
tf = 6 -> 6*2.2 / (6 + 1.2590) = 13.2 / 7.2590 = 1.8184 -> score = 0.8755 * 1.8184 = 1.5920
```

**tf double karne par score sirf 1.3567 -> 1.5920 (+17%) badha, 2x nahi.** Yahi `k1` ka kaam hai. Agar purana TF-IDF hota toh score seedha double ho jaata aur keyword stuffing kaam kar jaati.

> Interview line: "BM25 ek TF-IDF hai jismein do fixes hain -- tf **saturate** hota hai (k1) taaki keyword stuffing kaam na kare, aur score document ki **length se normalize** hota hai (b) taaki chhote title mein match ek strong signal maana jaaye. Ye Lucene aur Elasticsearch ka default similarity hai."

### Step 6 -- Postings intersection

```ts
/** Sorted postings lists ka AND. Sabse chhoti list drive karti hai. */
export function intersect(lists: Posting[][]): number[] {
  if (lists.length === 0) return [];
  const sorted = lists.slice().sort((a, b) => a.length - b.length);
  if (sorted[0].length === 0) return [];          // koi ek term missing = AND empty

  const cursors = new Array<number>(sorted.length).fill(0);
  const out: number[] = [];

  outer: while (cursors[0] < sorted[0].length) {
    let candidate = sorted[0][cursors[0]].docId;

    for (let i = 1; i < sorted.length; i++) {
      while (cursors[i] < sorted[i].length && sorted[i][cursors[i]].docId < candidate) cursors[i]++;
      if (cursors[i] >= sorted[i].length) break outer;       // list khatam -> aur match nahi
      if (sorted[i][cursors[i]].docId > candidate) {
        candidate = sorted[i][cursors[i]].docId;             // aage badho
        while (cursors[0] < sorted[0].length && sorted[0][cursors[0]].docId < candidate) cursors[0]++;
        if (cursors[0] >= sorted[0].length) break outer;
        continue outer;                                      // naye candidate par dobara try
      }
    }
    out.push(candidate);                                     // saari lists mein mila
    cursors[0]++;
  }
  return out;
}
```

**Code Explanation:**

- `lists.slice().sort((a, b) => a.length - b.length)` -- **sabse chhoti postings list pehle.** `slice()` isliye ki caller ka array mutate na ho. Ye ek line poore algorithm ki speed decide karti hai: AND ka result sabse chhoti list se bada ho hi nahi sakta, toh usi ko driver banao. `iphone` (10M docs) AND `case` (50K docs) -> 50K wali drive karegi, 10M wali nahi.
- `if (sorted[0].length === 0) return []` -- agar kisi bhi term ki postings khaali hain (woh word index mein hai hi nahi) toh AND ka jawab khaali hai. Sorting ki wajah se khaali list hamesha index 0 par hogi. **Early exit** -- baaki kaam hi nahi karna.
- `cursors` -- har list mein ek pointer. Koi list dobara start se nahi padhi jaati, isliye har posting **zyada se zyada ek baar** touch hoti hai -> total O(sum of list lengths).
- Andar wala `while (... .docId < candidate) cursors[i]++` -- ye **skip** hai. Real Lucene yahin `advance(target)` call karta hai jo **skip list** use karke poore blocks jump kar jaata hai, ek-ek posting nahi padhta. Hamara linear scan usi ka simple version hai.
- `if (... .docId > candidate)` -- is list mein candidate nahi mila, lekin ek **bada** docId mil gaya. Toh candidate ko uspar le jao, list-0 ko bhi wahan tak aage badhao, aur `continue outer`. Ye "leapfrog" pattern hai -- dono taraf se aage badhte hain, peeche kabhi nahi.
- `out.push(candidate)` -- for loop bina break ke poora ho gaya matlab candidate **saari** lists mein hai. AND satisfied.
- `break outer` -- koi bhi list khatam = aur koi common docId ho hi nahi sakta. Turant ruko.
- Output **docId-ascending sorted** hai, kyunki hum hamesha aage hi badhe. Tie-breaking ke liye kaam aata hai.
- Ye 8 test cases par verify kiya gaya (neeche unit-test sketch dekho): disjoint lists, ek khaali list, single list, ek chhoti + ek badi, teen identical, aur "sab alag par last element common".

### Step 7 -- Top-k bounded min-heap (sort mat karo)

```ts
export interface Hit { docId: number; score: number }

/** a, b se "worse" hai? Worse = kam score; barabar score par bada docId. */
function isWorse(a: Hit, b: Hit): boolean {
  if (a.score !== b.score) return a.score < b.score;
  return a.docId > b.docId;
}

export class TopK {
  private readonly heap: Hit[] = [];
  constructor(private readonly k: number) {}

  push(item: Hit): void {
    if (this.heap.length < this.k) { this.heap.push(item); this.siftUp(this.heap.length - 1); return; }
    if (this.k === 0) return;
    if (isWorse(this.heap[0], item)) { this.heap[0] = item; this.siftDown(0); }  // root = sabse kharab
  }

  drain(): Hit[] {
    const out = this.heap.slice();
    out.sort((a, b) => (b.score - a.score) || (a.docId - b.docId));
    return out;
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!isWorse(this.heap[i], this.heap[p])) break;
      [this.heap[i], this.heap[p]] = [this.heap[p], this.heap[i]];
      i = p;
    }
  }

  private siftDown(i: number): void {
    const n = this.heap.length;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < n && isWorse(this.heap[l], this.heap[m])) m = l;
      if (r < n && isWorse(this.heap[r], this.heap[m])) m = r;
      if (m === i) break;
      [this.heap[i], this.heap[m]] = [this.heap[m], this.heap[i]];
      i = m;
    }
  }
}
```

**Code Explanation:**

- Ye **min-heap** hai, matlab root par **sabse kharab** (lowest score) hit baitha hai. Ye ulta lagta hai par yahi trick hai: top-k nikalne ke liye humein pata hona chahiye ki "abhi tak ka sabse kamzor result kaun hai" -- taaki naye result se usi ko compare karke replace kar sakein.
- `isWorse` mein score ke baad `a.docId > b.docId` -- **deterministic tie-breaker.** Barabar score par chhota docId better maana jaata hai. Bina tie-breaker ke do baar same query chalane par order badal sakta hai, aur pagination tootegi. Spec ki query mein bhi `"sort": ["_score", { "productId": "asc" }]` isi wajah se hai.
- `if (this.heap.length < this.k)` -- heap abhi bhara nahi, seedha daalo aur `siftUp`. O(log k).
- `if (isWorse(this.heap[0], item))` -- heap bhara hai. Agar naya item root se behtar hai toh root ko **replace** karo aur `siftDown`. Warna naya item top-k mein aa hi nahi sakta -- **kuch mat karo, O(1)**. 10 million matching docs par zyadatar yahi O(1) branch chalti hai.
- `drain()` sirf `k` elements sort karta hai (k = 10 ya 24), 10 million nahi.
- **Kyun sort nahi?** 10M matching docs ko `Array.sort()` = O(n log n) ~ 10M x 23 = 230M comparisons, plus 10M objects ka array memory mein. Heap = O(n log k) ~ 10M x 3.3 = 33M, aur memory sirf k objects. Aur asli baat: **sorting sab kuch karti hai jabki humein sirf 24 chahiye.**
- `(i - 1) >> 1` -- parent index. `>> 1` = integer divide by 2, `Math.floor` se tez aur clearer.
- Lucene mein yahi kaam `TopScoreDocCollector` karta hai, aur uske upar **WAND / block-max WAND** hota hai: agar kisi block ka maximum possible score heap ke root se kam hai toh poora block **skip** kar deta hai -- hum woh optimization nahi likh rahe, par uska naam lena interview mein bonus hai.

### Step 8 -- `search(query)` -- sab jodo

```ts
export interface SearchResult { productId: string; title: string; score: number }

export function search(index: InvertedIndex, query: string, k = 10): SearchResult[] {
  const terms = Array.from(new Set(tokenize(query)));        // SAME analyzer as index time
  if (terms.length === 0) return [];                          // empty / only stop words

  const lists = terms.map((t) => index.postingsFor(t));
  const matched = intersect(lists);                           // AND

  // term -> (docId -> tf), taaki scoring mein dobara search na karna pade
  const tfLookup = lists.map((list) => {
    const m = new Map<number, number>();
    for (const p of list) m.set(p.docId, p.tf);
    return m;
  });

  const topk = new TopK(k);
  for (const docId of matched) {
    let score = 0;
    for (let i = 0; i < terms.length; i++) {
      score += index.bm25(terms[i], tfLookup[i].get(docId)!, docId);
    }
    topk.push({ docId, score });
  }

  return topk.drain().map((h) => ({
    productId: index.doc(h.docId).productId,
    title: index.doc(h.docId).title,
    score: h.score,
  }));
}
```

**Code Explanation:**

- `new Set(tokenize(query))` -- duplicate terms hata do. `"case case"` query mein `case` do baar score nahi hona chahiye, warna user apni hi query repeat karke ranking hila sakta hai.
- `if (terms.length === 0) return []` -- **do edge cases ek line mein**: empty query, aur "the and of" jaisi query jisme sirf stop words hain. Production mein iska matlab hai: empty query par 400 mat do, balki **default category listing** dikha do (business decision).
- `tfLookup` -- scoring loop mein har doc ke liye postings list dobara scan karna O(n*m) ho jaata. Ek baar Map bana lo, phir O(1) lookups. Memory trade: sum of postings lengths. Bade lists par ye galat hai -- Lucene iterators ke saath streaming scoring karta hai (posting padhte hi score kar deta hai), memory Map nahi banata. Ye **honestly bolna** interview mein achha lagta hai.
- `tfLookup[i].get(docId)!` -- `!` isliye safe hai kyunki `docId` intersection se aaya hai, matlab woh **har** list mein hai.
- `score +=` -- BM25 ka SUM over query terms. Isliye "iphone case" ka score = score(iphone) + score(case).
- `topk.push` -- sort nahi, heap.

### Step 9 -- `main()` -- 5 products, real output

```ts
const PRODUCTS: Doc[] = [
  { productId: 'P1', title: 'Apple iPhone 15 Pro Max 256GB Blue Titanium', description: 'Latest iPhone with titanium body and A17 Pro chip' },
  { productId: 'P2', title: 'Spigen Silicone Case for iPhone 15 Pro Max',  description: 'Slim protective case, drop tested' },
  { productId: 'P3', title: 'iPhone 15 Case Cover Transparent',            description: 'Clear case for iPhone 15, shock absorbing cases pack' },
  { productId: 'P4', title: 'Samsung Galaxy S24 Ultra 512GB Phone',        description: 'Flagship Samsung phone with S Pen' },
  { productId: 'P5', title: 'boAt Airdopes 141 Wireless Earbuds',          description: 'Bluetooth earbuds with 42 hours playback' },
];

function main(): void {
  const index = new InvertedIndex();
  for (const p of PRODUCTS) index.addDocument(p);

  console.log('docCount     =', index.docCount);
  console.log('termCount    =', index.termCount);
  console.log('avgDocLength =', index.avgDocLength.toFixed(2));
  console.log('docLengths   =', index.docLengths.join(', '));

  for (const t of ['iphone', 'case', 'pro', 'phone', 'samsung']) {
    console.log(`postings[${t}]`.padEnd(18), '->',
      index.postingsFor(t).map((p) => `${PRODUCTS[p.docId].productId}(tf=${p.tf})`).join(' ') || '(none)',
      ` idf=${index.idf(t).toFixed(3)}`);
  }

  for (const q of ['iphone case', 'iphone', 'case', 'cases', 'samsung phone', 'the and of', 'laptop', '']) {
    console.log(`query "${q}" -> tokens [${tokenize(q).join(', ')}]`);
    const hits = search(index, q, 3);
    if (hits.length === 0) console.log('   (no results)');
    for (const h of hits) console.log(`   ${h.score.toFixed(4).padStart(8)}  ${h.productId}  ${h.title}`);
  }
}
main();
```

**Actual output (ye code chalakar nikala gaya hai):**

```
docCount     = 5
termCount    = 43
avgDocLength = 12.20
docLengths   = 15, 12, 13, 11, 10

postings[iphone]   -> P1(tf=2) P2(tf=1) P3(tf=2)  idf=0.539
postings[case]     -> P2(tf=2) P3(tf=3)           idf=0.875
postings[pro]      -> P1(tf=2) P2(tf=1)           idf=0.875
postings[phone]    -> P4(tf=2)                    idf=1.386
postings[samsung]  -> P4(tf=2)                    idf=1.386

query "iphone case" -> tokens [iphone, case]
     2.0844  P3  iPhone 15 Case Cover Transparent
     1.7520  P2  Spigen Silicone Case for iPhone 15 Pro Max
query "iphone" -> tokens [iphone]
     0.7277  P3  iPhone 15 Case Cover Transparent
     0.6962  P1  Apple iPhone 15 Pro Max 256GB Blue Titanium
     0.5426  P2  Spigen Silicone Case for iPhone 15 Pro Max
query "case" -> tokens [case]
     1.3567  P3  iPhone 15 Case Cover Transparent
     1.2093  P2  Spigen Silicone Case for iPhone 15 Pro Max
query "cases" -> tokens [case]
     1.3567  P3  iPhone 15 Case Cover Transparent
     1.2093  P2  Spigen Silicone Case for iPhone 15 Pro Max
query "samsung phone" -> tokens [samsung, phone]
     3.9208  P4  Samsung Galaxy S24 Ultra 512GB Phone
query "the and of" -> tokens []
   (no results)
query "laptop" -> tokens [laptop]
   (no results)
query "" -> tokens []
   (no results)
```

**Code Explanation -- output kya prove karta hai:**

- **Part 1 ki problem solve ho gayi.** `query "iphone case"` par `P1 (Apple iPhone 15 Pro Max)` **result mein hai hi nahi** -- kyunki usme `case` term nahi hai, aur hum AND kar rahe hain. Part 1 mein `ILIKE '%iphone case%'` isi jagah "iPhone 15" ko upar dikhata tha.
- **BM25 actually order kar raha hai, match/no-match nahi.** `P3 (2.0844)` > `P2 (1.7520)`. Kyun? P3 mein `case` 3 baar hai (tf=3 vs 2), aur uska title chhota hai. Ye woh "relevance" hai jo SQL `LIKE` mein exist hi nahi karti.
- **`idf` sach mein rare terms ko upar utha raha hai.** `phone` aur `samsung` sirf 1 doc mein hain -> `idf = 1.386`. `iphone` 3 docs mein -> `idf = 0.539`. Isliye "samsung phone" ka score 3.92 hai (do rare terms) jabki "iphone case" ka 2.08.
- **`query "cases"` aur `query "case"` ka output bilkul same hai.** Stemmer kaam kar raha hai. Ye Part 1 ki "mobiles vs mobile" wali problem ka jawab hai.
- **`query "iphone"` (single term) par P1 beech mein aaya.** P3 (tf=2, dl=13) 0.7277, P1 (tf=2, dl=15) 0.6962, P2 (tf=1, dl=12) 0.5426. P1 aur P3 dono ka tf=2 hai, par P1 ka document **lamba** hai (15 vs 13) -> length normalization ne usko neeche kar diya. Yahi `b = 0.75` ka effect hai, live.
- **`query "the and of"`** -> tokens `[]` -> no results. Ye galti nahi, ye **design** hai; production mein iska handling business decision hai (default listing dikhao).
- **`query "laptop"`** -> token hai par postings khaali -> `intersect` ka early-exit chala. Ye **zero-result** case hai, aur spec kehta hai zero-result rate `< 5%` par rakhna hai -- yahin fuzzy/synonyms/OR-fallback aate hain.
- `termCount = 43` -- 5 chhote products ne 43 unique terms banaye. 50M products par ye number **crores** mein jaata hai; isiliye real term dictionary RAM mein plain `Map` nahi hoti, woh **FST (finite state transducer)** hoti hai jo prefixes share karke memory bachati hai.

### Step 10 -- Autocomplete: prefix trie

```ts
interface Suggestion { text: string; weight: number }

class TrieNode {
  readonly children = new Map<string, TrieNode>();
  top: Suggestion[] = [];                 // is prefix ke top-N, INDEX TIME par precomputed
}

export class PrefixTrie {
  private readonly root = new TrieNode();
  constructor(private readonly topN = 10) {}

  insert(phrase: string, weight: number): void {
    const text = phrase.toLowerCase().trim();
    if (text.length === 0) return;
    let node = this.root;
    this.merge(node, text, weight);
    for (const ch of text) {
      let next = node.children.get(ch);
      if (next === undefined) { next = new TrieNode(); node.children.set(ch, next); }
      node = next;
      this.merge(node, text, weight);     // har prefix node par ye phrase candidate hai
    }
  }

  private merge(node: TrieNode, text: string, weight: number): void {
    const at = node.top.findIndex((s) => s.text === text);
    if (at >= 0) { if (node.top[at].weight >= weight) return; node.top.splice(at, 1); }
    node.top.push({ text, weight });
    node.top.sort((a, b) => (b.weight - a.weight) || a.text.localeCompare(b.text));
    if (node.top.length > this.topN) node.top.length = this.topN;   // bounded
  }

  suggest(prefix: string, limit = 10): string[] {
    let node = this.root;
    for (const ch of prefix.toLowerCase().trim()) {
      const next = node.children.get(ch);
      if (next === undefined) return [];      // prefix hi nahi hai -> turant khaali
      node = next;
    }
    return node.top.slice(0, limit).map((s) => s.text);   // O(limit), koi traversal nahi
  }
}
```

Usage aur **actual output**:

```ts
const trie = new PrefixTrie(10);
trie.insert('iphone 15 case', 98_000);        // weight = query_popularity.searches_30d
trie.insert('iphone 15 pro max', 120_000);
trie.insert('iphone charger', 41_000);
trie.insert('ipad air', 22_000);
trie.insert('samsung galaxy s24', 76_000);
for (const p of ['i', 'ip', 'iph', 'iphone c', 'sam', 'xyz']) {
  console.log(`suggest("${p}")`.padEnd(20), '->', JSON.stringify(trie.suggest(p, 3)));
}
```

```
suggest("i")         -> ["iphone 15 pro max","iphone 15 case","iphone charger"]
suggest("ip")        -> ["iphone 15 pro max","iphone 15 case","iphone charger"]
suggest("iph")       -> ["iphone 15 pro max","iphone 15 case","iphone charger"]
suggest("iphone c")  -> ["iphone charger"]
suggest("sam")       -> ["samsung galaxy s24"]
suggest("xyz")       -> []
```

**Code Explanation:**

- `TrieNode.top` -- **yahi poori trick hai.** Har node par us prefix ke top-N suggestions **pehle se** stored hain. Query time par koi subtree traversal nahi, koi sorting nahi -- bas prefix walk karke `top.slice(0, limit)`. Ye **O(prefix length)** hai, corpus size se independent.
- Ye exactly wahi trade hai jo spec mein **edge n-gram** ke liye likha hai: `iphone -> i, ip, iph, ipho, iphon, iphone` **index time** par bana lo, query time par simple term match ho jaaye. Dono cheezein ek hi philosophy hain -- **"index time par kaam karo taaki query time sasta ho"**.
- `merge()` mein bounded list: `if (node.top.length > this.topN) node.top.length = this.topN`. Bina bound ke root node par **poora corpus** aa jaata (kyunki root har phrase ka prefix hai) -- memory blow-up. `topN = 10` isse O(nodes x 10) par cap karta hai.
- `findIndex` + `splice` -- same phrase dobara insert ho (updated weight ke saath) toh duplicate na bane.
- `weight` = `query_popularity.searches_30d` (spec ki table). Matlab suggestions **popularity se ranked** hain, alphabetically nahi. `suggest("i")` par "iphone 15 pro max" (120K) sabse upar hai, "ipad air" (22K) top-3 mein aaya hi nahi.
- `suggest("xyz")` -> `[]` -- pehle hi character par node nahi mila, turant return. Fast negative.
- **Ek honest limitation jo khud bolna chahiye:** `suggest("iphone c")` sirf `["iphone charger"]` deta hai, `"iphone 15 case"` nahi -- kyunki trie **poore phrase ka prefix** match karta hai, har word ka nahi. ES ka edge n-gram **per token** chalta hai, isliye `title.ac` field mein `case` ka `ca`, `cas`, `case` alag se indexed hote hain aur "iphone c" dono match karta. Ye limitation jaan kar bolna interview mein bada plus point hai.
- Alternative jo bilkul same result deta hai aur likhne mein aasan hai: **edge n-gram map** -- `Map<string, Suggestion[]>` jisme key har prefix hai. Memory zyada (prefixes share nahi hote), lookup O(1). Trie memory efficient hai kyunki common prefixes ek hi path share karte hain. Lucene ka `completion suggester` isi ka compressed version (**FST**) use karta hai.

### Step 11 -- Complexity

Symbols:

- **N** = total documents
- **T** = total tokens indexed (sab documents milakar)
- **V** = vocabulary size (unique terms)
- **Q** = query ke terms ki count
- **P** = query terms ki postings lists ki **total length** (sum)
- **M** = intersection ke baad bache documents (`M <= min(list lengths)`)
- **k** = top-k

| Operation | Time | Kyun |
|---|---|---|
| `tokenize(text)` | **O(len(text))** | Ek pass: lowercase, split, stop-word Set lookup O(1), stem O(1) |
| `addDocument` | **O(tokens in doc)** | tfMap build + har unique term par ek `push` (amortized O(1)) |
| **Poora index build** | **O(T)** | Har token ek baar. 50M x ~150 tokens = ~7.5B token operations -- isliye production mein ye ek **batch/bulk job** hai, request path par nahi |
| `idf(term)` | **O(1)** | `postings.get().length` -- `df` already pata hai |
| `intersect(lists)` | **O(P + Q log Q)** | Har posting zyada se zyada ek baar touch; `Q log Q` lists ko length se sort karne ka |
| Scoring | **O(M x Q)** | Har surviving doc par Q terms ka BM25 |
| Top-k | **O(M log k)** | Heap; zyadatar push O(1) mein reject ho jaate hain |
| **`search(query)` total** | **O(P) + O(M log k)** | Yaani "query terms ki postings lists ki total length" + "top-k". `P` dominate karta hai |
| `PrefixTrie.insert` | **O(len(phrase) x topN log topN)** | Har prefix node par bounded list sort |
| `PrefixTrie.suggest` | **O(len(prefix) + limit)** | **Corpus size se independent** -- yahi autocomplete ka p99 < 100 ms deta hai |

| Structure | Space | Kyun |
|---|---|---|
| Term dictionary | **O(V)** | Unique terms. Real Lucene mein FST -- prefixes share hote hain, RAM bachti hai |
| Postings | **O(T)** postings total | Har (doc, term) pair ek posting |
| Per posting -- **hamara JS** | **~40-60 bytes** | `{ docId, tf }` object header + 2 doubles + array slot. 7.5B postings = **~375 GB** -- yaani hamara version 50M products par chalega hi nahi |
| Per posting -- **Lucene** | **~1-2 bytes** | docId **delta-encoded** (5, 9, 14 -> 5, 4, 5) + **variable-byte / PFOR** compression. Isliye 50M products ka poora ES index spec mein **~130 GB** hai, jisme `_source` aur doc values bhi shamil hain |
| `docLengths` | **O(N)** | Lucene isko `norms` mein **1 byte per doc per field** mein squeeze karta hai (lossy, kaafi hai) |
| Trie | **O(unique prefixes x topN)** | Isliye suggestions index chhota hai aur **poora RAM mein fit** ho jaata hai (spec: `suggestions_v2`) |

> Interview line: "Query time `O(P)` hai -- query terms ki postings lists ki total length -- plus top-k ke liye `O(M log k)`. Isliye search ki cost **corpus size se nahi, matched documents se** aati hai. Aur isiliye ek bahut common term (`the`, ya hamare catalog mein `mobile`) poora query plan mehenga kar deta hai. Do fix hain: stop words hataana, aur Lucene ka **block-max WAND**, jo un blocks ko skip kar deta hai jinka maximum possible score already-collected top-k se kam hai."

---

## (b) Production version -- wahi query, Elasticsearch ke saamne

### Step 12 -- `query-builder.ts` (Part 2 wala module)

Production mein humne ye 200 lines **nahi** likhi. Humne yeh likha:

```ts
// src/search/query-builder.ts   (Part 2 mein line-by-line samjhaaya gaya)
import type { SearchRequest } from '../types';

const PAGE_LIMIT = 50;

export function buildSearchQuery(req: SearchRequest): Record<string, unknown> {
  const filter: unknown[] = [];
  if (req.filters.brand?.length)        filter.push({ terms: { brand: req.filters.brand } });
  if (req.filters.categoryPath?.length) filter.push({ terms: { categoryPath: req.filters.categoryPath } });
  if (req.filters.priceMin != null || req.filters.priceMax != null) {
    filter.push({ range: { price: { gte: req.filters.priceMin, lte: req.filters.priceMax } } });
  }
  if (req.filters.minRating != null)    filter.push({ range: { rating: { gte: req.filters.minRating } } });
  if (req.filters.inStockOnly)          filter.push({ term: { inStock: true } });

  const must = req.q.trim().length === 0 ? [{ match_all: {} }] : [{
    multi_match: {
      query: req.q, fields: ['title^3', 'brand^2', 'description'],
      type: 'best_fields', fuzziness: 'AUTO', prefix_length: 1, max_expansions: 50,
    },
  }];

  return {
    size: req.size,
    ...(req.searchAfter ? { search_after: req.searchAfter } : { from: (req.page - 1) * req.size }),
    query: {
      function_score: {
        query: { bool: { must, filter } },
        functions: [
          { field_value_factor: { field: 'popularityScore', modifier: 'log1p', missing: 0 }, weight: 0.3 },
          { filter: { term: { inStock: true } }, weight: 1.2 },
        ],
        score_mode: 'sum',
        boost_mode: 'multiply',
      },
    },
    aggs: {
      brands:       { terms: { field: 'brand', size: 10 } },
      categories:   { terms: { field: 'categoryPath', size: 10 } },
      price_ranges: { range: { field: 'price', ranges: [{ to: 500 }, { from: 500, to: 2000 }, { from: 2000 }] } },
    },
    sort: sortClause(req.sort),
    track_total_hits: 10_000,
  };
}

function sortClause(sort: SearchRequest['sort']): unknown[] {
  const tie = { productId: 'asc' };                    // deterministic tie-breaker, search_after ke liye zaruri
  switch (sort) {
    case 'price_asc':  return [{ price: 'asc' }, tie];
    case 'price_desc': return [{ price: 'desc' }, tie];
    case 'newest':     return [{ createdAt: 'desc' }, tie];
    case 'rating':     return [{ rating: 'desc' }, tie];
    default:           return ['_score', tie];
  }
}
```

**Code Explanation:**

- `filter: unknown[]` vs `must` -- **ye is file ka sabse important concept hai.** `filter` clause **score calculate nahi karta**, sirf yes/no batata hai, aur ES uska result ek **cacheable bitset** (node query cache) mein rakh leta hai. `brand = Apple` har baar dobara compute nahi hota. `must` scoring karta hai (mehenga, cache nahi hota). **Rule: jo cheez score mein contribute nahi karti woh hamesha `filter` mein.**
- `terms` (plural) `{ brand: [...] }` -- multi-select facet. UI mein user Apple **aur** Samsung dono tick kar sakta hai.
- `range: { price: { gte, lte } }` -- `price` mapping mein `scaled_float` (scaling_factor 100) hai. DB mein `price_paise BIGINT`. **Money kabhi float rupees mein nahi.**
- `req.q.trim().length === 0 ? [{ match_all: {} }]` -- hamare from-scratch version ka `return []` production mein **galat** hota: empty query par user ko category listing dikhni chahiye, error nahi. Filters phir bhi lagenge.
- `fields: ['title^3', 'brand^2', 'description']` -- **field boosting.** Title mein match 3x weight. Hamara mini engine title+description ko ek hi string mein jod deta hai, isliye ye distinction usme nahi hai -- ES har field ka BM25 alag nikaalta hai.
- `type: 'best_fields'` -- multi-field mein sabse achhe **ek** field ka score lo, sab jodo mat. "iphone case" ke liye ek hi field mein dono words milna behtar signal hai.
- `fuzziness: 'AUTO'` -- Levenshtein edit distance: length 1-2 par 0 edits, 3-5 par 1, 5 se upar 2. `iphon -> iphone`. **`prefix_length: 1`** -- pehla letter sahi maan lo, warna term dictionary ka bada hissa scan hota hai. `max_expansions: 50` -- ek term zyada se zyada 50 terms mein expand hoga, warna ek query poore cluster ko khaa jaayegi.
- `function_score` + `boost_mode: 'multiply'` -- **text relevance ko multiply karo, replace mat karo.** `popularityScore` ko `log1p` se compress karte hain warna 1M orders wala product har query jeet jaayega chahe relevant ho ya nahi. `weight: 0.3` business signal ko text signal se chhota rakhta hai.
- `aggs` -- facet counts ("Samsung (1,204)"). Ye **usi query pass** mein aate hain, alag round trip nahi. Cost: spec ke budget mein +20-40 ms.
- `track_total_hits: 10_000` -- exact total count nikalna matlab har matching doc gin-na, jo `O(all matches)` hai. "10,000+ results" dikhana kaafi hai. Response mein `totalIsLowerBound: true` set hota hai.
- `sortClause` ka `tie` -- **har** sort mein `productId: 'asc'` tie-breaker. `search_after` (deep pagination) ka poora mechanism isi par depend karta hai: page 51 ka cursor `[score, productId]` hota hai. Bina tie-breaker ke do docs ka same score = non-deterministic order = pagination mein duplicate/missing results.
- `from` vs `search_after` -- `page <= 50` tak `from/size`, uske aage `search_after` mandatory. Kyun: `from: 12000` par ES **har shard se** 12,024 docs coordinate node par laata hai (6 x 12,024) aur wahan sort karta hai -> memory blow-up. Default `index.max_result_window: 10000` isiliye hai.

### Step 13 -- Hamari 100 lines jo **nahi** karti, aur real engine jo karta hai

| Real Lucene / Elasticsearch | Hamara mini engine | Kyun matter karta hai |
|---|---|---|
| **Immutable segments** -- index chhote immutable files mein, naye docs naya segment banate hain | Ek mutable `Map` | Concurrency without locks; lekin **update = delete + re-insert**. Isliye spec kehta hai "har stock change par reindex mat karo" |
| **Tombstone deletes + background merge** | Delete hai hi nahi | Delete turant space free nahi karta; merge karta hai. Merge CPU/IO khaata hai -- flash sale ke 500 updates/sec par yahi bottleneck banta hai |
| **Skip lists / `advance(target)`** postings mein | Linear `cursors[i]++` | 10M-lambi postings list par block jump vs ek-ek posting padhna -- 100x farq |
| **Delta + variable-byte / PFOR compression** | Plain JS objects (~50 B/posting) | ~1-2 B/posting. Isi wajah se 50M docs ka index ~130 GB mein aata hai, 375 GB mein nahi |
| **Block-max WAND** | Sab matched docs score hote hain | Jin blocks ka max possible score current top-k se kam hai, woh **skip**. Common terms wali queries 10x tez |
| **Term dictionary as FST** | `Map<string, Posting[]>` | Crores unique terms, prefixes shared -> RAM mein fit + fuzzy/prefix queries efficient |
| **`refresh_interval: 1s`, near-real-time** | Instant (same process) | Naya doc turant searchable nahi hota; ek refresh cycle lagti hai. Spec: normal `1s`, bulk reindex ke dauran `-1` |
| **Distribution: 6 primary shards + 1 replica** | Single process | Query **saare** shards par parallel jaati hai, coordinate node results merge karta hai. **Slowest shard latency decide karta hai** |
| **Node query cache (filter bitsets), shard request cache** | Kuch nahi | Isliye `filter` context itna sasta hai |
| **doc values** (columnar) sorting/aggregations ke liye | Kuch nahi | Facet counts aur `sort: price` isi structure se aate hain, inverted index se nahi |
| **Analyzers: synonyms, ICU, language plugins** | 8 stop words + 5-line stemmer | `synonym_graph` search time par, `_reload_search_analyzers` se bina reindex update |

> Interview line: "Mera 100-line version algorithm sahi dikhata hai, par production mein main Lucene use karunga -- kyunki asli value algorithm mein nahi, **compression, skip lists, segment lifecycle aur distribution** mein hai. Woh 20 saal ka engineering hai, ek interview mein nahi likha jaata."

### Step 14 -- Edge cases (interviewer zaroor poochega)

| Edge case | Hamara mini engine | Production (Parts 2-5) |
|---|---|---|
| **Empty query** `q=""` | `tokens.length === 0` -> `[]` | `match_all` + filters -> category listing. Validation: `q` max 100 chars (lambi query = mehengi fuzzy expansion) |
| **Sirf stop words** `"the and of"` | Tokens `[]` -> `[]`. Ye galti nahi, design hai | Analyzer ke baad query khaali -> `match_all` fallback ya "did you mean". **Zero result page kabhi khaali mat chhodo** -- popular categories dikhao |
| **Saare terms missing** `"laptop"` (catalog mein nahi) | `intersect` early-exit -> `[]` | Yahin **zero-result rate** ka 12% baseline banta hai. Ladder: fuzzy `AUTO` -> synonyms -> AND se OR + `minimum_should_match: 70%` -> category suggestion. Target `< 5%` |
| **Ek term 10M docs match karta hai** (`mobile`) | `O(P)` -- 10M postings scan, bahut slow | (1) Sorting se chhoti list drive karti hai -- **AND mein already fix**; (2) Lucene **block-max WAND** poore blocks skip karta hai; (3) `terminate_after` / `timeout: '800ms'` + `allow_partial_search_results: true`; (4) Redis query cache (head queries = traffic ka 30%) |
| **Phrase vs bag of words** -- `"red cotton shirt"` | Bag of words. `"shirt cotton red"` ka same score | Positions chahiye. ES: `match_phrase` (`slop` ke saath) ya `shingles`. Practical trick: `bool { must: match, should: match_phrase (boost 2) }` -- phrase match ko **boost** karo, mandatory mat banao, warna recall gir jaayega |
| **Duplicate documents** (same product 5 sellers se) | Paanch alag docs, paanch baar dikhenge | **Collapse**: `{ "collapse": { "field": "productGroupId", "inner_hits": {...} } }`. Ya index time par dedupe -- ek canonical product, sellers uske offers. Search results mein duplicates = worst UX |
| **Bahut lamba document** (10,000 word description) | `b = 0.75` uske score ko push down karta hai -- sahi behaviour | Wahi, plus `index.mapping.total_fields.limit`, aur description ko **snippet** tak truncate karke index karo (spec: ~2 KB searchable doc). Lucene `norms` 1 byte mein length rakhta hai |
| **Case / diacritics** (`iPhone`, `Ipone`, `cafe` vs cafe (accented)) | Lowercase handled; diacritics nahi | `asciifolding` filter. **Aur ye analyzer change hai -> reindex chahiye** |
| **Same doc dobara `addDocument`** | Duplicate postings, docCount galat | `version_type: 'external'` + `version: product.version` -- purana version naye ko overwrite nahi kar sakta (ES 409, indexer ignore karta hai) |
| **Delete** | Support nahi | Tombstone + merge. `status = 'deleted'` -> outbox `op: 'delete'` -> Kafka -> indexer `delete` |
| **k > matched docs** | Heap mein jitne hain utne, `drain()` theek | `size` max 100, `page` max 50 (validation) |
| **`k = 0`** | `push` guard karta hai, `drain()` -> `[]` | `size >= 1` validation |
| **Score tie** | `docId asc` tie-breaker -- deterministic | `sort: ["_score", { "productId": "asc" }]` -- warna `search_after` pagination tootegi |
| **Unicode / Hindi query** | `[^a-z0-9]` sab kuch kha jaayega -- **bug** | `standard` tokenizer Unicode-aware hai; Hindi ke liye alag analyzer / `icu_tokenizer` |
| **Concurrency** | Single process, synchronous -- safe | ES: segments immutable, refresh cycle. Indexer: Kafka partition key `productId` -> ek product ke updates **ek hi partition, ordered** |
| **Index memory mein nahi samaata** | Crash | Shards (6 primary, ~22 GB each), 6 data nodes, 64 GB RAM / 31 GB heap (32 se upar kabhi nahi -- compressed oops) |

### Step 15 -- Unit test sketches (interviewer bole "how would you test this?")

```ts
// tests/analyzer.test.ts
describe('tokenize', () => {
  it('lowercases, splits and drops stop words', () => {
    expect(tokenize('Case FOR the iPhone-15')).toEqual(['case', 'iphone', '15']);
  });
  it('stems plurals consistently both ways', () => {
    expect(tokenize('cases')).toEqual(tokenize('case'));      // index-time == query-time
    expect(tokenize('mobiles')).toEqual(['mobile']);
    expect(tokenize('batteries')).toEqual(['battery']);
  });
  it('does not break -ss words', () => {
    expect(stem('wireless')).toBe('wireless');
    expect(stem('glasses')).toBe('glass');
  });
  it('handles empty and punctuation-only input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('!!! ... ???')).toEqual([]);
  });
});

// tests/intersect.test.ts   (ye 8 cases actually chalaakar pass kiye gaye)
const P = (...ids: number[]) => ids.map((docId) => ({ docId, tf: 1 }));
describe('intersect', () => {
  it.each([
    [[P(1,2,3,4,5,6,7,8,9), P(2,4,6,8), P(4,8,12)], [4, 8]],
    [[P(1,3,5), P(2,4,6)],                          []],          // disjoint
    [[P(1,2,3)],                                    [1, 2, 3]],   // single list
    [[P(1,2,3), []],                                []],          // ek term missing
    [[P(5), P(1,2,3,4,5)],                          [5]],         // chhoti list drive kare
    [[P(1,2,3,4,5), P(5)],                          [5]],         // order matter na kare
    [[P(0,1,2), P(0,1,2), P(0,1,2)],                [0, 1, 2]],   // identical
    [[P(1,9), P(2,9), P(3,9)],                      [9]],         // sirf last common
  ])('intersects %#', (lists, expected) => expect(intersect(lists)).toEqual(expected));
});

// tests/bm25.test.ts  -- golden numbers, taaki refactor ranking silently na tode
describe('BM25 scoring', () => {
  const index = buildIndexWith5Products();
  it('ranks higher tf above lower tf for same term', () => {
    const hits = search(index, 'case', 10);
    expect(hits.map((h) => h.productId)).toEqual(['P3', 'P2']);
    expect(hits[0].score).toBeCloseTo(1.3567, 3);
  });
  it('saturates tf (doubling tf must NOT double score)', () => {
    const doubled = index.bm25('case', 6, 2);
    const single  = index.bm25('case', 3, 2);
    expect(doubled).toBeLessThan(2 * single);
  });
  it('penalises longer documents (b = 0.75)', () => {
    const hits = search(index, 'iphone', 10);
    expect(hits[0].productId).toBe('P3');     // dl=13 beats dl=15 at same tf
  });
  it('gives rare terms higher idf', () => {
    expect(index.idf('samsung')).toBeGreaterThan(index.idf('iphone'));
  });
  it('AND semantics: term missing means doc excluded', () => {
    expect(search(index, 'iphone case', 10).map((h) => h.productId)).not.toContain('P1');
  });
});

// tests/topk.test.ts
it('returns exactly k best hits and is deterministic on ties', () => {
  const t = new TopK(3);
  [{ docId: 5, score: 1 }, { docId: 2, score: 9 }, { docId: 7, score: 9 }, { docId: 1, score: 3 }].forEach((h) => t.push(h));
  expect(t.drain()).toEqual([{ docId: 2, score: 9 }, { docId: 7, score: 9 }, { docId: 1, score: 3 }]);
});

// tests/query-builder.test.ts  (production side)
it('puts non-scoring clauses in filter context, never in must', () => {
  const q = buildSearchQuery({ q: 'iphone case', page: 1, size: 24, sort: 'relevance',
    filters: { brand: ['Apple'], priceMin: 500, priceMax: 2000, inStockOnly: true } }) as any;
  const bool = q.query.function_score.query.bool;
  expect(bool.must).toHaveLength(1);
  expect(bool.filter).toHaveLength(3);
  expect(JSON.stringify(bool.must)).not.toContain('brand');   // brand kabhi score na kare
});
it('always appends a deterministic tie-breaker to sort', () => {
  for (const s of ['relevance', 'price_asc', 'newest', 'rating'] as const) {
    const q = buildSearchQuery({ q: 'x', page: 1, size: 24, sort: s, filters: {} }) as any;
    expect(q.sort[q.sort.length - 1]).toEqual({ productId: 'asc' });
  }
});
```

**Code Explanation:**

- **Analyzer tests sabse pehle** -- kyunki 80% "zero results" bugs analyzer mismatch se aate hain. `expect(tokenize('cases')).toEqual(tokenize('case'))` ye ek assertion hi poori class of bugs pakad leti hai.
- `intersect` tests **table-driven** (`it.each`) hain -- 8 shapes, ek jagah. Disjoint, khaali, single, size-asymmetric dono directions, identical, aur "sirf last element common" (jo leapfrog logic ko sabse zyada stress karta hai).
- **BM25 tests "golden numbers" hain** -- `toBeCloseTo(1.3567, 3)`. Ranking code refactor karne par agar number badla toh test turant batayega. Relevance code mein ye zaruri hai kyunki ranking bug **crash nahi karta**, bas chupke se business gira deta hai.
- `saturates tf` test formula ka **property** test karta hai, exact value nahi -- `k1` tune karne par bhi ye pass rehna chahiye.
- `query-builder` test mein `expect(JSON.stringify(bool.must)).not.toContain('brand')` -- ye hamara **sabse important production invariant** hai (filter vs query context) as a test. Koi junior galti se `brand` ko `must` mein daalega toh CI pakad legi.
- Tie-breaker test har sort mode par loop karta hai -- kyunki `search_after` pagination ka silent breakage sabse mehenga bug hai.
- Jo yahan **nahi** hai aur production mein chahiye: **relevance regression suite** -- 200 real queries ka ek CSV with expected top-5 (human judged), har ranking change par `NDCG@10` compare karo. Ye unit test nahi, ye **quality gate** hai.

---

## PART 27 -- 30-Second Answer

> "At a high level, main Elasticsearch use karunga -- ek **inverted index** jo text ko terms mein todta hai aur **BM25** se rank karta hai, kyunki SQL `LIKE '%x%'` na index use kar sakta hai na uske paas relevance ka koi concept hai. Source of truth **Postgres** rahega; ES ek **derived index** hai jise **outbox + Kafka + indexer workers** bulk API se feed karte hain -- dual write kabhi nahi, warna permanent divergence. 50M products ka ~130 GB index **6 primary shards x 1 replica** par, 6 data nodes plus 3 masters. Search 20M/day yaani ~231 QPS average, peak ~1,000; autocomplete uska **4x** hai isliye uska alag lightweight edge n-gram index aur Redis prefix cache hai. Head queries traffic ka 30% hain -- Redis mein 60 second TTL. Query mein scoring cheezein `must` mein aur brand/price/stock `filter` mein, kyunki filter bitsets cacheable hain. Aur ES down ho toh hum **degrade karte hain, die nahi** -- stale cache, phir Postgres `pg_trgm` top 20 with `degraded: true`, phir 503."

(Bolne mein ~45 seconds. Ek data structure, ek scoring function, teen components, teen numbers, ek failure decision -- bas.)

---

## PART 28 -- 5-Minute Interview Answer (natural Hinglish)

> Ise ratna nahi hai. Har minute ka **goal** yaad rakho; words apne aap aayenge. Beech beech mein check-in karo: "Is this direction okay?"

### **Minute 1 -- requirements clarify**

"Main pehle requirements clarify karunga. Ye **product search** hai ek marketplace ke liye -- Flipkart ya Amazon jaisa. Catalog kitna bada hai? ... **50 million products**, 20,000 sellers. Theek hai.

Functional side par mere liye paanch cheezein hain: full-text search **typo tolerance aur synonyms ke saath** -- `iphon` likhne par `iphone` mile, `mobile` likhne par `smartphone` bhi; **filters aur facet counts** -- 'Samsung (1,204)' wali counts, kyunki e-commerce mein ye search se kam important nahi; **sorting** -- relevance default, plus price, newest, rating; **autocomplete** har keystroke par; aur **near-real-time indexing** -- seller product update kare toh 30 second mein search mein dikhe.

Ek clarification zaroor poochunga: **relevance ke upar business ranking chahiye?** ... Haan -- in-stock upar, popular products upar, aur sponsored slots clearly marked. Ye important hai kyunki ye pure text relevance nahi hai.

Non-functional mein teen: **latency** -- search p95 **200 ms**, p99 400, autocomplete p99 **100 ms**, kyunki search interactive hai, 1 second matlab user bounce. **Availability 99.95%** -- search down matlab poore site se koi aage nahi badhega, revenue zero. Aur **consistency eventual chalegi** -- 30 second stale theek hai. Lekin main ek exception rakhunga: **stock aur price** galat dikhana business problem hai, uska alag treatment hoga.

Aur ek honest baat pehle hi bol deta hoon: **agar catalog chhota hai toh main Elasticsearch use hi nahi karunga.** 100K products par Postgres `tsvector` plus GIN index plus `pg_trgm` bilkul kaafi hai, aur ek poora cluster operate karna nahi padta. Main ES tab lunga jab documents 5-10 million se upar hon, facet aggregations chahiye hon, relevance tuning chahiye ho, ya search DB ko hurt kar raha ho. Yahan 50M hai aur charon condition true hain, isliye ES justified hai."

### **Minute 2 -- scale estimate aur data structure**

"Numbers nikaal leta hoon. 50 million products, har searchable doc roughly **2 KB** -- title, description snippet, brand, category path, attributes, price, stock, ratings. Toh raw **100 GB**. ES index source ka ~1.3x hota hai kyunki usme inverted index, doc values aur stored `_source` teeno hain -- yaani **~130 GB primary data**.

Shard sizing: healthy shard 25-40 GB hota hai, toh **6 primary shards, har ek ~22 GB, plus 1 replica** -- total 12 shards, ~260 GB cluster data. **6 data nodes**, do-do shard, 64 GB RAM, **31 GB JVM heap** -- heap 32 GB se upar kabhi nahi le jaunga kyunki wahan compressed object pointers band ho jaate hain aur effectively memory kam ho jaati hai. Plus **3 dedicated master nodes** quorum ke liye, split-brain se bachne ke liye.

Traffic: **20 million searches per day** -- 20 million by 86,400 = **~231 QPS average**, peak 4x = **~1,000 QPS**, sale day 20x = **~4,600**.

Ab ek insight jo main zaroor bolunga: **autocomplete traffic search se 4x zyada hai.** User average 12 characters type karta hai, 150 ms debounce ke baad roughly 4 requests per search -- yaani **80 million per day, ~925 QPS average, ~4,000 peak**. Agar main autocomplete ko main index par maar dunga toh cluster mar jaayega. Isliye uska **alag chhota index** hoga jo poora RAM mein fit hota hai, plus Redis cache.

Ab core question: **ye kaam karta kaise hai?** Postgres ka `ILIKE '%iphone case%'` do wajah se fail hai. Ek, leading wildcard ki wajah se koi B-tree index use hi nahi ho sakta -- 50M rows ka full scan, 8-12 second. Do, aur ye zyada important hai: `LIKE` **boolean** hai, match ya no match; usme 'kaun sa result zyada relevant hai' ka concept hi nahi.

Search engine dono solve karta hai: **inverted index** speed ke liye -- `term -> [docIds]`, toh 'case' par seedha 50,000 docIds mil jaate hain, 50M scan nahi hota. Aur **BM25** relevance ke liye -- ye TF-IDF ka improved version hai jisme term frequency **saturate** hoti hai, toh title mein 'case case case' likh ke koi seller ranking nahi kharid sakta, aur score document **length se normalize** hota hai, toh chhote title mein match ek strong signal maana jaata hai."

### **Minute 3 -- architecture aur request flow**

"Initially main simple architecture rakhunga. Browser mein **150 ms debounce** -- ye pehla aur sabse sasta optimization hai, har keystroke request nahi.

Flow: browser se `GET /api/v1/search` load balancer par, phir **N stateless Node.js instances**. Har instance par pehle **per-IP rate limit** -- ye zaruri hai kyunki competitors price scraping karte hain, aur autocomplete ki limit alag aur zyada hogi. Phir **Redis cache check** -- key `q:` plus sha1 of normalized query plus filters plus sort plus page, TTL **60 second**, sirf page 1, koi personalization nahi. Kyun ye kaam karta hai: **top 1,000 queries traffic ka ~30% hain** -- Zipf distribution. Yaani teen mein se ek request ES tak pahunchti hi nahi.

Cache miss par **QueryBuilder** chalta hai: query parse, analyze, aur ES DSL banao. Yahan ek design rule main zaroor bolunga: `must` aur `should` **score** karte hain -- mehenge, cacheable nahi. `filter` sirf yes/no batata hai aur ES uska result **bitset mein cache** kar leta hai. Isliye brand, price range, in-stock -- ye sab hamesha `filter` mein jaate hain, kabhi `must` mein nahi.

Text relevance ke upar main `function_score` lagata hoon -- `popularityScore` par `log1p` with weight 0.3, aur in-stock ka 1.2 boost -- aur `boost_mode: multiply`. **Text relevance ko multiply karo, replace mat karo** -- warna popular but irrelevant product har query jeet jaayega.

Facet counts usi query pass mein `aggs` se aate hain, alag round trip nahi. Latency budget: Node overhead ~10 ms, network 5, ES query 60-120 ms -- 6 shards parallel, **sabse slow shard hi latency decide karta hai** -- aggregations +20-40, serialization 10. 200 ms p95 mein fit.

Autocomplete ka raasta alag hai: `suggestions_v2` index, **edge n-gram** analyzer -- index time par `iphone` ko `i, ip, iph, ipho, iphon, iphone` mein tod diya, toh query time par bas ek simple term match hai. Plus Redis mein top 10,000 popular prefixes precomputed, TTL 10 minute. 4,000 QPS ka bada hissa ES tak jaata hi nahi."

### **Minute 4 -- indexing pipeline, consistency aur scaling**

"Ab sabse important design decision: **Elasticsearch source of truth nahi hai.** **Postgres source of truth hai, ES ek derived index hai.** Ye main bar-bar bolunga kyunki isse baaki sab decisions nikalte hain -- ES kabhi bhi poora dobara banaya ja sakta hai, aur data loss ka matlab downtime hai, permanent loss nahi.

Toh data wahan pahunchta kaise hai? **Dual write nahi** -- yaani app seedha Postgres aur ES dono ko nahi likhega. Kyun? Kyunki dono ek atomic transaction mein nahi hain. Postgres commit ho gaya aur ES call fail ho gayi, ya process beech mein mar gaya -- toh **permanent divergence**, aur kisi ko pata bhi nahi chalega.

Iski jagah **outbox pattern**: product update aur `product_outbox` row **ek hi Postgres transaction** mein likhe jaate hain -- atomic, ya dono ya koi nahi. Phir ek outbox poller ya Debezium CDC usko padhta hai aur **Kafka `product-changes`** par daalta hai, **12 partitions, key = productId** -- key isliye taaki ek product ke saare updates **ek hi partition** mein jaayein aur unka order bana rahe. Phir `product-indexer` consumer group **bulk API** se ES ko likhta hai -- batch 500 docs ya 5 MB ya 1 second, jo pehle aa jaaye.

Ordering ke liye ek aur safety: bulk index mein `version_type: external` aur `version: product.version`. Agar koi purana message late aa gaya toh ES **409** dega aur indexer usse chhod dega -- purana data naye ko overwrite kar hi nahi sakta. Ye 'eventual consistency mein ordering' ka concrete jawab hai.

Updates ka volume: **5 million per day, ~58 per second average, flash sale par ~500 per second** -- zyadatar price aur stock changes. Aur yahan ek trap hai jo main pehle hi bol dunga: ES mein har update matlab **delete plus re-insert**, kyunki segments immutable hain. Toh 'har stock quantity change par doc reindex karo' **galat** approach hai -- segment churn se merge load phat jaayega. Mera decision: **`inStock` boolean doc mein rakho** filter ke liye, aur exact quantity product page par DB ya Redis se serve karo. Price change indexed hota hai kyunki woh search results mein dikhta hai, par **30 second ki batch window mein debounced**.

Aur jab analyzer ya mapping badalna ho -- **analyzer change matlab reindex**, kyunki purane docs purane tokens ke saath pade hain. Uske liye **alias swap**: naya `products_v3` banao, `_reindex` plus live Kafka tail, doc count aur sample queries verify karo, phir **atomic `_aliases` swap**, aur purana index 24 ghante rakho rollback ke liye. Synonyms search time par lagte hain isliye unke liye reindex nahi chahiye -- sirf `_reload_search_analyzers`.

**At scale yahan bottleneck ES cluster ka query throughput ho sakta hai**, khaas taur par sale day ke 4,600 QPS par. Ladder ye hai: pehle **replicas badhao** -- replicas read traffic serve karte hain, toh read scaling ka sabse sasta lever wahi hai. Phir **cache hit ratio** improve karo. Phir **hot vs cold data** alag karo. Aur autocomplete already alag index par hai isliye woh main cluster ko touch nahi karta. Deep pagination ke liye page 50 tak `from/size`, uske aage **`search_after`** with `productId` tie-breaker -- kyunki `from: 12000` par har shard 12,024 docs coordinate node par bhejta hai aur memory blow ho jaati hai."

### **Minute 5 -- trade-offs aur failure**

"However, ES gir bhi sakta hai -- ya poora cluster red, ya kuch shards unassigned. Mera principle yahan hai: **degrade, don't die.** Teen step ki ladder: pehle **Redis se stale results** -- head queries ke liye ye kaafi achha hai. Woh bhi na ho toh **Postgres `pg_trgm` ya FTS se degraded search**, top 20 results, **bina facets**, aur response mein `degraded: true` field plus UI par ek honest banner. Aur agar woh bhi fail ho tab **503 SEARCH_UNAVAILABLE**. Har degraded request `search_degraded_total` metric badhati hai jo alert karta hai.

Client side par bhi defense: ES client mein `requestTimeout: 1000`, per-request `timeout: '800ms'`, `maxRetries: 2`, aur `allow_partial_search_results: true` -- matlab ek shard slow hai toh baaki 5 ke results de do, par response mein `_shards.failed` check karke metric badhao, taaki hum chup-chaap adhoore results serve na karte rahein.

Monitoring mein sabse important metric jo log log bhool jaate hain: **`indexer_lag_seconds`** -- product ka `updatedAt` se lekar uske searchable hone tak ka time. Ye 30 second ka SLA directly measure karta hai. Uske saath `search_zero_results_total`, `search_cache_hit_ratio`, `es_jvm_heap_used_percent` aur `es_cluster_status`.

**One trade-off here is** eventual consistency versus complexity. Outbox plus Kafka plus workers dual-write se kaafi zyada moving parts hain -- lekin dual write mein failure **silent aur permanent** hoti hai, jabki yahan failure **visible** hoti hai: Kafka lag badhta hai, metric alert karta hai, aur workers catch up kar lete hain. Main visible lag ko silent divergence par hamesha choose karunga.

**Doosra trade-off** relevance versus cacheability: personalization results ko behtar karti hai lekin **query cache ko maar deti hai** kyunki har user ka result alag ho jaata hai. Isliye v1 mein personalization nahi hai; v3 mein main usko API layer par **sirf top 100 results ke re-ranking** tak limit karunga, taaki base query cacheable rahe.

**Teesra** -- `track_total_hits: 10000`. Exact total count nikalna mehenga hai, aur '10,000 plus results' dikhana user ke liye bilkul kaafi hai. Accuracy ko latency ke liye jaan boojh ke chhoda.

Aur jo maine v1 se **jaan boojh ke bahar rakha**: Learning-to-Rank, vector/semantic search with kNN, personalization, multi-region active-active. Semantic search ek strong modern addition hai -- typically hybrid, BM25 plus embeddings -- par woh v1 ka problem nahi.

Summary: Postgres source of truth, ES derived index, outbox plus Kafka plus bulk indexer, 6 shards plus replica, Redis cache head queries ke liye, autocomplete ka alag index kyunki uska traffic 4x hai, aur failure par degrade karo, die mat. Kisi part mein deep dive karein?"

---

## PART 29 -- Whiteboard Drawing Order

**Rule:** diagram ek saath mat banao. Har box tab draw karo jab uska **reason** bol rahe ho.

**Search system ka ek special rule:** board par **do flows alag-alag dikhane hain** -- **query path** (left to right, top half) aur **indexing path** (bottom half, ulti direction mein upar ES ki taraf). Yahi ek diagram detail interviewer ko sabse zyada impress karti hai, kyunki isse turant pata chalta hai ki tumne samajh liya hai ki **ES ek derived index hai, source of truth nahi.** Jab tumhare dono flows alag dikhte hain, agla sawaal apne aap "consistency kaise?" ban jaata hai -- aur uska jawab tumhare paas already ready hai.

### Step 1 -- Client (with debounce)

```
[Browser search box]   debounce 150 ms
   GET /api/v1/suggest?q=iph        (har keystroke ke baad)
   GET /api/v1/search?q=iphone+case&brand=Apple&page=1
```

**Ab interviewer ko kya bolna hai?**

> "Do alag endpoints hain aur dono ka traffic profile alag hai. Autocomplete har keystroke par chalta hai -- isliye pehla optimization client par hi hai, **150 ms debounce**. Uske bawajood user 12 characters type karta hai toh ~4 requests jaati hain, matlab **autocomplete traffic search se 4x hai** -- 80 million versus 20 million per day."

**Ye box ye sawaal invite karta hai:** "Autocomplete p99 100 ms mein kaise karoge?" -- jiska jawab Step 4 aur Step 5 mein ready hai.

### Step 2 -- Load Balancer / API Gateway

```
[Browser]
    |
    v
[LB / API Gateway]   TLS, health checks
```

**Ab interviewer ko kya bolna hai?**

> "Standard. Yahan main sirf TLS aur coarse routing rakhta hoon. Plan-aware ya query-aware rate limiting yahan nahi, kyunki uske liye application ki knowledge chahiye."

**Abhi mat draw karo:** CDN. Search results **personalized aur volatile** hain -- CDN unpar kaam nahi karta. Sirf static category pages CDN-able hain, aur woh alag feature hai. Agar interviewer poochhe "CDN kyun nahi?" toh yahi jawab hai, aur "kyun nahi" bolna bhi ek strong signal hai.

### Step 3 -- Search API (N stateless Node.js)

```
[LB]
  |
  +----------+----------+
  v          v          v
[Search API][Search API][Search API]      stateless
  rate limit (per IP)
     -> cache lookup
        -> QueryBuilder (parse -> analyze -> ES DSL)
           -> response mapper (hits + facets)
```

**Ab interviewer ko kya bolna hai?**

> "Stateless Node instances. Order maayne rakhta hai: pehle **per-IP rate limit** -- competitors price scraping karte hain, aur autocomplete ki limit alag aur zyada hai; phir **cache lookup**, taaki cache hit ES tak jaaye hi nahi; phir **QueryBuilder** jo request ko ES DSL mein badalta hai. Validation bhi yahin: `q` max 100 characters, kyunki lambi query fuzzy expansion mein bahut mehengi hai."

**Ye box ye sawaal invite karta hai:** "QueryBuilder mein exactly kya banta hai?" -- tab `must` vs `filter` wali baat karo, jo is design ka sabse tight technical point hai.

### Step 4 -- Redis cache

```
[Search API] <---> [Redis]
                    q:<sha1(normalizedQuery+filters+sort+page)>   TTL 60 s   (page 1 only)
                    sug:<prefix>                                  TTL 600 s
                    rl:search:<ip>                                token bucket
```

**Ab interviewer ko kya bolna hai?**

> "Cache kaam karta hai kyunki queries **Zipf distributed** hain -- top 1,000 queries traffic ka ~30% hain. 60 second TTL, sirf page 1, aur **koi personalization nahi** -- warna cache key har user ke liye alag ho jaayegi aur hit ratio zero. Prefix cache alag hai, 10 minute TTL, kyunki popular prefixes bahut dheere badalte hain."

**Ek trick:** Redis box ke paas hi chhota likh do `ES down? -> stale cache -> pg_trgm -> 503`. Failure story ka hook board par ready rahega aur jab interviewer "what if ES goes down" poochega, tum sirf ungli uthake bologe.

### Step 5 -- Elasticsearch cluster (shards as boxes)

Shards ko **boxes** mein draw karo, sirf "ES cluster" likh ke mat chhodo. Ye ek chhoti si baat hai jo bahut farq karti hai.

```
[Search API]
    |
    v
+------------------------------------------------------------------+
|  Elasticsearch cluster                                            |
|                                                                   |
|  index products_v3   (alias: products)                            |
|   +----+ +----+ +----+ +----+ +----+ +----+                       |
|   | P0 | | P1 | | P2 | | P3 | | P4 | | P5 |   6 primaries ~22 GB  |
|   +----+ +----+ +----+ +----+ +----+ +----+                       |
|   +----+ +----+ +----+ +----+ +----+ +----+                       |
|   | R0 | | R1 | | R2 | | R3 | | R4 | | R5 |   1 replica each      |
|   +----+ +----+ +----+ +----+ +----+ +----+                       |
|   = 12 shards, ~260 GB, on 6 data nodes + 3 master nodes          |
|                                                                   |
|  index suggestions_v2 (alias: suggestions)  small, edge n-gram,   |
|                                             fits in RAM           |
+------------------------------------------------------------------+
```

**Ab interviewer ko kya bolna hai?**

> "130 GB primary data, healthy shard 25-40 GB, isliye **6 primaries ~22 GB each plus 1 replica** = 12 shards, ~260 GB. 6 data nodes, 64 GB RAM, **31 GB heap** -- 32 se upar compressed oops chale jaate hain. 3 dedicated masters quorum ke liye.
>
> Query **saare 6 shards par parallel** jaati hai aur coordinate node merge karta hai -- isliye **slowest shard hi latency decide karta hai**, average nahi.
>
> Aur suggestions ek **alag chhota index** hai, kyunki uska traffic 4x hai aur uska pattern alag hai -- prefix match, no facets. Alag index matlab autocomplete ka load main cluster ko touch nahi karta."

**Ye box ye sawaal invite karta hai:** "6 shards hi kyun, 60 kyun nahi?" -- jawab: har shard ek Lucene index hai, uska apna overhead aur file handles hain; over-sharding se har query 60 requests ban jaati hai aur coordinate node merge mein mar jaata hai. Shard count **badalna reindex maangta hai**, isliye ye upfront decision hai.

#### Board -- Stage 1 (Step 5 ke baad, sirf query path)

```
   [Browser]  debounce 150 ms
       |
       v
   [LB / API Gateway]
       |
   +---+-------+-------+
   v           v       v
 [Search API][API]  [API]     stateless
   rate limit -> cache -> QueryBuilder
       |
       +-------> [Redis]  q:<sha1> 60s | sug:<prefix> 600s
       |                  (ES down? -> stale -> pg_trgm -> 503)
       v
 [ES cluster]  products_v3 (alias products)
   [P0][P1][P2][P3][P4][P5] + 1 replica each = 12 shards
   suggestions_v2 (edge n-gram, in RAM)
```

Ab ruk jao aur bolo: "Ye **query path** hai. Ab main **indexing path** banata hoon -- aur ye jaan boojh ke ek alag flow hai."

### Step 6 -- Postgres (source of truth)

**Ise board ke neeche draw karo, ES ke *neeche*, aur teer upar ki taraf.**

```
                        [ES cluster]
                             ^
                             |
                             |
[Catalog Service] --write--> [Postgres  products]   SOURCE OF TRUTH
                                price_paise BIGINT, stock_qty, version BIGINT
```

**Ab interviewer ko kya bolna hai?**

> "Ye is design ka sabse important statement hai: **Postgres source of truth hai, Elasticsearch ek derived index hai.** ES ko main kabhi bhi poora dobara bana sakta hoon -- uska data loss matlab downtime hai, permanent loss nahi. Isliye maine ise board par ES ke **neeche** rakha hai, aur teer **upar** ki taraf jaa raha hai."

**Ye box ye sawaal invite karta hai:** "Toh data ES tak pahunchta kaise hai?" -- yahi wo sawaal hai jiska tum intezaar kar rahe the.

### Step 7 -- Outbox

```
[Catalog Service]
      |
      |  ONE Postgres transaction
      v
 +-----------------------------------------+
 | UPDATE products SET ... , version = v+1 |
 | INSERT INTO product_outbox(...)         |     <-- atomic, dono ya koi nahi
 +-----------------------------------------+
      |
      v  outbox poller / Debezium CDC
```

**Ab interviewer ko kya bolna hai?**

> "Sabse tempting galat approach yahan **dual write** hai -- app seedha Postgres aur ES dono ko likhe. Woh isliye galat hai ki dono ek atomic unit nahi hain: Postgres commit ho gaya aur ES call fail ho gayi, ya process beech mein mar gaya -- toh **permanent divergence**, aur kisi ko pata bhi nahi chalta.
>
> Outbox pattern ye fix karta hai: product row aur outbox row **ek hi transaction** mein likhte hain, matlab ya dono hote hain ya koi nahi. Uske baad outbox ko relay karna ek **retryable, at-least-once** kaam hai -- aur at-least-once safe hai kyunki indexing **idempotent** hai."

### Step 8 -- Kafka

```
 [outbox poller] --> [Kafka  product-changes]   12 partitions, key = productId
                     [Kafka  search-queries]    ~30 GB/day, 7 day retention
```

**Ab interviewer ko kya bolna hai?**

> "Kafka yahan **buffer aur ordering** dono deta hai. **key = productId** isliye ki ek product ke saare updates **ek hi partition** mein jaayein aur unka relative order bana rahe. 12 partitions matlab 12 tak parallel consumers.
>
> Buffer ka fayda flash sale par dikhta hai: updates 58 per second se **500 per second** par chale jaate hain. Kafka woh spike absorb kar leta hai, aur ES ko uski apni speed par likha jaata hai. Bina Kafka ke woh spike seedha cluster par girta."

**Ye box ye sawaal invite karta hai:** "Messages out of order aa gaye toh?" -- jawab Step 9 mein.

### Step 9 -- Indexer workers

```
[Kafka product-changes] --> [product-indexer workers]  (consumer group)
                              bulk API: 500 docs / 5 MB / 1 s
                              version_type: external, version: product.version
                              |
                              v
                          [ES cluster]
```

**Ab interviewer ko kya bolna hai?**

> "Workers ek consumer group hain, `product-indexer`. Ye **bulk API** use karte hain -- 500 docs ya 5 MB ya 1 second, jo pehle aa jaaye -- kyunki per-doc indexing 5 million updates per day par bekaar hai.
>
> Ordering ke liye `version_type: external` plus product ka `version`. Agar koi purana message late aa gaya toh ES **409** deta hai aur indexer usse **ignore** kar deta hai. Isliye purana data naye doc ko overwrite kar hi nahi sakta -- ye 'eventual consistency mein ordering' ka concrete jawab hai. Aur yahi cheez retries ko idempotent banati hai.
>
> Ek aur trap jo main yahin bol dunga: ES mein har update matlab **delete plus re-insert**, segments immutable hain. Isliye stock quantity ke har change par reindex karna galat hai -- doc mein sirf `inStock` boolean hai, exact quantity product page par DB/Redis se aati hai."

#### Board -- Stage 2 (Step 9 ke baad, dono flows)

```
  QUERY PATH (top, left to right)
  ================================
   [Browser] --> [LB] --> [Search API xN] --> [ES cluster]
                            |   ^                [P0..P5] + replicas
                            v   |                suggestions_v2
                          [Redis]
                        q: 60s | sug: 600s | rl:

  INDEXING PATH (bottom, upward)
  ================================
   [Catalog Service]
        |  one transaction
        v
   [Postgres products + product_outbox]   SOURCE OF TRUTH
        |  outbox poller / Debezium CDC
        v
   [Kafka product-changes]  12 partitions, key=productId
        |
        v
   [product-indexer workers]  bulk 500/5MB/1s, version_type=external
        |
        +------------------> [ES cluster]     (upar wale hi ES box mein)
```

Bolo: "Dhyan dijiye -- **query path aur indexing path kabhi ek doosre ko touch nahi karte, sirf ES par milte hain.** Isliye indexing slow ho jaaye toh search down nahi hoti; bas results thode stale ho jaate hain, aur woh `indexer_lag_seconds` metric par saaf dikhta hai."

### Step 10 -- Analytics / query-log loop

```
[Search API] --async--> [Kafka search-queries] --> [S3 / warehouse]
                                                      |
                                                      v
                                          nightly jobs:
                                          - query_popularity (searches_30d, ctr)
                                          - zero-result report
                                          - synonym candidates
                                                      |
                     popularityScore -----------------+
                     suggestions_v2  <----------------+
```

**Ab interviewer ko kya bolna hai?**

> "Ye ek **feedback loop** hai, aur yahi search ko time ke saath behtar banati hai. Har query log hoti hai -- query text, results count, clicked position -- **async**, request path par kabhi nahi. Volume ~30 GB per day, Kafka mein 7 din retention.
>
> Isse teen cheezein nikalti hain: **zero-result rate** (abhi baseline ~12%, target 5% se neeche) jo batati hai kaun se synonyms missing hain; **CTR per position** jo ranking quality batati hai; aur **`query_popularity`** table jo `popularityScore` ke through wapas index mein jaati hai aur `suggestions_v2` ko feed karti hai. Ye job **nightly** hai, real-time nahi -- popularity itni jaldi nahi badalti ki real-time ki complexity worth ho."

### Final board

```
 ============================ QUERY PATH ============================
  [Browser search box]  debounce 150 ms
        |   /search              /suggest
        v
  [LB / API Gateway]
        |
   +----+-----+-----+
   v          v     v
 [Search API][API][API]   stateless
   rate limit -> cache -> QueryBuilder -> response mapper
        |                                     |
        +--> [Redis] q:<sha1> 60s             |  aggs = facet counts
        |           sug:<prefix> 600s         |  track_total_hits: 10000
        |           rl:search:<ip>            |  page<=50 from/size, aage search_after
        |                                     v
        |                    +--------------------------------------+
        +------------------> | ES: products_v3 (alias products)     |
                             |  [P0][P1][P2][P3][P4][P5] +1 replica |
                             |  = 12 shards, 6 data + 3 master nodes|
                             |  suggestions_v2 (edge n-gram, RAM)   |
                             +--------------------------------------+
   degrade ladder:                              ^
   stale cache -> pg_trgm top20 (degraded:true) |
              -> 503 SEARCH_UNAVAILABLE         |
                                                | bulk 500/5MB/1s
 ========================== INDEXING PATH =======|===================
                                   [product-indexer workers]
                                     version_type: external
                                                ^
                                                | consumer group
                                   [Kafka product-changes]
                                     12 partitions, key=productId
                                                ^
                                                | outbox poller / Debezium
                             [Postgres: products + product_outbox]
                                    SOURCE OF TRUTH
                                                ^
                                                | one transaction
                                     [Catalog Service]  seller updates

 ========================== ANALYTICS LOOP ==========================
  [Search API] --async--> [Kafka search-queries] --> [S3 / warehouse]
        ^                                                  |
        |  popularityScore (nightly) + suggestions_v2       |
        +---------------------------------------------------+
```

### "Only draw if asked" -- board ko readable rakho

Ye sab **jaante ho par draw mat karo** jab tak interviewer na poochhe. Ek bheed-bhaad wala board tumhari understanding nahi, tumhari prioritization ki kami dikhata hai.

| Cheez | Kab draw karo | Ek line jo tum bolo |
|---|---|---|
| `suggestions_v2` ka apna indexing pipeline | "Suggestions kaise banti hain?" | "Nightly job `query_popularity` se bharta hai, alag chhota reindex" |
| Learning-to-Rank plugin | "Ranking aur behtar kaise?" | "v3 -- feature logging, offline model, top 100 par re-rank" |
| Vector / semantic search (embeddings + kNN) | "Semantic search?" | "v3 -- hybrid: BM25 plus kNN, RRF se merge. Modern addition, par v1 ka problem nahi" |
| Personalization | "Per user results?" | "v1 mein nahi -- ye query cache ko maar deti hai. v3 mein sirf top 100 ka API-layer re-rank" |
| Multi-region active-active | "Global users?" | "v3 -- per-region ES cluster, ek hi Kafka se feed. Index replication ek alag problem hai" |
| Sponsored / ads service | "Monetization?" | "Alag service, top 2 slots par **merge**, organic ranking ke andar mix nahi -- auditability aur user trust" |
| Alias swap / reindex ka poora flow | "Analyzer badalna ho toh?" | "products_v4 banao, reindex plus live tail, verify, atomic alias swap, purana 24 h rakho" |
| Prometheus / Grafana box | "Monitoring?" | "`indexer_lag_seconds` sabse important -- SLA seedha measure karta hai" |

### Kya **bilkul** draw nahi karna

- **CDN** -- search results personalized aur volatile hain. Sirf static category pages CDN-able, aur woh alag feature hai.
- **ES ko source of truth banana** -- ye seedha red flag hai.
- **App se ES par dual write** (Catalog Service se seedha ES ka teer) -- ye galat design hai, aur board par draw karne ke baad defend karna padega.
- **Har cheez ke liye ek microservice** -- Search API ek service hai, bas.

---

## PART 30 -- Final Cheat Sheet (5 minute revision)

### Problem

Marketplace ka **product search** (Flipkart / Amazon / Myntra style). **50M products, 20,000 sellers.** Search box par typing -> autocomplete suggestions -> Enter -> relevant products + facets (brand, price, rating, category, in-stock) + sort. Shuruaat `SELECT * FROM products WHERE name ILIKE '%iphone case%'` thi, jo 50,000 products tak chali aur 50M par **full table scan, 8-12 second, DB CPU 100%** -- aur phir bhi results kharab.

**Do alag problems hain:**

1. **Speed** -- `%term%` leading wildcard ki wajah se B-tree index use hi nahi kar sakta. Fix: **inverted index**.
2. **Relevance** -- `LIKE` boolean hai, "kaun zyada relevant hai" ka concept hi nahi. Fix: **scoring / BM25**.

### Requirements

| Type | Points |
|---|---|
| Functional | Full-text search with **typo tolerance** (`iphon` -> `iphone`), **stemming** (`mobiles` ~ `mobile`), **synonyms** (`mobile` = `smartphone`); filters (category, brand, price range, rating, in-stock, seller rating, discount); **facet counts** ("Samsung (1,204)"); sorting (relevance, price asc/desc, newest, rating, popularity); pagination (page 1-5 `from/size`, aage `search_after`); **autocomplete** top 10 per keystroke; near-real-time indexing **<= 30 s**; business ranking (in-stock, popularity, seller rating, sponsored); query analytics |
| NFR | Search **p95 < 200 ms, p99 < 400 ms**; autocomplete **p99 < 100 ms**; **availability 99.95%** with fallback path; **eventual consistency OK** (30 s) par stock/price special; 50M docs, **4x peak, 20x sale day** |
| Clarify first | Catalog size? Facets chahiye? Typo/synonyms? Indexing freshness SLA? Business boosts ya pure relevance? Personalization? Autocomplete alag hai? |

### Key numbers (exact, yaad rakho)

| Metric | Value | Isse kya decide hua |
|---|---|---|
| Catalog | **50M products**, ~2 KB/doc -> **~100 GB raw** | ES ki zarurat justified |
| ES index | source ka **1.3x** -> **~130 GB primary** | Shard sizing |
| Shards | 25-40 GB target -> **6 primary (~22 GB each) + 1 replica = 12 shards, ~260 GB** | Cluster size |
| Nodes | **6 data** (2 shards each, 64 GB RAM, **31 GB heap**) + **3 dedicated masters** | Heap 32 GB se upar kabhi nahi (compressed oops); masters quorum ke liye |
| Search traffic | **20M/day = 231 QPS avg**, peak 4x = **~1,000**, sale 20x = **~4,600** | Replica scaling |
| Autocomplete | 12 chars, 150 ms debounce, ~4 req/search -> **80M/day = ~925 QPS avg, ~4,000 peak** | **4x search se zyada** -> alag index + Redis |
| Head queries | top 1,000 = **~30% traffic** (Zipf) | Redis cache, **TTL 60 s**, page 1 only, no personalization |
| Updates | **5M/day = 58/sec**, flash sale **~500/sec**; 10 GB/day bulk | Kafka buffer; har stock change par reindex **nahi** |
| Latency budget (200 ms p95) | Node ~10 + network ~5 + ES 60-120 (6 shards parallel, **slowest decides**) + aggs 20-40 + serialize ~10 | Timeout 800 ms per request |
| Zero-result rate | target **< 5%**, baseline **~12%** | Typos + synonyms ka business case |
| Query logs | 20M + 80M x ~300 B = **~30 GB/day** Kafka, 7 day retention | S3/warehouse, nightly jobs |

### APIs

| API | Kya |
|---|---|
| `GET /api/v1/search?q=iphone+case&brand=Apple&priceMin=500&priceMax=2000&inStock=true&sort=relevance&page=1&size=24` | `200 { hits, total, totalIsLowerBound, facets, tookMs, searchAfter, degraded? }` |
| `GET /api/v1/suggest?q=iph&limit=10` | `200 { suggestions: [{ text, type: 'query'\|'product'\|'category' }] }` |
| `POST /api/v1/admin/reindex` | Reindex job start (admin only) |
| `POST /api/v1/admin/synonyms` | Synonyms add/update, phir `_reload_search_analyzers` |
| `GET /health`, `GET /ready` | `/ready` ES cluster status check karta hai |
| Validation | `q` max **100** chars, `size` max **100**, `page` max **50** (aage `searchAfter` mandatory), unknown filter -> `400` |
| Errors | `400 VALIDATION_ERROR`, `429 RATE_LIMITED`, `503 SEARCH_UNAVAILABLE` |

### HLD -- one-liner

```
Browser (debounce 150 ms) -> LB -> Search API (N stateless Node)
   |-- rate limit -> Redis cache (q: 60s, sug: 600s) -> QueryBuilder -> ES (products_v3 / suggestions_v2)
Postgres (SOURCE OF TRUTH) + product_outbox -> poller/Debezium -> Kafka product-changes (12p, key=productId)
   -> product-indexer workers -> bulk -> ES
Query logs -> Kafka search-queries -> S3/warehouse -> nightly popularity + synonyms -> back into index
```

**Ek line mein:** "Postgres source of truth, ES derived index, outbox+Kafka se feed, Redis head-query cache, autocomplete alag index."

### LLD folders

```
src/
  routes/        search.routes.ts, suggest.routes.ts, admin.routes.ts
  controllers/   search.controller.ts, suggest.controller.ts
  services/      search.service.ts, suggest.service.ts, indexer.service.ts, reindex.service.ts
  search/        query-builder.ts, response-mapper.ts, facets.ts, analyzer-config.ts
  repositories/  product.repository.ts (Postgres), es.repository.ts (ES client wrapper)
  workers/       product-indexer.worker.ts (Kafka -> bulk), outbox-poller.ts, popularity-job.ts
  middleware/    rate-limit.ts, validate.ts, cache.ts
  infra/         elasticsearch.ts, kafka.ts, redis.ts, postgres.ts, logger.ts, metrics.ts
  app.ts  server.ts
```

ES client: `@elastic/elasticsearch` v8, `maxRetries: 2`, `requestTimeout: 1000`, sniffing **off** behind LB, per-request `timeout: '800ms'` + `allow_partial_search_results: true` (par `_shards.failed` check karke metric badhao).

Types: `SearchRequest`, `SearchHit`, `FacetBucket`, `SearchResponse` (`degraded?: boolean` ke saath), `ProductDoc`.

### ES mapping essentials

| Cheez | Value | Kyun |
|---|---|---|
| `number_of_shards` / `replicas` | **6 / 1** | 130 GB / ~22 GB per shard |
| `refresh_interval` | **`1s`** normal, **`-1`** bulk reindex ke dauran | Near-real-time vs bulk throughput |
| Analyzer `product_index` | `standard` + `lowercase, en_stop, en_stemmer` | Index time |
| Analyzer `product_search` | `standard` + `lowercase, `**`syn_graph`**`, en_stop, en_stemmer` | **Synonyms sirf search time** -> list badalne par reindex nahi |
| Analyzer `autocomplete_index` | `standard` + `lowercase, edge_ngram (2-20)` | `title.ac` field; search_analyzer `standard` |
| `title` | `text`, sub-fields `.keyword` (`ignore_above: 256`) + `.ac` | Sorting/exact + autocomplete |
| `price` | **`scaled_float`, scaling_factor 100** | Money kabhi float rupees nahi |
| `brand`, `categoryPath`, `sellerId`, `productId` | **`keyword`** | Exact match + facet aggregations |
| `attributes` | `flattened` | Mapping explosion se bachne ke liye |
| `inStock` | `boolean` | Filter (exact qty nahi) |
| `popularityScore` | `float` | `function_score` ka input |
| `version` | `long` | ES external version |
| **Rule** | **Analyzer/mapping change = reindex** | Purane docs purane tokens ke saath pade hain |

### Postgres tables

```sql
products(id UUID PK, seller_id, title, description, brand, category_path,
         attributes JSONB, price_paise BIGINT, stock_qty INT, rating NUMERIC(2,1),
         rating_count INT, status CHECK (active|inactive|deleted),
         version BIGINT DEFAULT 1,      -- har update par bump; ES external version
         created_at, updated_at)
CREATE INDEX products_seller_idx ON products (seller_id, updated_at DESC);

product_outbox(id BIGSERIAL PK, product_id UUID, op CHECK (upsert|delete),
               version BIGINT, created_at, published_at NULL)       -- SAME txn as product change
CREATE INDEX product_outbox_unpublished ON product_outbox (id) WHERE published_at IS NULL;

search_synonyms(id, terms, enabled, updated_at)     -- ops edits -> synonyms.txt
query_popularity(query PK, searches_30d, ctr, updated_at)  -- nightly job output
```

`product_outbox_unpublished` ek **partial index** hai -- sirf unpublished rows par. Poller ki query `WHERE published_at IS NULL` har baar millions of published rows scan nahi karti.

### Main algorithms

| Algorithm | Kya karta hai | Key detail |
|---|---|---|
| **Inverted index** | `term -> [{docId, tf, positions}]` | Postings **docId-sorted** -> intersection sasta; Lucene mein delta + varint compression (~1-2 B/posting) + skip lists |
| **BM25** | `SUM idf(t) * tf*(k1+1) / (tf + k1*(1-b+b*dl/avgdl))` | `k1 = 1.2` **tf saturation** (keyword stuffing kaam nahi karti), `b = 0.75` **length normalization** (chhota title = strong signal), `idf = ln(1 + (N-df+0.5)/(df+0.5))` (bahar ka `1+` idf ko negative hone se rokta hai) |
| **Edge n-gram** | `iphone -> i, ip, iph, ipho, iphon, iphone` **index time** par | Query time par simple term match = O(1). Trade: index bada. Alternatives: `match_phrase_prefix` (slow, no fuzzy), `completion suggester` (FST, fastest, filters/typo limited) |
| **Fuzzy** | `fuzziness: AUTO` = Levenshtein: len 1-2 -> 0 edits, 3-5 -> 1, >5 -> 2 | `prefix_length: 1` (pehla letter sahi maano, warna term dictionary ka bada hissa scan), `max_expansions: 50`. Cost: ek term -> kai terms |
| **Synonyms** | `synonym_graph` **search time** par | List badalne par reindex nahi, sirf `_reload_search_analyzers`. Trade: search thoda slow, index-time fast par rigid |
| **Top-k** | Bounded **min-heap** (root = sabse kharab) | `O(n log k)` vs sort ka `O(n log n)`; memory sirf k. Lucene isse upar **block-max WAND** lagata hai |
| **function_score** | `field_value_factor(popularityScore, log1p, weight 0.3)` + in-stock 1.2, `boost_mode: multiply` | **Text relevance ko multiply karo, replace mat karo**; `log1p` isliye ki 1M orders wala product har query na jeete |

### Query DSL skeleton

```json
{ "size": 24,
  "query": { "function_score": {
      "query": { "bool": {
        "must":   [{ "multi_match": { "query": "iphon case", "fields": ["title^3","brand^2","description"],
                                      "type": "best_fields", "fuzziness": "AUTO",
                                      "prefix_length": 1, "max_expansions": 50 } }],
        "filter": [{ "term": { "brand": "Apple" } },
                   { "range": { "price": { "gte": 500, "lte": 2000 } } },
                   { "term": { "inStock": true } }] } },
      "functions": [{ "field_value_factor": { "field": "popularityScore", "modifier": "log1p", "missing": 0 }, "weight": 0.3 },
                    { "filter": { "term": { "inStock": true } }, "weight": 1.2 }],
      "score_mode": "sum", "boost_mode": "multiply" } },
  "aggs": { "brands":     { "terms": { "field": "brand", "size": 10 } },
            "categories": { "terms": { "field": "categoryPath", "size": 10 } },
            "price_ranges": { "range": { "field": "price",
                              "ranges": [{ "to": 500 }, { "from": 500, "to": 2000 }, { "from": 2000 }] } } },
  "sort": ["_score", { "productId": "asc" }],
  "track_total_hits": 10000 }
```

**Teen cheezein jo yaad rakhni hain:** (1) scoring `must` mein, non-scoring `filter` mein (**cacheable bitset**); (2) `sort` mein hamesha **tie-breaker** `productId` (`search_after` isi par chalti hai); (3) `track_total_hits: 10000` -- exact count mehenga hai, "10,000+" kaafi hai.

### Caching layers

| Layer | Key | TTL | Kya bachata hai | Catch |
|---|---|---|---|---|
| Browser debounce | -- | 150 ms | ~70% autocomplete requests | Client-side, sabse sasta |
| Redis **query cache** | `q:<sha1(normalizedQuery+filters+sort+page)>` | **60 s** | Head queries = **~30% traffic** ES tak jaati hi nahi | **Page 1 only, no personalization** -- warna hit ratio zero |
| Redis **prefix cache** | `sug:<prefix>` | **600 s** | 4,000 QPS autocomplete ka bada hissa | Top ~10K popular prefixes precomputed |
| ES **node query cache** | `filter` clauses ki bitsets | ES-managed | Brand/price/stock filters dobara compute nahi hote | **Isliye filter context itna important hai** |
| ES **shard request cache** | Poore shard-level results (size 0 / aggs) | ES-managed | Facet-heavy queries | `now` jaisi dynamic values cache kharab karti hain |
| OS page cache | Lucene segment files | -- | Disk IO | **Isliye node RAM heap se kaafi zyada (64 vs 31) rakhi hai** |
| Rate limit | `rl:search:<ip>` | token bucket | Scrapers | Autocomplete ki limit alag aur zyada |

### Indexing pipeline

```
Seller update
  -> Catalog Service
  -> ONE Postgres txn: UPDATE products (version+1) + INSERT product_outbox
  -> outbox poller / Debezium CDC
  -> Kafka product-changes (12 partitions, key = productId)   <-- ordering per product + burst buffer
  -> product-indexer consumer group
  -> ES bulk API (500 docs / 5 MB / 1 s), version_type: external, version: product.version
  -> searchable within ~30 s   (measure: indexer_lag_seconds)
```

| Rule | Kyun |
|---|---|
| **Dual write mat karo** | Postgres + ES ek atomic unit nahi -- ek fail hui toh **permanent silent divergence** |
| **Outbox = same transaction** | Ya dono likhe jaate hain ya koi nahi. Relay at-least-once, aur indexing idempotent |
| **key = productId** | Ek product ke updates ek hi partition -> order preserved |
| **`version_type: external`** | Purana message naye doc ko overwrite nahi kar sakta (ES 409 -> indexer ignore) |
| **Bulk, per-doc nahi** | 5M updates/day par per-doc calls waste |
| **Stock ka har change reindex nahi** | ES update = delete + re-insert (immutable segments) -> segment churn. Doc mein `inStock` boolean; exact qty DB/Redis se product page par. Price indexed hota hai par **30 s batch window mein debounced** |
| **Analyzer change = reindex** | `products_v4` -> `_reindex` + live Kafka tail -> verify (doc count + sample queries) -> **atomic alias swap** -> purana index 24 h rakho |
| Initial full reindex tuning | `refresh_interval: -1` + `number_of_replicas: 0`, **baad mein wapas set karo** (risky: us dauran ek node ka loss = data loss, aur replicas wapas banane mein time lagta hai) |

### Scaling ladder

| Stage | Kya karo |
|---|---|
| **V0 -- 100K products** | **Elasticsearch mat lagao.** Postgres `to_tsvector('english', title) @@ plainto_tsquery(...)` + `ts_rank` + **GIN index** + `pg_trgm` typos ke liye. Ek cluster kam operate karna hai |
| **V1 -- 1-5M** | Single ES node ya chhota cluster; ek index; basic BM25 + filters |
| **V2 -- 50M (hamara design)** | **6 primary + 1 replica, 6 data + 3 master nodes**; Redis query cache; **suggestions ka alag index**; outbox + Kafka + bulk indexer |
| **Read traffic badhe** | **Replicas badhao** -- replicas queries serve karte hain, ye sabse sasta read-scaling lever; phir cache hit ratio; phir hot/cold data separation |
| **Write traffic badhe** | Kafka partitions + indexer workers badhao; bulk batch tune; stock churn ko doc se bahar rakho |
| **Deep pagination** | page <= 50 `from/size`; aage **`search_after` + tie-breaker**. Scroll sirf export/offline (stateful snapshot); **PIT + search_after** modern tareeka |
| **V3 (v1 mein nahi)** | Learning-to-Rank, vector/semantic search (embeddings + kNN, hybrid with BM25), personalization (top 100 ka API-layer re-rank), multi-region active-active |

### Consistency

| Where | Level | Kyun OK |
|---|---|---|
| Postgres `products` | **Strong** (ACID) | Source of truth |
| Product + outbox row | **Atomic** (ek transaction) | Dual-write ka poora problem yahin khatam |
| Kafka -> ES | **Eventual, <= 30 s** | Requirement hi yahi hai |
| Ek product ke updates ka order | **Preserved** (partition key = productId) + `version_type: external` | Out-of-order message purana data likh hi nahi sakta |
| ES refresh | `refresh_interval: 1s` -- doc likhne ke turant baad searchable **nahi** | Near-real-time, real-time nahi |
| Facet counts | Same query pass se -- consistent with hits | -- |
| `total` | **Lower bound** (`track_total_hits: 10000`) | "10,000+" kaafi hai |
| **Price / stock** | Search results stale ho sakte hain | Isliye `inStock` boolean index mein, **exact qty product page par DB/Redis se**, aur cart/checkout par **dobara validate** |

### Failure / degrade ladder

**Principle: degrade, don't die.** (Rate Limiter ka "fail open vs closed" yahan ye ban jaata hai.)

| Failure | Behaviour |
|---|---|
| **ES cluster red / down** | **1)** Redis se stale results (head queries ke liye kaafi achhe) -> **2)** Postgres `pg_trgm`/FTS degraded search, **top 20, bina facets**, response mein `degraded: true` + UI banner -> **3)** `503 SEARCH_UNAVAILABLE`. Har degrade `search_degraded_total++` |
| **Ek shard slow / fail** | `allow_partial_search_results: true` -- baaki shards ke results do, par `_shards.failed` check karke metric badhao (chup-chaap adhoore results serve mat karo) |
| **ES slow (query timeout)** | `requestTimeout: 1000`, per-request `timeout: '800ms'`, `maxRetries: 2` -> phir degrade ladder |
| **Redis down** | Cache miss maano, seedha ES. Latency badhegi (30% extra load), functionality nahi girti |
| **Kafka lag** | Search chalti rahegi, bas results stale. **`indexer_lag_seconds`** alert. Workers catch up karte hain |
| **Indexer worker crash** | Consumer group rebalance; offsets Kafka mein; at-least-once + idempotent upsert = safe |
| **Outbox poller down** | Outbox table badhti hai (data safe hai), lag alert. Restart par wahin se |
| **Bad reindex** | Alias abhi bhi purane index par hai; verify fail -> swap mat karo. Swap ke baad bhi purana index **24 h** rakha hai -> rollback ek alias call |
| **JVM heap pressure** | `es_jvm_heap_used_percent` alert; heavy aggregations aur deep pagination hi aam wajah hain -> `page` limit, `track_total_hits`, `terminate_after` |
| **Zero results spike** | `search_zero_results_total` alert -- aam taur par galat analyzer deploy hua ya synonyms load nahi hue |

### Security

- **Rate limit per IP** on `/search` (price scrapers), autocomplete par alag aur zyada limit -- `rl:search:<ip>` token bucket.
- **Query validation**: `q` max **100 chars** -- lambi query fuzzy expansion mein cluster khaa sakti hai. `size` max 100, `page` max 50. Unknown filter -> `400` (silently ignore mat karo).
- **Query DSL kabhi user input se mat banao** -- structured `SearchRequest` -> `query-builder.ts`. Raw DSL accept karna ES ka "SQL injection" hai (script queries, expensive aggregations).
- **Admin APIs** (`/reindex`, `/synonyms`) -- authn + **admin role** authz. Reindex ek expensive operation hai.
- **Sensitive data index mein nahi** -- ES ka `_source` search results mein wapas aata hai. `status != 'active'` products index mein nahi jaane chahiye (ya filter mein hamesha `status: active`).
- **Multi-tenant leakage** -- agar seller-facing search hai toh `sellerId` filter **server side** lagao, kabhi client se mat lo.
- **ES cluster kabhi public nahi** -- private subnet, security groups, TLS + auth on transport. Public ES cluster internet par ek classic breach story hai.

### Top 5 trade-offs

| Decision | Chosen | Kyun | Kab badlega |
|---|---|---|---|
| Search engine | **Elasticsearch** | 50M docs, facet aggregations, relevance tuning, typo/synonyms, distributed | **Catalog < 5-10M aur facets simple -> Postgres FTS + GIN + pg_trgm.** Ek cluster kam operate karna bada fayda hai |
| Source of truth | **Postgres; ES derived** | ES rebuild ho sakta hai; data loss = downtime, permanent loss nahi. Analyzer change par reindex zaroori hai -- source chahiye hi | Kabhi nahi. ES ko source of truth banana red flag hai |
| Indexing path | **Outbox + Kafka + workers** | Dual write ki failure **silent aur permanent** hoti hai; yahan failure **visible** hai (lag metric) aur workers catch up karte hain | Bahut chhota system, ek hi service, low volume -> transactional job queue kaafi |
| Autocomplete | **Alag `suggestions_v2` index + edge n-gram + Redis prefix cache** | Uska traffic **4x** hai aur pattern alag; main cluster ko touch nahi karna | Bahut chhota corpus -> `completion suggester` (FST) ya seedha `match_phrase_prefix` |
| Failure policy | **Degrade, don't die** (stale cache -> pg_trgm -> 503) | Search down = revenue zero. Thode kharab results zero results se behtar hain | Kabhi degraded results dikhana galat ho (legal/compliance search) -> seedha error do |

Bonus trade-off jo aksar poocha jaata hai: **personalization vs caching.** Personalization relevance badhati hai lekin query cache ko maar deti hai (har user alag key) -- isliye v1 mein nahi, v3 mein sirf top 100 ka API-layer re-rank.

### Top 10 follow-up questions (one-line answers)

| # | Question | One-line answer |
|---|---|---|
| 1 | Postgres FTS kaafi kyun nahi? | GIN + `tsvector` 1-5M tak theek hai, par facet counts mehenge, distributed nahi, analyzer flexibility kam aur ranking tuning limited -- 50M + facets + typo/synonyms par ES |
| 2 | ES source of truth kyun nahi? | ES derived index hai -- analyzer change par reindex chahiye, aur uska data loss downtime hai, permanent loss nahi; Postgres ACID + auditable |
| 3 | Dual write kyun galat hai? | Postgres aur ES ek atomic unit nahi -- ek fail hui toh permanent silent divergence; outbox se dono likhna ek transaction ban jaata hai |
| 4 | Out-of-order Kafka messages? | Partition key `productId` se per-product order, plus `version_type: external` -- purana version 409 deta hai aur ignore hota hai |
| 5 | Stock change par reindex? | Nahi -- ES update = delete + re-insert, segment churn; doc mein sirf `inStock` boolean, exact qty product page par DB/Redis se; price 30 s batch window mein |
| 6 | 6 shards hi kyun? | 130 GB / 25-40 GB healthy shard size = 6, ~22 GB each; over-sharding se har query 60 sub-requests aur coordinate node merge overhead |
| 7 | Page 500 dikhani ho toh? | `from/size` par har shard `from+size` docs coordinate node ko bhejta hai -> memory blow (`max_result_window: 10000`); page 50 tak `from/size`, aage `search_after` + `productId` tie-breaker; Scroll sirf offline export |
| 8 | Analyzer badalna ho toh? | `products_v4` banao -> `_reindex` + live Kafka tail -> verify -> **atomic alias swap** -> purana 24 h rollback ke liye. Synonyms search-time hain isliye unke liye sirf `_reload_search_analyzers` |
| 9 | ES down ho gaya? | Degrade ladder: Redis stale -> Postgres `pg_trgm` top 20 without facets + `degraded: true` -> `503`; `search_degraded_total` alert |
| 10 | Autocomplete p99 100 ms kaise? | Client debounce 150 ms + Redis prefix cache (top 10K, TTL 600 s) + alag chhota `suggestions_v2` index jo edge n-gram se index time par kaam kar leta hai aur RAM mein fit hai |

### 30-second answer

PART 27 dekho. Skeleton: **inverted index + BM25 (kyunki `LIKE` na index use kar sakta hai na rank kar sakta hai) -> Postgres source of truth, ES derived -> outbox + Kafka + bulk indexer (dual write nahi) -> 130 GB / 6 shards + replica -> Redis head-query cache 60 s (30% traffic) -> autocomplete alag index kyunki traffic 4x -> degrade, don't die.**

### 5-minute answer (skeleton -- full text PART 28 mein)

1. **Minute 1 -- requirements clarify:** 50M products; search + facets + sort + autocomplete + 30 s indexing; p95 200 ms / autocomplete p99 100 ms / 99.95%; eventual consistency OK par stock/price special. **Aur: "chhota catalog ho toh main ES use hi nahi karunga."**
2. **Minute 2 -- scale + data structure:** 100 GB raw -> 130 GB index -> 6 shards + replica, 6 data + 3 master nodes, 31 GB heap; 231 QPS avg / 1,000 peak; **autocomplete 4x**; phir `ILIKE` ki do failures aur inverted index + BM25 ka jawab.
3. **Minute 3 -- architecture + flow:** debounce -> LB -> rate limit -> Redis cache (head queries 30%) -> QueryBuilder (**`must` vs `filter`**) -> function_score (**multiply, replace nahi**) -> aggs -> latency budget; autocomplete ka alag raasta.
4. **Minute 4 -- indexing + consistency + scaling:** **Postgres source of truth, ES derived**; dual write kyun galat; outbox -> Kafka (key=productId) -> bulk indexer; `version_type: external`; stock churn; alias-swap reindex; **"At scale yahan bottleneck ES query throughput ho sakta hai"** -> replicas -> cache -> search_after.
5. **Minute 5 -- trade-offs + failure:** **degrade, don't die** ladder; timeouts + `allow_partial_search_results`; `indexer_lag_seconds`; **"One trade-off here is"** eventual consistency vs complexity, relevance vs cacheability, `track_total_hits`; v3 items; wrap-up + "deep dive kahan?"

### Most Important Things To Remember

1. **`LIKE '%x%'` do alag cheezon mein fail hai** -- speed (leading wildcard = koi index nahi) **aur** relevance (boolean, ranking ka concept hi nahi). Inverted index pehli solve karta hai, BM25 doosri.
2. **ES ek derived index hai, kabhi source of truth nahi.** Postgres source of truth hai. Ye ek line se outbox, reindex, aur failure ke saare decisions nikalte hain.
3. **Chhote catalog par Postgres FTS hi sahi jawab hai** -- `tsvector` + GIN + `pg_trgm`. ES tab jab docs > ~5-10M, facets chahiye, relevance tuning chahiye, ya search DB ko hurt kar raha ho. "Main ES use hi nahi karunga" bolna **strength** hai, weakness nahi.
4. **Dual write kabhi nahi -- outbox pattern.** Product row aur outbox row ek hi transaction mein. Dual write ki failure silent aur permanent hoti hai; outbox ki failure visible hai (Kafka lag) aur recoverable.
5. **Jo score mein contribute nahi karta woh hamesha `filter` context mein** -- brand, price range, in-stock. Filter bitsets cacheable hain; `must` mehenga aur uncacheable hai.
6. **BM25 = TF-IDF ke do fixes:** `k1 = 1.2` se **tf saturation** (keyword stuffing kaam nahi karti) aur `b = 0.75` se **length normalization** (chhote title mein match = strong signal).
7. **Autocomplete traffic search se 4x hai** (80M vs 20M/day) -- isliye uska alag chhota index, edge n-gram (index time par kaam), aur Redis prefix cache. Ye ek number poora design badal deta hai.
8. **Har stock change par reindex mat karo** -- ES update = delete + re-insert, segments immutable. Doc mein `inStock` boolean, exact quantity DB/Redis se product page par.
9. **Degrade, don't die** -- stale cache -> Postgres `pg_trgm` top 20 with `degraded: true` -> phir 503. Search down matlab poori site ka revenue zero.
10. **Numbers bolo:** 50M products, 100 GB raw -> 130 GB index, 6 shards + 1 replica = 12, 6 data + 3 master nodes, 31 GB heap, 231 QPS avg / 1,000 peak / 4,600 sale, autocomplete 4,000 peak, head queries 30%, 5M updates/day (500/s flash sale), zero-result 12% -> target 5%.

---

## Remember

> **Coding round mein: clarify (AND ya OR? ranking chahiye? top-k?) -> logic bolo (postings docId-sorted, chhoti list drive karti hai) -> clean code (tokenize, InvertedIndex, BM25, bounded heap, trie) -> edge cases (empty query, only stop words, ek term 10M docs, duplicates, phrase) -> complexity `O(P) + O(M log k)`. Design round mein: requirements -> numbers ("autocomplete 4x hai") -> do alag flows draw karo (query path aur indexing path) -> bottleneck -> degrade ladder.** Search system ka dil ek line hai: **"Index time par kaam karo taaki query time sasta ho, Postgres ko source of truth rakho aur ES ko derived, aur failure par degrade karo -- die mat."**

## Quick Self-Test

1. Tumhare mini engine mein `query "iphone"` par P3 (tf=2, dl=13) ne P1 (tf=2, dl=15) ko kyun haraya, jabki dono ka term frequency barabar tha? BM25 ka kaun sa parameter ye decide karta hai aur uski value kya hai?
2. `intersect()` mein `lists.sort((a, b) => a.length - b.length)` wali line hata do -- output badlega ya nahi, aur `iphone` (10M postings) AND `case` (50K postings) wali query par kya farq padega? Lucene isi jagah kya karta hai jo hum nahi kar rahe?
3. Ek developer ne `{ "term": { "brand": "Apple" } }` ko `filter` se hataakar `must` mein daal diya. Results badlenge ya nahi? Latency aur cache par kya asar hoga, aur ye bug production mein kaise pakda jaayega?
4. Seller ne stock 50 se 49 kiya. Poora indexing pipeline step by step batao -- aur phir batao ki hamare design mein ye update ES tak **jaata hi nahi**, aisa kyun hai aur exact quantity user ko kahan se dikhti hai?
5. ES cluster red ho gaya hai aur Redis cache mein sirf top 1,000 queries hain. Ek user "iphon cover" search karta hai (typo ke saath, cache mein nahi). Response mein exactly kya jaayega, kaun sa field set hoga, kaun sa metric badhega, aur agar `search_after` wali page 80 ki request hoti toh kya farq hota?

---

**Search System complete.** Baaki systems: File Storage (S3-style), News Feed, Chat System. "next" bolo.
