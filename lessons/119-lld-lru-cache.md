# LLD: LRU Cache Banao (O(1) Get Aur Put)

> **Builds on**: [[71-parking-lot-lld-review]] (LLD round mein kya dekha jaata hai) aur [[83-redis-down-database-stampede]] (cache fail hone par DB par kya hota hai).

## 1. Story

Product-detail API har request par DB hit kar rahi hai. Aap decide karte hain: "last 10,000 products memory mein rakh lunga." Pehle din sab fast. Teesre din pod `OOMKilled` -- memory unbounded badh gayi.

To aapne limit lagayi: max 10,000 entries. Ab naya sawaal -- **10,001st product aaye to kisko nikalein?**

Sabse practical jawab: jo sabse lambe time se use nahi hua. Yahi **LRU -- Least Recently Used** hai. Interview mein ye sabse zyada poocha jaane wala LLD question hai, kyunki ek hi saath data structure design, pointer handling aur complexity reasoning test ho jaate hain.

## 2. Naive Approach Kyun Fail Karta Hai

```ts
// Tempting, par galat
let entries: { key: string; value: V; lastUsedAt: number }[] = [];
```

- `get(key)` -> array scan -> **O(n)**
- eviction -> minimum `lastUsedAt` dhoondo -> **O(n)**

Cache ka poora point "fast" tha, aur aapne usko hi slow bana diya. Sirf `Map` se O(1) lookup mil jaata hai, par eviction ke liye poore map par loop? Wahi O(n).

**Asli requirement**: `get`, `put`, aur `evict` -- teeno **O(1)**.

## 3. Pehla Solution: Sirf JS `Map` (Jo Aap Actually Likhoge)

Ek genuinely useful fact: **JavaScript ka `Map` insertion order preserve karta hai** -- spec guarantee hai, implementation detail nahi. Matlab `map.keys().next().value` always **sabse purani inserted key** hai.

Isse LRU sirf `Map` se ban jaata hai. "Use hua" ka matlab: delete karo, phir dobara insert karo (taaki wo order mein last chala jaaye).

```ts
export class LruCache<K, V> {
  private map = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error('capacity must be > 0');
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    this.map.delete(key);      // order se hatao
    this.map.set(key, value);  // end par daalo = most recently used
    return value;
  }

  put(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);  // dobara insert = order refresh
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K;   // first key = LRU
      this.map.delete(oldest);
    }
  }
}
```

15 lines, sab O(1) (Map ka has/delete/set amortized O(1)), zero pointer bugs. **Production mein yahi likhna chahiye.**

## 4. Doosra Solution: HashMap + Doubly Linked List (Jo Interviewer Dekhna Chahta Hai)

Interviewer poochega: *"Agar language aisa ordered map na deti to?"* -- Java ka `HashMap` ordered nahi hai, C++ ka `unordered_map` bhi nahi.

```
 head (MRU)                              tail (LRU)
  [D] <-> [C] <-> [B] <-> [A]
   ^ get/put yahan laate hain    evict yahan se ^
 map: { A -> node, B -> node, C -> node, D -> node }
```

- **HashMap**: key se node tak O(1) jump.
- **Doubly linked list**: order maintain, aur kisi bhi node ko O(1) mein aage le jaana.

Doubly (singly nahi) kyun? Node nikaalne ke liye uske **previous** ka pata chahiye. Singly mein previous dhoondhne ko head se chalna padega -- O(n), poora point khatam.

```ts
class Node<K, V> {
  prev: Node<K, V> | null = null;
  next: Node<K, V> | null = null;
  constructor(public key: K, public value: V) {}
}

export class LruCacheDll<K, V> {
  private map = new Map<K, Node<K, V>>();
  // Sentinel (dummy) head/tail -- ye ek trick 90% pointer bugs bachati hai,
  // kyunki null checks hi khatam ho jaate hain.
  private head = new Node<K, V>(null as any, null as any);
  private tail = new Node<K, V>(null as any, null as any);

  constructor(private readonly capacity: number) {
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  private unlink(n: Node<K, V>): void {
    n.prev!.next = n.next;   // pichla aage wale ko point kare
    n.next!.prev = n.prev;   // aage wala pichle ko
  }

  private pushFront(n: Node<K, V>): void {
    n.next = this.head.next;
    n.prev = this.head;
    this.head.next!.prev = n;
    this.head.next = n;
  }

  get(key: K): V | undefined {
    const n = this.map.get(key);
    if (!n) return undefined;
    this.unlink(n);
    this.pushFront(n);       // front = most recently used
    return n.value;
  }

  put(key: K, value: V): void {
    const existing = this.map.get(key);
    if (existing) {
      existing.value = value;
      this.unlink(existing);
      this.pushFront(existing);
      return;
    }
    const n = new Node(key, value);
    this.map.set(key, n);
    this.pushFront(n);

    if (this.map.size > this.capacity) {
      const lru = this.tail.prev!;     // tail se just pehle = sabse purana
      this.unlink(lru);
      this.map.delete(lru.key);        // map se hatana bhi ZAROORI hai
    }
  }
}
```

