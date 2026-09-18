# File Storage (S3-style) -- HLD + LLD (Part 3: Algorithms -> Concurrency -> Caching + CDN)

> Is file mein prompt ke **Parts 13-15** hain: StoreBox ke important algorithms (zero se, numbers ke saath), concurrency (same key par do PUT, GET during DELETE, multipart races), aur caching (CDN + metadata cache + data node cache).
> Part 1-2 recap: ShopKart apna S3-style object store **StoreBox** bana raha hai. Core idea: **metadata alag, data alag**. Metadata (bucket, key, version, chunk list, locations) **PostgreSQL** mein; bytes **storage nodes** ke HDDs par, 8 MB **chunks** mein, har chunk ki **3 replicas 3 alag AZs** mein. Write path: API stream karta hai -> primary node -> chain replication -> **W = 2 of N = 3** fsync ho gaye toh chunk durable -> saare chunks durable hone ke baad **ek metadata transaction** (objects + object_chunks + chunk_locations + `is_latest` flip) -> **commit = object visible**. Deletes: pehle metadata, bytes baad mein GC + compaction. COLD class = erasure coding 8+4.
> Ab dekhenge ye numbers aur choices **kyun** hain -- 8 MB hi kyun, placement kaise, 11 nines ka math kya hai, erasure coding andar se kya karta hai -- aur jab do requests ek saath ek hi key ko chhuein toh kya hota hai.
> Honest note: real S3 isse kahin bada hai aur uske internals sirf thode public hain. Ye woh design hai jo interviewer expect karta hai; real systems (S3, Ceph, Haystack) ke references hedged hain.

---

## PART 13 -- Important Algorithms: "bytes kabhi na khoyein, aur fast milein"

### Problem kya hai?

Rahul (ShopKart seller) ne 1 GB ka product video upload kiya. Ab sawaal: itni badi file ek piece mein rakhein (upload beech mein toota toh)? Kaunse servers par (kal 10 naye servers aaye toh sab shift)? Disk ya poora AZ gaya toh? 3x storage mehenga hai -- purane data ke liye sasta tareeka? "11 nines" ka proof kya? Disk ne chupke se ek bit badal diya (bit rot) toh? Arbon chhoti files disk par kaise rakhein? Ye 7 algorithms jawab dete hain:

| # | Algorithm | Kaunsa problem solve karta hai |
|---|---|---|
| 1 | Chunking (8 MB) | Badi file ko retry-able, parallel pieces mein todna; Range reads |
| 2 | Placement (hashing -> consistent hashing -> failure-domain aware) | Chunk kis node par jaaye, nodes add/remove par kam data move |
| 3 | Replication + quorum (N=3, W=2, R=1) | Ek node/AZ gaya toh bhi data safe aur write fast |
| 4 | Erasure coding 8+4 | COLD data ko 3x ki jagah 1.5x mein utna hi (ya zyada) safe rakhna |
| 5 | Durability math | "11 nines" ka intuition, aur repair speed kyun sabse important hai |
| 6 | Checksums + ETag | Corruption pakadna (CRC32C), client ko content fingerprint (MD5 ETag) |
| 7 | Append-only volume files + index + compaction | Arbon chhote objects ko efficiently disk par rakhna, delete ka space wapas lena |

---

### Algorithm 1 -- Chunking: 8 MB hi kyun?

**Chunk ka matlab:** object ko fixed size ke tukdon mein todna. Har tukda ek alag unit hai -- alag ID (`ch_<ULID>`), alag checksum, alag placement.

#### Naive approach -- poori file ek piece

1 GB video ek hi blob, ek disk par. Upload 900 MB par toota -> **poora 1 GB dobara**. Read speed = ek HDD ki speed (~150-200 MB/s), parallel nahi. Aur 1 TB ka backup ek disk ka balance bigaad deta hai.

#### Doosra extreme -- bahut chhote chunks (64 KB)

Metadata explode hota hai. Har chunk ke liye 1 `object_chunks` row + 3 `chunk_locations` rows = **4 rows per chunk**:

| Chunk size | 1 GB object -> chunks | Metadata rows (1 + 3 per chunk) | Ek chunk retry (100 Mbps client) |
|---|---|---|---|
| 64 KB | 16,384 | 65,536 | 0.01 s |
| 1 MB | 1,024 | 4,096 | 0.08 s |
| **8 MB** | **128** | **512** | **0.67 s** |
| 64 MB | 16 | 64 | 5.4 s |
| 1 GB | 1 | 4 | 85.9 s |

(Node se compute kiya: `Math.ceil(2**30 / size)`, retry time = `size x 8 / 100e6`.)

**8 MB sweet spot kyun?**

- **Metadata:** 1 GB = 128 chunks = 512 rows. Manageable. 64 KB par 65K rows sirf ek video ke liye -- metadata DB (jo already ~7.3 TB/year hai) ka size 100x.
- **Retry:** ek chunk fail hua toh sirf 8 MB dobara -- mobile network par bhi ~1 s.
- **Parallelism:** 128 chunks alag nodes par -> GET mein kai nodes se parallel read, ek disk ki speed limit nahi.
- **Memory:** Node.js API ek chunk ek baar mein buffer karta hai (checksum + forward ke liye) -> per upload memory **max ~8 MB**, bounded (Part 14 mein detail).
- **Small objects par koi nuksaan nahi:** 500 KB image = **1 chunk** (chunk 8 MB se chhota ho sakta hai; last chunk hamesha chhota hota hai). Padding nahi karte.

(Real systems alag sizes use karte hain -- HDFS ka default block 128 MB hai, kuch systems 4-64 MB. Koi "sahi" number nahi; trade-off hai. Interview mein reasoning matter karti hai.)

#### Chunk count math

```
chunkCount = ceil(sizeBytes / CHUNK_SIZE)          CHUNK_SIZE = 8 * 1024 * 1024 = 8,388,608
lastChunkSize = sizeBytes - (chunkCount - 1) * CHUNK_SIZE
```

- 500 KB -> 1 chunk. 1 GB -> 128 chunks. 5 GB -> 640. Max object ~1 TB -> **131,072 chunks** (isliye metadata mein `seq INT` kaafi hai).

#### Range -> chunk index + offset

Rahul ka customer video mein seek karta hai: `Range: bytes=16000000-17999999` (2 MB). Hamein saare 128 chunks nahi, sirf woh chahiye jo is range ko touch karte hain.

```
startChunk  = floor(16000000 / 8388608) = 1      offset in chunk 1 = 16000000 - 1 x 8388608 = 7,611,392
endChunk    = floor(17999999 / 8388608) = 2      offset in chunk 2 = 17999999 - 2 x 8388608 = 1,222,783
```

Toh: chunk 1 se bytes `7611392..8388607` (777,216 bytes) + chunk 2 se `0..1222783` (1,222,784 bytes) = **2,000,000 bytes**. Sirf 2 chunks padhe.

Doosra example: `bytes=20000000-20999999` -> start aur end dono chunk 2 mein (offset 3,222,784 se 4,222,783) -> **1 chunk**. (Dono node se verify.)

```ts
// src/storage/chunker.ts (Range helper)
import { CHUNK_SIZE } from '../config/constants';

export interface ChunkSlice { seq: number; start: number; end: number }   // end inclusive, chunk ke andar

export function slicesForRange(rangeStart: number, rangeEnd: number): ChunkSlice[] {
  const first = Math.floor(rangeStart / CHUNK_SIZE);
  const last = Math.floor(rangeEnd / CHUNK_SIZE);
  const out: ChunkSlice[] = [];
  for (let seq = first; seq <= last; seq++) {
    const chunkBase = seq * CHUNK_SIZE;
    out.push({
      seq,
      start: seq === first ? rangeStart - chunkBase : 0,
      end: seq === last ? rangeEnd - chunkBase : CHUNK_SIZE - 1,
    });
  }
  return out;
}
// slicesForRange(16000000, 17999999) -> [{seq:1,start:7611392,end:8388607},{seq:2,start:0,end:1222783}]
```

**Code Explanation:**

- `first` / `last` -- range ke pehle aur aakhri byte kis chunk mein hain. Integer division = `Math.floor`.
- `chunkBase = seq * CHUNK_SIZE` -- object mein is chunk ka pehla byte. Object offset se chunk offset = minus chunkBase.
- `seq === first ? ... : 0` -- pehle chunk mein beech se shuru; baaki chunks shuru se.
- `seq === last ? ... : CHUNK_SIZE - 1` -- aakhri chunk mein beech tak; baaki poore.
- Range ka `rangeEnd` pehle hi `size - 1` par clamp hota hai (controller mein); `rangeStart >= size` ho toh **416**. Isliye last chunk ke chhote size ki alag fikar nahi.
- Ye pure function hai -- unit test aasaan (Part 6 ki test list mein).

