# Prerequisites

## Python data types and structures

> Diagnostic | Fast CP1 / Slow CP1 | ~15 min | Pass = move on. Fail = study only this, then re-test.

LLM pipelines mein aap din bhar dicts, lists aur JSON ke saath kheloge. Yeh test check karta hai ki slicing, comprehensions aur copy semantics aapke haath mein hain ya nahi.

### Self-test (answer without looking anything up)
1. `s = "forward"` -- `s[1:4]`, `s[-3:]`, `s[::-1]` aur `s[::2]` kya denge?
2. List comprehension, dict comprehension aur set comprehension ka ek-ek example likho. Generator expression `(x for x in ...)` list se kaise alag hai?
3. `grid = [[0] * 3] * 3; grid[0][0] = 1` -- ab `grid` kaisa dikhega? Kyun?
4. `d.get("k")`, `d["k"]` aur `d.setdefault("k", [])` mein farak? Missing key pe kya hota hai?
5. Tuple kab use karoge list ki jagah? Kaun se types dict key ban sakte hain aur kyun (hint: hashable)?

### Prove it in code
Run karne se pehle har `assert` ka result predict karo.

```python
# runnable
import copy
from collections import Counter, defaultdict

s = "forward"
assert (s[1:4], s[-3:], s[::-1], s[::2]) == ("orw", "ard", "drawrof", "frad")

nums = [3, 1, 4, 1, 5, 9, 2, 6]
squares = [n * n for n in nums if n % 2 == 0]
by_parity = {n: ("even" if n % 2 == 0 else "odd") for n in nums}
uniq = {n for n in nums}
assert squares == [16, 4, 36]
assert by_parity[9] == "odd" and len(uniq) == 7

gen = (n for n in nums)
assert sum(gen) == 31 and sum(gen) == 0      # generator is exhausted after one pass

grid = [[0] * 3] * 3
grid[0][0] = 1
assert grid == [[1, 0, 0]] * 3               # same inner list repeated 3 times
safe = [[0] * 3 for _ in range(3)]
safe[0][0] = 1
assert safe[1] == [0, 0, 0]

cfg = {"model": {"name": "gpt", "temp": 0.2}}
shallow, deep = dict(cfg), copy.deepcopy(cfg)
cfg["model"]["temp"] = 0.9
assert shallow["model"]["temp"] == 0.9 and deep["model"]["temp"] == 0.2

groups = defaultdict(list)
for word in ["apple", "avocado", "banana"]:
    groups[word[0]].append(word)
assert dict(groups) == {"a": ["apple", "avocado"], "b": ["banana"]}
assert Counter("banana").most_common(1) == [("a", 3)]
assert {(1, 2): "ok"}[(1, 2)] == "ok"        # tuples are hashable, lists are not
print("data structures: all checks passed")
```

### Pass criteria
- Self-test mein 4/5 sahi; Q3 (`[[0]*3]*3` aliasing) aur shallow vs deep copy dono samajh mein aane chahiye.
- Generator ka "one pass only" behaviour aapne predict kar liya.

### If you failed
Study: https://docs.python.org/3/tutorial/ (section 3.1 strings/slicing, section 5 "Data Structures").

30-min plan:
- 10 min -- section 5.1-5.3: list methods, comprehensions, tuples.
- 10 min -- section 5.4-5.6: sets, dicts, looping techniques; `collections` docs mein `Counter` aur `defaultdict` dekho.
- 10 min -- ek JSON API response (nested dict) leke comprehension se usse flatten karo, phir self-test re-take karo.
