# Python & Linux Foundations

## Python Core data structures

> Extended (slow track only) | Slow CP1 only | ~1.2 h

`list`, `dict`, `set`, `tuple` -- inhi chaar pe aapka 90% FDE code chalta hai: API JSON (`dict` of `list`s), IDs ka dedupe (`set`), fixed records (`tuple`, `NamedTuple`, `dataclass`).
JS se compare: `dict` ~ object/`Map` (insertion order preserved), `list` ~ array, `set` ~ `Set`. Fark: `dict` keys hashable honi chahiye (list key nahi ban sakti), aur `tuple` immutable hai.
Customer data pe performance yahin bigadti hai: `if x in big_list` O(n) hai, `if x in big_set` O(1) -- 1 lakh records ke dedupe mein minute vs millisecond.
`collections` module bhi jaano: `defaultdict` (group by), `Counter` (frequency), `deque` (queue / sliding window).
Ek cheez yaad rakho: mutable default argument (`def f(x=[])`) har call mein ek hi list share karta hai -- classic bug.

**Try this (20-40 min):** 50,000 fake ticket dicts banao (`id`, `customer`, `priority`). `Counter` se priority count, `defaultdict(list)` se customer-wise group, aur `list` vs `set` membership ko `timeit` se compare karo.

**Read:** https://docs.python.org/3/tutorial/datastructures.html