> **Interview line:** "Main objects ko 8 MB chunks mein todunga. Chhote chunks metadata explode karte hain -- 64 KB par 1 GB video ke 65K metadata rows; bade chunks par retry mehenga aur parallelism kam -- 1 GB chunk ka retry 100 Mbps par 86 second. 8 MB par 1 GB = 128 chunks, retry ~0.7 s, aur API ki memory per upload 8 MB par bounded. Range request aaye toh floor(offset / 8 MB) se sirf overlapping chunks padhta hoon."

---

### Algorithm 2 -- Placement: chunk kis node par jaaye?

#### Naive approach -- `hash(chunkId) % N`

10 nodes hain. `node = hash(chunkId) % 10`. Simple, even spread.

Ab 11th node add kiya. `hash % 11` -- **kitne chunks ka node badal gaya?**

Node simulation (100,000 chunk ids, md5 hash): **90.9%** chunks ka node badal gaya. Matlab 10 PB mein se ~9 PB network par shift! Sirf ek node add karne ke liye.

Kyun? `x % 10` aur `x % 11` sirf tab same hain jab `x mod 110` ek chhote set mein ho -- roughly 1/11 cases. Baaki sab move.

#### Consistent hashing -- ek ring

**Consistent hashing ka matlab:** hash space (0 se 2^32 - 1) ko ek **gol ring** maano. Har node ko ring par ek position milti hai (`hash(nodeId)`). Chunk ka hash bhi ring par ek point hai; chunk **clockwise chalte hue pehle node** par jaata hai.

```
            0 / 2^32
         .-----------.
   node-C             node-A
     |     ch_x ->      |        ch_x clockwise chala -> pehla node-A mila
   node-B             (new node-D)
         '-----------'
```

Naya node D aaya -> ring par ek jagah baitha -> sirf **uske just pehle wale arc** ke chunks (jo pehle agle node par jaate the) D par shift. Baaki sab wahin. Ideal: **~1/N** move (11 nodes par 1/11 = 9.1%).

**Problem: ek node = ring par ek point -> load bahut uneven.** Simulation (10 nodes, 100K chunks, ek point per node): kisi node par **325** chunks, kisi par **27,663**. Ideal 10,000.

**Fix -- virtual nodes (vnodes):** har physical node ko ring par **kai points** (e.g. `node-A#0 ... node-A#99`). Bahut saare chhote arcs -> average out.

| Vnodes per node | 10 -> 11 nodes par moved | Load min - max (ideal 10,000) |
|---|---|---|
| 1 | 11.3% | 325 - 27,663 |
| 10 | 9.4% | 7,355 - 16,335 |
| 100 | 7.6% | 8,995 - 11,189 |
| 200 | 8.5% | 9,401 - 10,740 |

(Node simulation. Mod-N: 90.9% moved. Ideal consistent hashing: 9.1%.)

**Capacity weights:** 40 TB node ko 20 TB wale se double vnodes do -> double data. Isliye "capacity-aware".

#### Failure domains -- 3 replicas 3 AZs mein

Ring se "pehle 3 nodes clockwise" lo -- lekin teeno same AZ ke nikle toh? AZ ki power gayi -> teeno replicas gaye. Isliye walk karte raho aur **sirf alag AZ wale** healthy node lo.

**Failure domain ka matlab:** cheezon ka woh group jo ek saath fail ho sakta hai -- ek disk, ek server, ek rack (same power/switch), ek AZ (poora data center). Replicas ko jitne upar ke domain mein faila sako, utna safe.

```ts
// src/storage/placement.ts (placement service ke andar -- simplified)
import { createHash } from 'node:crypto';

interface NodeInfo { id: string; az: string; capacityTb: number; healthy: boolean; diskUsedRatio: number }
const hash32 = (s: string) => createHash('md5').update(s).digest().readUInt32BE(0);

export class HashRing {
  private points: { pos: number; node: NodeInfo }[] = [];

  constructor(nodes: NodeInfo[], vnodesPerTb = 10) {
    for (const n of nodes) {
      const v = Math.max(1, Math.round(n.capacityTb * vnodesPerTb));
      for (let i = 0; i < v; i++) this.points.push({ pos: hash32(`${n.id}#${i}`), node: n });
    }
    this.points.sort((a, b) => a.pos - b.pos);
  }

  private firstAtOrAfter(pos: number): number {
    let lo = 0, hi = this.points.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.points[mid].pos < pos) lo = mid + 1; else hi = mid; }
    return lo % this.points.length;
  }

  pickNodes(chunkId: string, replicas = 3): string[] {
    const chosen: string[] = [];
    const usedAz = new Set<string>();
    let i = this.firstAtOrAfter(hash32(chunkId));
    for (let steps = 0; steps < this.points.length && chosen.length < replicas; steps++, i = (i + 1) % this.points.length) {
      const n = this.points[i].node;
      if (!n.healthy || usedAz.has(n.az) || n.diskUsedRatio > 0.85) continue;
      chosen.push(n.id);
      usedAz.add(n.az);
    }
    if (chosen.length < replicas) throw new Error('NOT_ENOUGH_FAILURE_DOMAINS');
    return chosen;
  }
}
// 12 nodes (4 per AZ): pickNodes('ch_01J8ABC') -> ['node-az2-002', 'node-az1-002', 'node-az3-003']
```

**Code Explanation:**

- `hash32` -- md5 ke pehle 4 bytes = 32-bit ring position. Security ke liye nahi, sirf **even spread** ke liye (md5 yahan theek hai).
- `v = capacityTb * vnodesPerTb` -- 20 TB node = 200 vnodes, 40 TB = 400. Capacity weight.
- `points.sort` -- ring = sorted array. Lookup = **binary search** (`firstAtOrAfter`), O(log n).
- `lo % this.points.length` -- sabse bade position ke baad wapas 0 par (ring gol hai).
- `pickNodes` -- chunk ke position se clockwise walk. Unhealthy (heartbeat miss), already-used AZ, ya 85% se bhari disk -> skip.
- `steps < this.points.length` -- poori ring ek baar ghoom li aur 3 AZ nahi mile -> error. Write **fail closed** (3 AZ nahi toh durability promise nahi).
- Output ka pehla node = **primary** (chain replication ka head).

#### Twist: hamare design mein location metadata mein likhi hai

Dhyan do: hum `chunk_locations` table mein **exact node** likhte hain. Read path ring se location **compute nahi karta**, DB se padhta hai. Toh consistent hashing kyun?

- **Directory-based placement** (hamara): placement service kuch bhi decide kar sakta hai (sabse khali disk, sabse kam load), aur answer DB mein. Node add hua -> **naye chunks** naye node par; purane move karna optional (rebalancer dheere dheere, `chunk_locations` update karke).
- **Computed placement** (Ceph ka **CRUSH** algorithm publicly aisa describe hota hai): location ek function se compute hoti hai (cluster map + object id), koi per-object location table nahi. Ceph pehle objects ko **placement groups (PGs)** mein hash karta hai, phir CRUSH PG ko failure-domain rules ke saath OSDs (disks) par map karta hai. Fayda: location metadata nahi; nuksaan: cluster map badla toh data move karna **padta** hai -- isliye wahan "kam movement" (consistent hashing jaisa behaviour) critical hai.

Hamare liye ring ek **accha default policy** hai (even spread, deterministic, capacity-weighted, rebalance par kam movement), lekin correctness DB ki location se aati hai. Interview mein ye farak bolna strong signal hai.

> **Interview line:** "hash % N par ek node add karte hi ~91% data move hota hai. Consistent hashing ring par sirf ~1/N move hota hai, aur virtual nodes load even karte hain -- 1 point per node par load 325 se 27K tak, 100 vnodes par +-11%. Capacity ke hisaab se vnodes, aur replicas ke liye clockwise walk karke 3 alag AZ ke healthy nodes. Hamare design mein final location chunk_locations mein likhi hoti hai, toh placement policy badal sakti hai bina read path chhue; Ceph jaise systems CRUSH se location compute karte hain aur table nahi rakhte."

---

### Algorithm 3 -- Replication + Quorum: N=3, W=2, R=1

**Quorum ka matlab:** N copies mein se kitni ko "haan" bolna zaruri hai tab operation successful maana jaaye. **N** = total replicas, **W** = write ke liye kitne ack, **R** = read ke liye kitne replicas se padhna.

#### W kitna?

| W | Kya hota hai | Problem |
|---|---|---|
| W = 1 | Ek node ne fsync kiya -> 200 OK | Woh disk ack ke 1 sec baad mari -> data gaya, lekin client ko "saved" bola tha |
| **W = 2** | 2 nodes, **2 alag AZs**, dono fsync | Ek poora AZ jaaye tab bhi 1 copy bachi; repair usse 3 bana dega |
| W = 3 | Teeno ka wait | Sabse slow node (ya ek AZ ka network hiccup) har write ki latency tay karta hai; ek node down = writes ruk jaate (ya naya node dhoondho) |

**W=2** = durability (2 AZs mein pakka) + latency (slowest ka wait nahi). Teesri copy async ya repair worker (`storage.repair` topic) se. Metric `chunks_under_replicated` isi 3rd copy ka backlog hai -- **0 ki taraf trend karna chahiye**.

#### R = 1 kyun kaafi hai? (Dynamo-style R + W > N yahan kyun nahi chahiye)

Dynamo/Cassandra jaise systems mein rule hai **R + W > N** -- taaki read aur write sets overlap karein aur read ko latest value mile. Wahan ek key ki value **badalti** hai, aur replicas alag versions rakh sakte hain.

Hamare case mein do cheezein ise bekaar bana deti hain:

1. **Chunks immutable hain.** `ch_01J8...` ek baar likha gaya toh uske bytes kabhi nahi badalte. Naya PUT = **naye chunks** (naye IDs). Toh ek chunk ke "old version" aur "new version" hote hi nahi -- jo replica bhi mil jaaye, same bytes.
2. **Metadata batata hai kaunsa replica DURABLE hai.** `chunk_locations.state = 'DURABLE'` wali rows hi read ke liye candidate. `WRITING` wala (jiska fsync abhi nahi hua) kabhi read nahi hota.

"Latest kya hai" ka sawaal **metadata DB** (Postgres, primary/sync standby) solve karta hai, data nodes nahi. Isliye data read = **R = 1**: nearest healthy DURABLE replica, CRC32C verify, mismatch/timeout -> agla replica + repair task.

#### Chain vs fan-out replication

```
Fan-out:   API --8MB--> node-A
           API --8MB--> node-B          API ka upload bandwidth 3x
           API --8MB--> node-C

