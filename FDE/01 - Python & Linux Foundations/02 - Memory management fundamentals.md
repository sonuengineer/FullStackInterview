# Python & Linux Foundations

## Memory management fundamentals

> Extended (slow track only) | Slow CP1 only | ~1.2 h

CPython memory ko **reference counting** se manage karta hai: jab kisi object ka last reference khatam, wo turant free. Cycles (A -> B -> A) ke liye ek **cyclic garbage collector** (`gc` module) periodically chalta hai.
Variables "boxes" nahi, "labels" hain -- `b = a` copy nahi banata, same list ko doosra naam deta hai. JS objects jaisa hi behaviour.
FDE ko ye tab milta hai jab worker ka RSS din-ba-din badhta hai (M01-13): aksar kaaran ek module-level cache/list jo kabhi clear nahi hoti, ya poori file `read()` karke memory mein rakhna.
Tools: `sys.getsizeof` (shallow size), `tracemalloc` (kaunsi line memory allocate kar rahi hai), aur generators (`yield`) se bade data ko stream karna.
Ek cheez yaad rakho: Python mein "leak" aksar GC bug nahi hota -- koi reference abhi bhi zinda hai.

**Try this (20-40 min):** `tracemalloc.start()` karke ek function likho jo har call pe ek global list mein 1 MB jodta hai; 50 calls ke baad `tracemalloc.take_snapshot().statistics("lineno")[:3]` print karo aur leak wali line dhoondo. Phir generator version likho jo memory flat rakhe.

**Read:** https://docs.python.org/3/library/tracemalloc.html