**Do classic bugs yahi par hote hain:** (1) list se node nikaal diya par `map.delete()` bhool gaye -> memory leak aur galat `size`; (2) sentinel nodes use nahi kiye -> `node.prev` null par crash.

## 5. `get` Bhi "Use" Ginna Chahiye

Bahut candidates `put` mein order update karte hain par `get` mein nahi. Wo **LRU nahi, FIFO** ban jaata hai.

Product A ko 1000 users read kar rahe hain par wo likha bahut pehle gaya tha -- FIFO usko nikaal dega, matlab sabse hot entry evict. Ek line ka farak, poora algorithm badal gaya.

## 6. Upar TTL Lagana

LRU bolta hai *"jagah khatam, kisko nikaalein"*. TTL bolta hai *"ye data purana ho gaya, galat hai"*. Do alag problems, dono chahiye.

```ts
type Entry<V> = { value: V; expiresAt: number };   // map ab Entry<V> rakhta hai, raw V nahi

get(key: K): V | undefined {
  const e = this.map.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expiresAt) {   // lazy expiry: read ke waqt check
    this.map.delete(key);
    return undefined;
  }
  this.map.delete(key); this.map.set(key, e);
  return e.value;
}
```

**Lazy expiry** (read par check) vs **active sweep** (background timer): in-process cache ke liye lazy kaafi hai, kyunki jo key kabhi padhi nahi jaayegi wo LRU se apne aap nikal jaayegi. Wahi trade-off [[03-ttl-deletion-at-scale]] aur [[40-short-url-expiry-cron-vs-redis-ttl]] mein hai.

## 7. Thread Safety: Node Mein Non-Issue, Processes Ke Beech Real

Java mein interviewer `synchronized` poochega. Node mein honest answer: *"single-threaded hai aur mere `get`/`put` mein koi `await` nahi, isliye poora method ek tick mein atomically chalta hai -- ek process ke andar lock ki zaroorat nahi."*

Par `get` ke andar `await` daal do (cache miss par DB call) aur method do halves mein toot gaya -- beech mein doosri request chal sakti hai. Yahi **check-then-act** race hai [[26-duplicate-email-race-condition]] wali. Fix: value ko nahi, **in-flight promise** ko cache karo (request coalescing).

Aur 4 pods / `cluster` workers par ([[109-cluster-worker-threads-child-process-hinglish]]) har worker ka apna LRU hai: memory 4x, hit rate gira, aur invalidation ka koi tareeka nahi. Isliye shared cache **Redis** mein jaata hai (`maxmemory-policy allkeys-lru` internally yahi algorithm ka approximate sampling version chalata hai). Practical setup dono hai: chhota in-process LRU (L1) + Redis (L2) -- aur Redis down hone par kya, wo [[83-redis-down-database-stampede]] mein.

## 8. Complexity

| Operation | Array + timestamp | JS `Map` only | HashMap + DLL |
|---|---|---|---|
| `get` | O(n) | **O(1)** | **O(1)** |
| `put` (existing key) | O(n) | **O(1)** | **O(1)** |
| `evict` LRU | O(n) | **O(1)** | **O(1)** |
| Extra memory | kam | kam | 2 pointers per entry |
| Likhne mein | aasan | sabse aasan | bug-prone |

Space dono O(capacity); DLL ka constant factor zyada, par wo language-independent hai.

## 9. Common Galtiyan

- `get` par recency update na karna -> LRU ki jagah FIFO.
- Node unlink karke `map.delete()` bhool jaana -> leak.
- Singly linked list -> removal O(n).
- Capacity ko **entry count** se naapna jab entries ka size wildly different ho (1 KB vs 5 MB JSON) -- aise case mein byte-based limit chahiye.
- Interview mein `Map` trick batakar ruk jaana; aur production mein scratch se likhna jab `lru-cache` package battle-tested hai. **Interview mein likho, prod mein library.**

## 10. 🧠 Remember

> LRU ko do cheezein chahiye -- key se entry tak O(1) jump (HashMap) aur recency ka O(1) reorder (doubly linked list); JavaScript ka `Map` apne insertion order se dono free de deta hai, par interviewer ke liye pointer surgery bhi aani chahiye.

## 11. Quick Self-Test

1. `get` par order update na karein to behaviour kaunse algorithm jaisa ho jaata hai, aur nuksaan kya?
2. Singly linked list se LRU banane par kaunsa operation O(n) ban jaata hai aur kyun?
3. Sentinel head/tail nodes kaunse bugs se bachate hain?
4. 4 pods par in-process LRU chalane se hit rate par kya asar, aur fix kya?
5. LRU eviction aur TTL expiry alag cheezein kyun hain -- ek example jahan sirf TTL kaafi nahi.