Chain:     API --8MB--> node-A --8MB--> node-B --8MB--> node-C    (hamara spec)
                         (primary)
```

| | Fan-out (client -> sab) | Chain / pipeline (primary -> replicas) |
|---|---|---|
| API server ka outbound | **3x** (8 MB x 3) | **1x** |
| Latency | Parallel -- max(3 writes) | Pipelined -- bytes aate hi aage forward (store-and-forward nahi), toh extra latency chhoti |
| Ack / failure | API ginta hai; simple | Primary W=2 ginta hai; beech ka node gira toh chain reroute |

1,000 PUT/s x 500 KB = ~500 MB/s ingest at peak -- fan-out mein API fleet se **1.5 GB/s** nikalta. Chain mein API sirf 1x bhejta hai; baaki traffic data nodes ke beech (HDFS ka write pipeline bhi publicly isi tarah describe hota hai).

#### "Durable" ka matlab kya? fsync

`fs.write()` return hua = bytes **OS page cache** (RAM) mein hain, disk par nahi. Power gayi -> gaye. **`fsync`** = OS se bolna "ye bytes physically disk par likho, tab lautna".

```ts
// src/datanode/volume.ts (write part -- simplified)
const { bytesWritten } = await fh.write(chunk, 0, chunk.length, offset);
await fh.sync();                      // fsync: power jaaye tab bhi bytes bache
index.set(chunkId, { volumeId, offset, length: bytesWritten, crc32c });
```

**Code Explanation:**

- `fh.write(...)` -- volume file mein `offset` par append. Abhi sirf page cache mein.
- `fh.sync()` -- Node ka `FileHandle.sync()` = `fsync(2)`. HDD par ~ms lagte hain -- isliye data nodes kai chunks ek saath fsync karke batch kar sakte hain (group commit).
- `index.set` -- local index update fsync ke **baad**. Ulta kiya toh index bolega "chunk hai" jab bytes disk par nahi.
- **Ack sirf sync ke baad.** Durability ka pura promise is ek line par tika hai.

> **Interview line:** "N=3 replicas 3 AZs mein, W=2 -- do alag AZs ne fsync kiya tab chunk durable, teesri async ya repair se. Reads ke liye R=1 kaafi hai kyunki chunks immutable hain aur metadata batata hai kaunse replicas DURABLE hain -- 'latest version' ka sawaal Postgres solve karta hai, data nodes nahi. Chain replication se API ka bandwidth 1x rehta hai. Aur durable ka matlab fsync, sirf write() nahi."

---

### Algorithm 4 -- Erasure Coding 8+4 (COLD class)

#### Problem

3x replication: 3.65 PB logical/year -> **~10.95 PB raw**, 20 TB disks -> ~548 disks/year. 30 din se purani invoices aur backups koi padhta bhi nahi, phir bhi 3x. Kya kam space mein utna hi safe rakh sakte hain?

#### Zero se: XOR parity (RAID-5 wala idea)

**XOR ka rule:** same bits -> 0, alag bits -> 1. Aur jaadu: `A xor B = P` ho toh `A = P xor B`. Kisi ek ko kho do, baaki do se wapas bana lo.

Do data blocks, ek parity block:

```
D1 = "Hi" = 0x48 0x69 = 01001000 01101001
D2 = "!?" = 0x21 0x3F = 00100001 00111111
P  = D1 xor D2        = 01101001 01010110  = 0x69 0x56
```

Byte 1 ka calculation: `01001000 xor 00100001 = 01101001`.

Ab **D1 wali disk mar gayi**. Humare paas D2 aur P hain:

```
D1 = P xor D2 = 01101001 xor 00100001 = 01001000 = 0x48 = 'H'
                01010110 xor 00111111 = 01101001 = 0x69 = 'i'     -> "Hi" wapas!
```

(Node se verify.) Storage: 2 data + 1 parity = **1.5x**, aur **1 loss** survive. 3x replication 2 loss survive karti hai lekin 3x space.

#### Reed-Solomon -- XOR ka bada bhai

XOR sirf **1** loss sambhalta hai. Hamein 4 chahiye. **Reed-Solomon (RS)** codes ye generalise karte hain: **k data fragments** se **m parity fragments** banao (thodi advanced math -- "Galois field" arithmetic, detail interview mein nahi poochte). Guarantee: 12 mein se **koi bhi 8** fragments mil jaayein -> original data wapas.

Intuition (hedged, sirf samajhne ke liye): 8 numbers ko ek polynomial ke 8 coefficients maano; us polynomial ko 12 alag points par evaluate karo aur 12 values store karo. Degree-7 polynomial ko **koi bhi 8 points** poori tarah define karte hain -- isliye koi bhi 8 values se baaki sab nikal aate hain.

#### 8+4 on StoreBox

```
1 GB COLD object ka ek stripe (simplified):
data   : F1 F2 F3 F4 F5 F6 F7 F8        (har ek original ka 1/8)
parity : P1 P2 P3 P4                    (RS se compute)
12 fragments -> 12 alag nodes, 3 AZs mein 4-4
```

| | 3x replication | EC 8+4 |
|---|---|---|
| Storage overhead | 3.0x | **1.5x** (12/8) |
| 3.65 PB/year raw | ~10.95 PB | **~5.5 PB** |
| 20 TB disks/year | ~548 | **~274** |
| Kitne losses survive | 2 (koi bhi) | **4 (koi bhi)** |
| AZ loss (4 fragments per AZ) | Survive | Survive (8 bache) -- lekin phir 0 margin |
| Normal read | 1 node | **8 nodes** se fragments + reassemble (ya data fragments hi padho agar sab healthy) |
| Repair of 1 lost fragment | 1 copy padho, 1 likho | **8 fragments padho**, compute, 1 likho -- 8x network |
| CPU | Nahi | Encode/decode CPU |

#### Sirf COLD ke liye kyun?

- **Read cost:** hot product image ka har GET 8 nodes chhuye -> 8x IOPS, tail latency = slowest of 8. Hot data ke liye bura.
- **Repair cost:** ek 20 TB disk mari -> uske har fragment ke liye 8 fragments padhne -> **~160 TB** network read. Replication mein 20 TB.
- **Small objects:** 500 KB image ke 12 fragments of ~62 KB -- 12 alag nodes par 12 seeks, metadata 12 rows. Isliye EC typically bade objects ya bahut saare chhote objects ko **pack karke** (volume level par) kiya jaata hai.
- **Write path complexity:** encode ke liye poora stripe chahiye. Isliye flow: pehle 3x mein likho (fast, simple), 30 din baad **lifecycle worker** padh ke encode kare aur 3 replicas hataaye.

(AWS publicly bataata hai ki S3 erasure coding use karta hai; exact schemes public nahi. Facebook ka "f4" warm-BLOB paper aur Azure Storage ka "LRC" paper is trade-off ko detail mein discuss karte hain.)

> **Interview line:** "Cold data ke liye 8+4 Reed-Solomon: 8 data + 4 parity fragments 12 nodes par, koi bhi 8 se object wapas -- 4 losses survive, overhead 1.5x vs 3x, yaani saalana ~548 ki jagah ~274 disks. Intuition XOR parity se: P = A xor B, A khoya toh A = P xor B. Lekin EC read aur repair mehenga hai -- 8 nodes chhune padte hain, repair 8x network -- isliye hot data 3x replicated, 30 din baad lifecycle worker encode karta hai."

---

### Algorithm 5 -- Durability Math: 11 nines ka intuition

**11 nines** = 99.999999999% = ek object ka ek saal mein khone ka chance **1e-11**. 10B objects x 1e-11 = **~0.1 object/year** (yaani ~10 saal mein ek).

#### Simple probability sketch (assumptions saaf likhe hain)

Assumptions (sirf intuition ke liye):

- Disk **AFR** (annual failure rate) = **2%** (public fleet reports, e.g. Backblaze, roughly 1-2% dikhate hain).
- Disk failures **independent** hain (ye sabse bada jhooth hai -- neeche).
- Disk mari -> hum **T hours** mein uska data dobara replicate kar dete hain (repair window).

Ek chunk tab khoega jab: ek replica ki disk mare, **aur** repair khatam hone se pehle baaki dono bhi mar jaayein.

```
p(ek disk T hours mein mare)   = 0.02 x T / 8760
P(chunk loss per year) ~ 3 x 0.02 x p^2              (3 = koi bhi replica pehle mare)
EC 8+4:  ~ 12 x 0.02 x C(11,4) x p^4                 (pehle ke baad 11 mein se 4 aur)
```

| Repair window T | p | 3x loss/year | "Nines" (3x) | EC 8+4 loss/year | "Nines" (EC) |
|---|---|---|---|---|---|
| **1 hour** | 2.28e-6 | 3.1e-13 | ~12.5 | 2.2e-21 | ~20.7 |
| **24 hours** | 5.48e-5 | 1.8e-10 | ~9.7 | 7.1e-16 | ~15.1 |
| **7 days** | 3.84e-4 | 8.8e-9 | ~8.1 | 1.7e-12 | ~11.8 |

(Node se compute kiya.)

**Do bade sabak:**

1. **Repair speed sabse bada lever hai.** Replicas 3 hi hain, sirf repair 1 hour se 24 hours hua -> **~3 nines gaye**. Isliye: heartbeat 5 s, 10 min mein dead declare, aur repair **parallel** -- mari disk ke chunks hazaron alag nodes ki replicas se copy hote hain (kyunki placement ne unhe faila rakha hai), ek node se nahi. 20 TB ek node se copy = ghanton-din; 1,000 nodes se 20 GB each = minutes.
2. **Independence ka assumption jhootha hai -- asli risk correlated failures hain.** Same batch ki disks ek saath marti hain, ek rack ki power jaati hai, ek AZ mein flood, ek **software bug** jo sab nodes par galat delete kare, ek operator ki galti. Math mein ye nahi aata. Isliye 3 **AZs** (correlated physical failures todne ke liye), checksums + scrubber (silent corruption), versioning (galti se delete), aur deletes mein grace period.

Honest line: "11 nines" ek **design target** hai jo aise models + fleet data se aata hai, koi proof nahi. AWS S3 11 nines ka **design** claim karta hai; uska exact model public nahi.

> **Interview line:** "Durability ka intuition: chunk tab khota hai jab repair khatam hone se pehle saari replicas mar jaayein. 2% AFR aur 1 hour repair par 3x replication ka per-chunk loss ~3e-13/year; repair 24 hours ho toh ~2e-10 -- teen nines gaye. Isliye fast failure detection aur massively parallel repair durability ka asli lever hai. Aur math independent failures maanta hai; real risks correlated hain -- AZ, rack, disk batch, software bugs -- jinke liye AZ spread, checksums, scrubber aur versioning."

---

### Algorithm 6 -- Checksums: CRC32C per chunk, MD5 per object (ETag)

#### Problem -- silent corruption (bit rot)

Disk ne koi error nahi diya, lekin 3 saal baad ek bit palat gayi (magnetic decay, firmware bug, RAM bit flip jab data network se guzra). Hum ne bina check kiye customer ko bhej diya -> **corrupt invoice PDF**. Aur sabse bura -- repair worker ne isi corrupt copy se nayi replicas bana di.

#### Do alag checksums, do alag kaam

| | CRC32C | MD5 (ETag) / SHA-256 |
|---|---|---|
| Kahan | **Har chunk** (metadata `object_chunks.crc32c` + node ke local index mein) | **Har object** (ETag), client optional `Content-MD5` / `x-checksum-sha256` |
| Kaam | Accidental corruption pakadna -- fast, cheap | Client ko content fingerprint; client ke bheje bytes == hamare store kiye bytes |
| Speed | Bahut fast (modern CPUs par hardware instruction, SSE4.2) | Slower |
| Security | **Nahi** -- attacker jaan-boojh ke collision bana sakta hai | MD5 cryptographically broken hai; security ke liye SHA-256 |

**CRC32C** (Castagnoli polynomial `0x82F63B78`, reversed form) -- CRC ka matlab "cyclic redundancy check": bytes par polynomial division ka remainder. Ek bhi bit badla -> alag remainder.

```
crc32c("123456789")   = e3069283      (standard test vector -- implementation sahi hai)
crc32c("hello world") = c99465aa
crc32c("iello world") = 5ee5926b      ('h' ka ek bit flip kiya -> poora alag)
```

(Node mein table-based implementation se verify. Node ka built-in `zlib.crc32` **CRC32 (IEEE)** hai, CRC32C nahi -- galti mat karna; production mein native package lo.)

#### End-to-end verification -- har hop par

```
Client --Content-MD5--> API (MD5 + CRC32C compute while streaming)
   API --chunk + crc--> primary node (recompute CRC32C, compare, fsync)
   primary --> replica 2, replica 3 (har ek recompute + compare)
Read:  node padhta hai -> CRC32C verify -> API -> recompute -> client ko bhejo
```

- Client ne `Content-MD5` bheja aur hamara MD5 match nahi -> **400**, kuch commit nahi.
- Kisi node par CRC mismatch -> woh replica `CORRUPT`, agla replica try, `storage.repair` par task, metric `scrubber_corrupt_chunks_total`.
- **Scrubber** worker: saare chunks ko periodically (e.g. har 2 hafte) padh ke CRC verify karta hai -- jo data koi padhta nahi (cold invoices) uska corruption bhi pakda jaaye, **jab tak doosri healthy replicas hain**. Scrubber ke bina corruption tab pata chalta jab teeno copies sad chuki hoti.

Scrub math: 20 TB disk / 14 din = ~16.5 MB/s continuous background read -- HDD ki ~150+ MB/s ka ~10%. Throttle karke chalao, foreground reads ko priority.

#### ETag rules

**Single PUT:** ETag = MD5 hex of bytes, quotes ke saath.

```
PUT "hello world" -> ETag: "5eb63bbbe01eeed093cb22bb8f5acdc3"
```

**Multipart:** ETag = MD5 of **concatenated binary part MD5s** + `-<partCount>` (S3 convention).

Example: part 1 = 5 MB of `a`, part 2 = 1 MB of `b`:

```
md5(part1) = 79b281060d337b9b2b84ccf390adcf74
md5(part2) = 96767d2b46489f3520698a6df536dc4c
ETag       = md5( <16 raw bytes of md5(part1)> + <16 raw bytes of md5(part2)> ) + "-2"
           = "88fc978485924ccd87ceb19c90195b35-2"

Common galti -- hex strings concat karke md5: 860adfe0072dc1a4fc57b4e99cdf49f1-2   (galat)
Poore 6 MB ka md5:                             6382629a0758054e059e024e4e6801af     (multipart ETag isse match NAHI karta)
```

(Teeno node se compute.)

```ts
// src/utils/etag.ts
import { createHash } from 'node:crypto';

export function multipartEtag(partMd5Hex: string[]): string {
  const binary = Buffer.concat(partMd5Hex.map((h) => Buffer.from(h, 'hex')));
  return `"${createHash('md5').update(binary).digest('hex')}-${partMd5Hex.length}"`;
}
```

**Code Explanation:**

- `partMd5Hex` -- `upload_parts.md5_hex` se, **partNumber order** mein (complete request ki list order).
- `Buffer.from(h, 'hex')` -- 32-char hex ko 16 raw bytes mein. Yahi "binary" wala step hai jo log bhoolte hain.
- `-${length}` -- suffix batata hai "ye multipart ETag hai, poore content ka MD5 nahi". Clients (aur `aws s3 sync` jaise tools) isse jaante hain ki ETag ko local file ke MD5 se compare nahi karna.
- Faayda: complete karte waqt **1 TB dobara padhna nahi padta** -- sirf 10,000 x 16 bytes.

> **Interview line:** "Har chunk ka CRC32C metadata aur node dono par -- write par har hop recompute karta hai, read par har baar verify, aur scrubber har ~2 hafte sab kuch padhta hai taaki cold data ka bit rot bhi repair ho jaaye jab tak healthy replicas hain. Object level par ETag MD5 hai; multipart ka ETag MD5 of concatenated binary part MD5s plus '-N' -- isliye complete par poora object dobara hash nahi karna padta. CRC corruption ke liye hai, security ke liye SHA-256."

---

### Algorithm 7 -- Append-Only Volume Files + Index + Compaction

#### Naive approach -- har chunk ek file

`/data/ch_01J8ABC...` -- har chunk ek alag file. Simple, lekin:

- **Inodes:** ~7.3B objects/year x ext4 inode ~256 bytes = **~1.87 TB/year sirf inodes**, plus directory entries -- RAM mein fit nahi.
- **Seeks:** cache miss par directory lookup + inode + data = **~3 disk seeks** per read. HDD ~100-150 random IOPS -> teen guna kam throughput. Aur fsck/backup ghanton.

**Real example (hedged):** Facebook ka **Haystack** paper (OSDI 2010) photos ke liye exactly yahi problem describe karta hai -- filesystem metadata ki wajah se har photo read par kai disk operations. Unka solution: bahut saari photos ek **bada append-only file** ("physical volume") mein, aur ek chhota in-memory index `photo_id -> (offset, size)`, taaki read = **~1 disk operation**.

#### Hamara design -- volume files

```
Data node disk:
  vol_0007.dat   (1 GB, append-only)
  [hdr|ch_A bytes][hdr|ch_B bytes][hdr|ch_C bytes] ...   -> next write offset yahan

In-memory index (+ on-disk copy):
  ch_A -> (vol_0007, offset 0,        length 524288,  crc32c ...)
  ch_B -> (vol_0007, offset 524320,   length 8388608, crc32c ...)
```

- **Write** = current volume ke end par append + fsync + index update. Sequential write -> HDD ke liye best.
- **Read** = index se `(volume, offset, length)` -> ek `pread` -> **1 seek**.
- Har record ke header mein `chunkId + length + crc32c` bhi -- index kho jaaye toh volume ko shuru se scan karke index **rebuild** ho sakta hai.
- Volume 1 GB bhar gaya -> **sealed** (read-only), naya volume khulta hai.

Index RAM: 20 TB disk / 500 KB avg = **~40M chunks** x ~32 bytes = **~1.28 GB RAM** per disk. Manageable (isliye index entry chhoti rakhte hain).

#### Delete = tombstone

Append-only file ke beech se bytes "hata" nahi sakte. Toh:

1. Metadata se object gaya (user ke liye turant gayab).
2. GC decide karta hai chunk ab kisi version ka nahi -> data node ko delete bhejta hai.
3. Data node index se entry hatata hai aur volume mein ek **tombstone record** append karta hai ("ch_B deleted") -- restart par index rebuild ke waqt ch_B wapas na aaye.
4. Bytes abhi bhi disk par hain -- **garbage**.

#### Compaction -- garbage > 30% par

```
vol_0007.dat (1 GB sealed): 35% chunks deleted
  live    = 0.65 x 1024 = 665.6 MB
  garbage = 0.35 x 1024 = 358.4 MB

Compaction: live chunks ko naye vol_0112.dat mein copy (665.6 MB read + write)
            -> index entries ko naye offsets par point karo -> purana volume delete
            -> 358.4 MB wapas
```

**Threshold 30% kyun?** Compaction ka cost = live data copy karna.

| Garbage threshold | Har compaction mein reclaim | Copy cost per MB reclaimed |
|---|---|---|
| 10% | 102 MB | 922 / 102 = **9 MB copy per MB** |
| **30%** | 307 MB | 717 / 307 = **~2.3 MB** |
| 60% | 614 MB | 410 / 614 = **~0.67 MB** |

Kam threshold = disk space bachti, lekin I/O bahut; zyada threshold = I/O kam, lekin disk par zyada garbage padi. 30% common middle ground hai -- tune karo `node_disk_used_ratio` aur disk I/O dekh ke. Metric `gc_reclaimed_bytes_total`. (Yahi idea LSM trees -- RocksDB, Cassandra -- ke compaction mein hai: append fast, cleanup baad mein batch mein.)

> **Interview line:** "Arbon chhote objects ko ek-file-per-object rakhna filesystem ko maarta hai -- 7B inodes, aur har read par ~3 seeks. Main Haystack jaisa design lunga: 1 GB append-only volume files, in-memory index chunk_id -> (volume, offset, length, crc) -- read ek seek, write sequential. Delete tombstone hai; bytes GC aur compaction wapas leta hai jab volume mein 30% se zyada garbage ho -- us point par har reclaimed MB ke liye ~2.3 MB copy karna padta hai."

---

## PART 14 -- Concurrency: jab sab ek saath ho

### Pehle: StoreBox mein concurrency kaise alag hai?

Yaad karo (Payment Part 3): Node.js mein **do `await` ke beech ka code atomic** hai, lekin `await` ke aar-paar nahi, aur N instances ek doosre ki memory nahi dekhte. Truth ek jagah honi chahiye.

StoreBox mein ek khoobsurat simplification hai: **data immutable hai**. Har PUT **naye chunks** likhta hai (naye IDs); koi chunk kabhi overwrite nahi hota. Toh data nodes par **koi race hi nahi** -- do PUTs alag alag chunks likh rahe hain. Saari concurrency ek jagah simat jaati hai: **metadata commit** (Postgres). Aur Postgres ke paas already tools hain: unique index, row locks, transactions.

### Scenario 1 -- Do PUTs same key par ek saath

Rahul aur uska teammate dono ne `products/123/main.jpg` ek hi pal upload kiya (A: purani photo, B: nayi). Dono ke chunks alag alag durable ho gaye. Ab dono metadata commit karne aaye. Pehle se `V0` latest hai.

**Rule (spec): last writer wins by metadata commit order.** Jiska commit baad mein, woh latest.

Commit transaction (update-then-insert):

```sql
BEGIN;
UPDATE objects SET is_latest = false
WHERE bucket_id = $1 AND key = $2 AND is_latest;               -- purana latest (agar hai) neeche
INSERT INTO objects (version_id, bucket_id, key, is_latest, size_bytes, etag, content_type, storage_class)
VALUES ($3, $1, $2, true, $4, $5, $6, 'STANDARD');             -- naya latest
INSERT INTO object_chunks ... ; INSERT INTO chunk_locations ... ; INSERT INTO outbox ... ;
COMMIT;
```

Race timeline (READ COMMITTED):

```
Time  Tx A (version V1)                                Tx B (version V2)
t1    UPDATE ... WHERE is_latest  -> V0 locked, 1 row
t2                                                     UPDATE ... WHERE is_latest -> V0 par row lock -> WAIT
t3    INSERT V1 (is_latest = true); chunks; COMMIT
t4                                                     V0 ka naya version dekha: is_latest = false -> 0 rows
                                                       (V1 naya row hai, B ke statement snapshot mein tha hi nahi)
t5                                                     INSERT V2 (is_latest = true)
                                                       -> ux_objects_latest: V1 already latest -> 23505 unique_violation
t6                                                     ROLLBACK -> retry transaction (same V2, same chunks)
t7                                                     UPDATE ... WHERE is_latest -> ab V1 dikhta hai -> false, 1 row
                                                       INSERT V2 latest; COMMIT   => V2 wins (baad mein commit hua)
```

- **Partial unique index `ux_objects_latest ON objects (bucket_id, key) WHERE is_latest`** asli guard hai: DB kabhi do latest rows allow nahi karega. Chahe app ka code kitna bhi galat ho.
- t4 ka subtle point: Postgres READ COMMITTED mein row lock ke baad sirf **wahi row** (V0) ka naya version dobara check karta hai; **naye rows** (V1) nahi dikhte. Isliye B ka UPDATE 0 rows laaya aur INSERT fail hua. Ye bug nahi -- index ne hamein bacha liya.
- **Retry safe hai:** chunks already durable hain, `version_id` wahi rehta hai; sirf chhota metadata transaction dobara. Retry par UPDATE naya statement hai -> naya snapshot -> V1 dikhta hai. Bounded retry (e.g. 3 baar); ek hi key par itni heavy contention real mein bahut rare hai.
- **Pehli baar wala key** (V0 exist hi nahi karta) -- dono UPDATE 0 rows, dono INSERT; doosra unique index par pehle ke commit ka wait karta hai -> 23505 -> retry -> ab V1 ko flip karke V2. Same code path handle karta hai.

**Alternative -- per-key advisory lock** (transaction ke shuru mein `SELECT pg_advisory_xact_lock(hashtextextended($1::text || '/' || $2, 0))`): ye same key ke commits ko Postgres ke andar hi line mein laga deta hai (commit par lock khud chhootta hai) -- retry ki zarurat nahi. Ye bhi valid hai; hum **unique index + retry** chunte hain kyunki extra lock call har PUT par lagti, aur conflict rare hai. Dono mein ek baat common: **guarantee Postgres deta hai, koi distributed lock nahi.**

**Create-only PUT (`If-None-Match: *`):** UPDATE step skip -> seedha INSERT. Latest already hai -> 23505 -> **412 Precondition Failed**. Race mein bhi exactly ek create jeetega. (Spec ka "create-only" isi index ke upar free mil jaata hai.)

**Unversioned bucket:** purana version `is_latest = false` hote hi user ke liye gayab; uske chunks GC ke candidates (outbox -> `storage.gc`), grace period ke baad reclaim (Scenario 3).

```ts
// src/repositories/object.repository.ts (commit with retry -- simplified)
export async function commitNewVersion(meta: ObjectMeta, chunks: ChunkRef[], opts: { createOnly: boolean }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTransaction(async (tx) => {
        if (!opts.createOnly) {
          await tx.query('UPDATE objects SET is_latest = false WHERE bucket_id = $1 AND key = $2 AND is_latest', [meta.bucketId, meta.key]);
        }
        await insertObjectRow(tx, meta);                       // is_latest = true
        await insertChunksAndLocations(tx, meta.versionId, chunks);
        await outboxRepo.insert(tx, 'object.created', meta);
        return meta;
      });
    } catch (err: any) {
      const latestConflict = err.code === '23505' && err.constraint === 'ux_objects_latest';
      if (!latestConflict) throw err;
      if (opts.createOnly) throw new HttpError(412, 'PRECONDITION_FAILED');
      if (attempt >= 3) throw new HttpError(503, 'SLOW_DOWN');
    }
  }
}
```

**Code Explanation:**

- `withTransaction` -- BEGIN/COMMIT/ROLLBACK helper (Part 2). Error par rollback -- koi aadha metadata nahi bachta.
- `UPDATE ... is_latest` -- purana latest neeche. 0 ya 1 row -- dono theek.
- `insertObjectRow` -- naya version `is_latest = true`. Yahin `ux_objects_latest` check hota hai.
- `err.code === '23505' && err.constraint === 'ux_objects_latest'` -- sirf **isi** conflict par retry. Koi aur error (FK violation -- bucket beech mein delete ho gaya) upar jaaye.
- `createOnly` -> 412. Baaki -> dobara try, 3 ke baad `503 SLOW_DOWN` (spec ka hot-key error; client backoff karke retry kare).
- Chunks retry mein dobara upload **nahi** hote -- loop sirf metadata transaction ko wrap karta hai.

### Scenario 2 -- GET during PUT: kabhi aadha object nahi

Priya `main.jpg` GET kar rahi hai jab Rahul naya version PUT kar raha hai.

```
t1  PUT: chunks likhe ja rahe hain (data nodes par, metadata mein kuch nahi)
t2  GET: metadata padha -> V1 (purana) + uske chunk list -> V1 ke chunks stream
t3  PUT: metadata COMMIT -> V2 latest
t4  GET (naya): V2 milta hai
```

- GET **ek hi query** mein latest version + chunk list padhta hai -> ek consistent snapshot. Ya poora V1, ya poora V2. **Kabhi V1 ke aadhe + V2 ke aadhe chunks nahi** -- kyunki V2 ke chunks alag IDs hain aur V1 ke chunks kabhi overwrite nahi hue.
- **Commit last** hai, isliye "aadha likha object" kabhi visible nahi.
- Read-after-write: t3 ke baad jo bhi GET shuru ho, V2 dekhega -- kyunki GET primary (ya sync standby) se padhta hai, async replica se nahi.

### Scenario 3 -- DELETE during GET (aur GC ka grace period)

Priya 2 GB backup download kar rahi hai (256 chunks, ~3 minute). Minute 1 par admin ne DELETE kiya.

```
t0  GET: metadata se V1 ki 256 chunk list memory mein; streaming shuru
t1  DELETE: metadata commit (V1 gayab / delete marker). 204.
t2  GC: "V1 ke chunks ab kisi version ke nahi" -> turant data nodes se delete??
t3  GET: chunk 90 maanga -> NOT FOUND  -> download beech mein toot gaya
```

**Fix: GC grace period.** GC chunks ko metadata se unreferenced hote hi nahi mitata; unreferenced hone ke **24 hours** baad hi (spec ka orphan rule bhi 24 h hai -- ek hi number). Koi bhi GET 24 hours tak nahi chalta (API ka max stream duration/timeout isse bahut kam rakho, e.g. 1-2 hours).

- Priya ka download poora hota hai -- usne DELETE se pehle shuru kiya tha, ye "pehle ka read" hai. Consistent.
- DELETE ke **baad** shuru hua GET -> 404 (metadata turant). Strong consistency bani rehti hai.
- **Compaction bhi same logic:** compaction live chunk ko naye volume mein copy karke purana volume hataata hai. Koi read purane volume ka file descriptor khol ke padh raha ho toh? Linux par `unlink` ke baad bhi open fd se padh sakte ho; ya data node purane volume ko reference count se tab tak rakhe jab tak readers khatam na hon.

### Scenario 4 -- Multipart races

**(a) Same part do baar upload** (client retry, ya do threads):

```sql
INSERT INTO upload_parts (upload_id, part_number, size_bytes, md5_hex, chunk_ids)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (upload_id, part_number)
DO UPDATE SET size_bytes = EXCLUDED.size_bytes, md5_hex = EXCLUDED.md5_hex,
              chunk_ids = EXCLUDED.chunk_ids, created_at = now()
RETURNING (xmax = 0) AS inserted;
```

- PK `(upload_id, part_number)` -> **last one wins** (spec). Do rows kabhi nahi.
- Purane attempt ke `chunk_ids` ab kisi ke nahi -> orphan -> GC (24 h baad). Code mein upsert se pehle purane chunk_ids padh ke `storage.gc` par bhej sakte ho (fast cleanup), ya GC scan pe chhod do.
- Client ko har part ka `etag` (MD5) mila tha; complete request mein woh bhejta hai. Complete par hum **match karte hain** -- client ke paas purane attempt ka etag hai aur DB mein naya -> `400 INVALID_PART` type error. Silent galat data nahi.

**(b) Complete vs Abort ek saath:**

```sql
UPDATE multipart_uploads SET state = 'COMPLETED'
WHERE upload_id = $1 AND state = 'IN_PROGRESS'
RETURNING *;
```

Complete aur abort dono ek hi row par **conditional UPDATE** karte hain (abort `SET state = 'ABORTED'`). Row lock -> ek pehle, doosra wait -> naya version dekha -> `state` ab `IN_PROGRESS` nahi -> 0 rows. Exactly ek jeetega:

- Complete jeeta -> object commit (usi transaction mein objects + chunks + is_latest flip). Abort ko 0 rows -> jawab `204` ya `409` (policy; S3-style idempotent abort ke liye 204 theek hai, bytes delete nahi hote kyunki ab woh object ke hain).
- Abort jeeta -> complete ko **404 `NO_SUCH_UPLOAD`**. Parts ke chunks GC ko. (Wahi Payment wala "state machine + conditional UPDATE" pattern.)

**(c) Complete retried** (client ko response nahi mila, retry kiya):

- State already `COMPLETED` -> dobara object nahi banana. **Same answer** lautao: ETag deterministic hai (parts ke md5 se dobara compute, Algorithm 6) aur `versionId` ke liye upload ke saath result store hona chahiye (e.g. `multipart_uploads` par ek `completed_version_id` column -- neeche honest note). Retry ko `200` same `{ etag, versionId }`.
- Isse complete **idempotent** hai -- Payment system ka lesson: retry ko original response do, error nahi.

### Scenario 5 -- GC vs in-flight write

GC ka rule: "chunk jiska `object_chunks` mein koi reference nahi aur 24 h se purana -> orphan -> delete".

Problem: PUT ke **dauraan** chunks data nodes par likhe ja chuke hain lekin metadata commit abhi nahi hua -- un chunks ka koi reference nahi. GC ne abhi scan kiya toh?

- **Age rule bachata hai:** chunk 24 h se purana nahi -> GC chhoota nahi. Koi single PUT (max 100 MB) 24 h nahi chalta.
- **Multipart ka khatra:** multipart upload **7 din** tak IN_PROGRESS reh sakta hai (lifecycle 7 din baad abort karta hai). Uske parts ke chunks sirf `upload_parts.chunk_ids` mein referenced hain, `object_chunks` mein nahi. Toh GC ka reference check **dono** dekhe: `object_chunks` **aur** IN_PROGRESS uploads ke `upload_parts.chunk_ids`. Warna day 2 par GC ek zinda upload ke parts mita dega aur complete par corrupt object.
- **Late commit race:** GC ne chunk ko orphan maana (25 h purana) aur usi pal koi bahut late commit usi chunk ko reference kare -- practically impossible (commit se pehle PUT timeout ho chuka hota), lekin safety ke liye GC delete se pehle chunk ki location row ko `DELETED` mark kare aur commit path `chunk_locations` state `DURABLE` check kare. Belt and braces.

### Scenario 6 -- Repair worker vs node wapas aaya

```
t0   node-az2-017 ka heartbeat band (network partition)
t10m declared dead -> repair worker: uske har chunk ki nayi replica node-az2-044 par
     INSERT chunk_locations (ch_X, node-az2-044, ..., 'DURABLE')
t15m node-az2-017 wapas aa gaya -- uske paas bhi ch_X hai
     -> ch_X ab 4 replicas: az1, az2-017, az2-044, az3
```

- **PK `(chunk_id, node_id)`** -- same node par same chunk ki do rows kabhi nahi. Do repair workers ne same chunk same node par copy kiya -> `INSERT ... ON CONFLICT (chunk_id, node_id) DO NOTHING` -> ek row.
- **Over-replication** (4 copies) bug nahi, sirf extra space. Ek rebalancer/GC pass extra replica hataata hai (same AZ mein do hain toh ek). Under-replication khatarnak hai, over-replication sasta.
- Do repair workers ne same chunk ko **alag** nodes par copy kiya -> 5 copies -> wahi cleanup. Repair tasks Kafka par `chunkId` key se partition karo -> ek chunk ke tasks ek consumer ke paas -> duplicates kam.
- Wapas aaye node ke data par tab tak bharosa nahi jab tak scrubber verify na kare (partition ke dauraan disk bhi kharab hui ho sakti hai).

### Scenario 7 -- Node.js angle: streams, backpressure, memory

Ek API instance par ek saath **sau-do sau uploads** chal rahe hain. Node single-threaded hai -- phir bhi kaam chalta hai kyunki upload **I/O** hai: event loop socket se bytes padhta hai, data node ko bhejta hai; CPU sirf MD5/CRC32C par (native code, fast).

**Backpressure ka matlab:** agar data node slow hai (disk busy), toh hum client se padhna **rok dete hain**, bytes RAM mein jama nahi karte. `stream.pipeline` ye khud karta hai: jab writable ka buffer `highWaterMark` se bhar jaata hai, readable pause hota hai -> TCP window bhar jaata hai -> **client ka upload khud dheema** ho jaata hai.

**Memory per upload bounded:** hamara `StorageNodeClient.putChunk` ek `Buffer` leta hai (ek chunk) -> ek in-flight upload max **~8 MB** RAM.

```
200 concurrent uploads x 8 MB = 1.6 GB   (theek, ek 4-8 GB instance par)
1,000 concurrent uploads x 8 MB = 8 GB   (OOM ka khatra)
```

(Worst case -- 500 KB avg object ka buffer asal mein 500 KB hi hota hai.) Isliye per-instance **semaphore**: max N concurrent chunk buffers; limit par naye uploads ko `503 SLOW_DOWN` ya thoda wait. Poori file kabhi buffer nahi (`express.json()` ya `multer` memory storage upload route par **kabhi nahi**).

**Distributed lock kyun nahi chahiye?**

| Race | Kaun rokta hai |
|---|---|
| Do PUTs, same key | `ux_objects_latest` partial unique index + transaction retry (last commit wins) |
| Create-only PUT | Same index -> 23505 -> 412 |
| GET during PUT | Immutable chunks + commit last |
| DELETE during GET | GC grace period (24 h) |
| Same part twice | PK `(upload_id, part_number)` upsert |
| Complete vs abort | Conditional UPDATE on `multipart_uploads.state` |
| GC vs in-flight write | Age rule (24 h) + upload_parts reference check |
| Duplicate repair | PK `(chunk_id, node_id)` + ON CONFLICT DO NOTHING |

Data nodes par lock ki zarurat hi nahi kyunki **koi chunk kabhi overwrite nahi hota**. Metadata par Postgres constraints + row locks. Redis Redlock jaisa distributed lock ek aur failure point hota, aur uski guarantee ke liye phir bhi DB par fencing check chahiye hota (Payment Part 3 Scenario 6). **Immutability + DB constraints = locks ki zarurat khatam.**

> **Interview line:** "Data immutable hai -- har PUT naye chunk IDs likhta hai -- toh data nodes par koi race nahi; saari concurrency metadata commit par aati hai. Same key par do PUTs: dono ke chunks durable, phir commit transaction is_latest flip karta hai; partial unique index ux_objects_latest kabhi do latest nahi hone deta, loser ko 23505 milta hai aur woh transaction retry karke naye latest ko flip karta hai -- last commit wins. GET ek snapshot mein chunk list padhta hai, commit last hai, isliye kabhi aadha object nahi. DELETE ke baad GC 24 h grace deta hai taaki in-flight downloads na tootein. Multipart parts PK upsert, complete vs abort conditional UPDATE. Koi distributed lock nahi."

---

## PART 15 -- Caching: CDN, metadata cache, data node cache

### Pehle: StoreBox mein kya cache karne layak hai?

Traffic yaad karo: ~7K GET/s peak, egress 100 TB/day (~28 Gbps peak). Zyadatar reads **public product images** hain -- ek hi image lakhon log dekhte hain. Teen alag layers:

```
Browser cache  ->  CDN edge (public objects)  ->  API (in-process bucket/auth cache, optional Redis for metadata)
                                                     ->  Postgres (truth)
                                                     ->  Data node (OS page cache / SSD cache) -> HDD
```

### Layer 1 -- CDN for public objects (sabse bada win)

**CDN ka matlab:** duniya bhar mein faile edge servers jo content ki copy user ke paas rakhte hain. Mumbai ka user Mumbai edge se image leta hai, hamare origin tak request aati hi nahi.

URL Shortener se yaad karo: wahan CDN 302 redirects cache karta tha. Yahan **bytes** cache karta hai -- aur egress bill wahi bachata hai.

**Cache key:** usually `host + path` (+ chosen query params). `cdn.shopkart.com/img/products/123/main.jpg`.

**TTL aur Cache-Control** (origin header se CDN aur browser dono ko bataate hain):

```
Cache-Control: public, max-age=31536000, immutable      (versioned key -- 1 saal)
Cache-Control: public, max-age=300                       (unversioned key -- 5 min)
Cache-Control: private, no-store                         (private objects -- invoices)
```

#### Invalidation: versioned keys vs purge API

Rahul ne product photo badli. Same key `products/123/main.jpg` par naya PUT. CDN ke paas purani copy hai (TTL 1 din). Users ko purani photo dikhti rahegi.

| Approach | Kaise | Fayda | Nuksaan |
|---|---|---|---|
| **Versioned keys** (recommended) | Naya object naye naam se: `img/123.v5.jpg`; product DB mein URL update | Naya URL = naya cache key -> **turant** naya; purana `immutable` 1 saal cache | App ko URL badalna padta hai |
| **Purge API** | PUT ke baad CDN ko "is path ko hatao" (`object.created` event -> purge worker) | URL same rehta hai | Purge global propagate hone mein seconds-minutes; rate limits; purge fail hua toh stale |
| Short TTL | max-age 60 | Simple | Origin load zyada, phir bhi 60 s stale |

Versioned keys ke saath `max-age=31536000, immutable` -- CDN hit ratio 95%+ tak ja sakta hai (traffic pattern par depend). Ye pattern frontend ke `app.3f9a2c.js` jaisa hai -- content badla toh naam badla.

#### Signed URLs + CDN

Private objects (return-request photos) ke liye presigned URL: `...?X-Sbx-KeyId=..&X-Sbx-Expires=..&X-Sbx-Signature=..`. Problem: har user/har baar **alag signature** -> query string alag -> CDN cache key alag -> **har request miss**.

Options:

- Private objects ko CDN se bilkul mat bhejo (seedha origin, `Cache-Control: private`). Hamara V1 default -- private traffic chhota hai.
- CDN ko signature **verify** karne do aur cache key se signature params **nikaal do** (CloudFront signed URLs/cookies jaise CDN features publicly aisa support karte hain). Tab ek hi object sab authorized users ke liye ek cache entry.
- Kabhi mat karo: signature params hata ke cache karna **bina** CDN par verify kiye -- tab koi bhi bina signature ke cached private file le lega.

#### Stampede aur hot keys at the CDN

Ek viral product image purge hui -> duniya ke saare edges ek saath origin par miss -> **cache stampede**. Fix: CDN **origin shield** (ek beech ka tier, sab edges ussi se maangein) + **request collapsing** (same object ke 1,000 simultaneous misses -> origin par 1 request). Hot key ka asli jawab CDN hi hai -- origin tak ek image ke liye 7K/s nahi aane chahiye.

### Layer 2 -- Metadata cache

#### (a) Bucket + auth cache -- in-process

Har request par: bucket name -> bucket row (id, owner, versioning), API key -> secret/owner. Ye **rarely change** hote hain aur har request par chahiye.

- In-process LRU map, **TTL 30-60 s**. Redis ka network hop bhi nahi.
- Stale risk: bucket delete hua, cache mein abhi hai -> PUT aage badha -> metadata INSERT par `bucket_id REFERENCES buckets(id)` **FK violation** -> error. Truth DB ne bacha liya.
- API key revoke hui -> 60 s tak kaam karegi. Acceptable? Usually haan; zyada strict chahiye toh revoke par Kafka/Redis pub-sub se saare instances ko invalidate message.

#### (b) Hot object metadata in Redis -- aur read-after-write ka jaal

Idea: `GET products/123/main.jpg` ka metadata (latest version + chunk list) Redis mein 5 s TTL. Postgres load kam.

```ts
// Tempting -- lekin ye strong read-after-write todta hai
const cacheKey = `objmeta:${bucketId}:${key}`;
const cached = await redis.get(cacheKey);
if (cached) return JSON.parse(cached);
const meta = await objectRepo.findLatest(bucketId, key);
await redis.set(cacheKey, JSON.stringify(meta), 'EX', 5);
return meta;
```

**Code Explanation:**

- `cacheKey` -- bucket + key. Isme **version nahi**, yaani ye "latest kya hai" ko cache kar raha hai -- yahi problem hai.
- `redis.get` -> hit -> JSON parse -> return. Postgres skip.
- Miss -> Postgres se latest -> `SET ... EX 5` (cache-aside).

**Bug:**

```
t0  GET -> cache miss -> DB se V1 -> Redis mein V1 (5 s)
t1  PUT -> V2 commit -> client ko 200 { versionId: V2 }
t2  Same client GET -> Redis hit -> V1 !!   (abhi apni hi PUT nahi dikhi)
```

Spec strong read-after-write ka promise karta hai (S3 bhi Dec 2020 se yahi deta hai). Ye cache use tod deta hai.

"PUT par DEL kar do" bhi race rakhta hai:

```
t0  Reader: miss -> DB se V1 padha  (slow, abhi SET nahi kiya)
t1  Writer: V2 COMMIT -> redis DEL
t2  Reader: SET V1               -> ab 5 s tak stale V1
```

**Behtar design -- immutable cheezein cache karo, "latest pointer" nahi:**

- `version_id -> { size, etag, chunk list, locations }` -- ye **kabhi nahi badalta** (version immutable hai). Isko bina TTL-tension ke cache karo (in-process LRU ya Redis). Stale ho hi nahi sakta. (Sirf locations repair ke baad badal sakti hain -- stale location par read fail hoga -> CRC/timeout -> DB se fresh -> theek. Self-healing.)
- `(bucket, key) -> latest version_id` -- ye **hamesha Postgres** se (primary/sync standby, PK-style index lookup `ux_objects_latest`, ~1 ms). 7K GET/s peak, jiska bada hissa CDN le leta hai -- Postgres aaram se.

Toh V1 mein **Redis ki zarurat nahi** (spec bhi yahi kehta hai). Redis tab socho jab metadata lookups sach mein bottleneck bane -- aur tab bhi sirf immutable (version-keyed) data.

**Redis failure:** agar lagaya hai toh woh sirf cache hai -- down hua toh Postgres se padho (timeout chhota, e.g. 20 ms, phir bypass). **Fail open to DB**, kyunki truth DB hai. Lekin DB ko sudden load ke liye headroom rakho.

**Stampede on metadata:** ek hot key ka metadata miss aur 500 requests ek saath -> in-process **single-flight** (same key ka ek hi DB query, baaki uska promise await karein):

```ts
const inflight = new Map<string, Promise<ObjectMeta | null>>();
export function findLatestOnce(bucketId: number, key: string) {
  const k = `${bucketId}/${key}`;
  let p = inflight.get(k);
  if (!p) {
    p = objectRepo.findLatest(bucketId, key).finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}
```

**Code Explanation:**

- `inflight` -- is instance par abhi chal rahi DB queries, key ke hisaab se.
- `get(k)` -> already chal rahi hai -> wahi promise lautao. 500 callers, **1 query**.
- `.finally(() => inflight.delete(k))` -- query khatam (success ya error) -> map se hatao, taaki agla request fresh padhe. Yahan **koi TTL nahi** -- sirf in-flight dedupe, isliye read-after-write safe hai (promise commit ke baad shuru hua ho toh naya data).
- `get` aur `set` ke beech `await` nahi -> ek process mein atomic (event loop). Instances ke beech dedupe nahi -- zarurat bhi nahi, har instance max 1 query.

### Layer 3 -- Data node cache

- **OS page cache:** data node ki free RAM mein Linux khud recently padhe volume pages rakhta hai -- hot chunks ka dobara read disk tak jaata hi nahi. Free, automatic. Index already RAM mein (Algorithm 7), toh miss = max 1 HDD seek.
- **SSD cache tier (optional):** HDD ~100-150 random IOPS vs NVMe lakhon. Data node local LRU hot chunks ko SSD par copy kare. Chunks immutable -> **invalidation ki problem hi nahi**; delete par bas hatao.

### 304 / ETag conditional GETs

Browser ke paas image hai with `ETag: "5eb63bbb..."`. Dobara load par:

```
GET /v1/buckets/shopkart-public/objects/products/123/main.jpg
If-None-Match: "5eb63bbbe01eeed093cb22bb8f5acdc3"

-> 304 Not Modified   (koi body nahi, sirf headers)
```

- Origin sirf metadata lookup karta hai (latest ka etag) -> match -> 304. **Data nodes chhue hi nahi**, egress ~0.
- CDN bhi apni stale copy ko origin se isi tarah revalidate karta hai (TTL khatam hone par) -- poori image dobara download nahi.
- Multipart ETag (`...-2`) bhi yahan perfectly kaam karta hai -- conditional GET ke liye sirf "same ya nahi" chahiye, content MD5 hona zaruri nahi.

### Kya cache NAHI karna

| Cheez | Kyun nahi |
|---|---|
| `(bucket, key) -> latest version` TTL ke saath | Strong read-after-write tootta hai (upar ka timeline) |
| Private objects shared CDN par (bina edge-side auth) | Ek user ka invoice doosre ko |
| Presigned URL responses signature ke saath cache key mein | Har URL alag -> 0% hit, sirf CDN storage waste |
| Bade videos / backups ko API server memory mein | 1 GB x kuch requests = OOM; stream karo |
| Rarely-read cold objects ko SSD/CDN mein | Cache pollution -- hot data ko bahar dhakel dete hain |
| LIST results | Har PUT/DELETE ke saath badalta hai, strong LIST consistency ka promise hai |
| Auth decision "forever" | Revocation kabhi apply nahi hogi -- short TTL ya invalidation |

> **Interview line:** "Sabse bada cache CDN hai -- public images versioned keys ke saath, Cache-Control immutable 1 saal; photo badli toh naya URL, purge API ki zarurat nahi. Private objects CDN se nahi, ya CDN edge par signature verify kare aur signature params cache key se bahar. API mein bucket aur auth in-process 60 s cache, stale case mein FK bacha leta hai. Object metadata mein main 'latest pointer' kabhi TTL cache nahi karta -- woh read-after-write todta hai; sirf immutable version_id -> chunks cache ho sakta hai. Data nodes par page cache aur optional SSD, aur ETag par If-None-Match se 304 -- data nodes chhue bina."

---

## Remember

> **Chunks immutable hain, metadata commit hi sach hai.** 8 MB chunks, placement ring + 3 AZs, W=2 fsync, R=1 kyunki immutable; cold data 8+4 erasure coded (1.5x); durability ka asli lever **fast parallel repair** hai; CRC32C har hop par + scrubber; append-only volumes + compaction. Concurrency ke liye locks nahi -- **partial unique index + conditional UPDATEs + GC grace period**. Cache sirf immutable cheezein aur public bytes (CDN, versioned keys); "latest" hamesha Postgres se.

## Quick Self-Test

1. 1 GB object ke liye 64 KB, 8 MB aur 1 GB chunk size ka trade-off numbers ke saath batao. `Range: bytes=16000000-17999999` kaunse chunks aur offsets padhega?
2. `hash % N` mein 10 se 11 nodes par kitna data move hota hai, consistent hashing mein kitna, aur virtual nodes kya fix karte hain? Hamare design mein location DB mein hai -- phir ring ka kya role hai?
3. Reads ke liye R=1 kyun kaafi hai jab W=2 hai? XOR se D1 recover karke dikhao, aur 8+4 sirf COLD ke liye kyun?
4. Durability math mein repair window 1 hour se 24 hours hua toh kya badla, aur is math ka sabse bada jhootha assumption kya hai?
5. Do PUTs same key par ek saath commit ho rahe hain -- Postgres READ COMMITTED mein exactly kya hota hai, loser ko 23505 kyun milta hai, aur final latest kaun? Aur "latest pointer" ko Redis mein 5 s cache karna kyun galat hai?

---

**Next (Part 4):** Scaling (PBs, metadata sharding), Failures (disk/node/AZ loss, bit rot, partial uploads), Consistency, Security (signatures, encryption), Observability. "next" bolo.
