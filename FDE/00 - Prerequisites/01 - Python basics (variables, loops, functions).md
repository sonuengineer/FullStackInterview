# Prerequisites

## Python basics (variables, loops, functions)

> Diagnostic | Fast CP1 / Slow CP1 | ~15 min | Pass = move on. Fail = study only this, then re-test.

Aap JS/TS mein fluent ho, isliye yeh test sirf woh jagah check karta hai jahan Python JS se alag behave karta hai. Har sawal ka answer pehle kagaz pe likho, phir code run karo.

### Self-test (answer without looking anything up)
1. `def add(item, bucket=[]): bucket.append(item); return bucket` -- `add(1)` phir `add(2)` kya return karega? Kyun? Fix kya hai?
2. Python mein falsy values kaun si hain? (JS se compare karo: `[]` aur `{}` JS mein truthy hain -- Python mein?)
3. `a is b` aur `a == b` mein kya farak hai? `x is None` kyun likhte hain, `x == None` kyun nahi?
4. `for i, name in enumerate(names, start=1)` aur `for a, b in zip(xs, ys)` -- dono kya karte hain? `zip` lambi list ke saath kya karta hai?
5. `*args` aur `**kwargs` kya hain? Keyword-only argument kaise banate ho (hint: `def f(a, *, b)`)?

### Prove it in code
Run karne se pehle har `assert` ka result predict karo.

```python
# runnable
def add_bad(item, bucket=[]):          # default evaluated ONCE at def time
    bucket.append(item)
    return bucket

def add_good(item, bucket=None):       # the standard fix
    if bucket is None:
        bucket = []
    bucket.append(item)
    return bucket

add_bad(1)
assert add_bad(2) == [1, 2]            # shared list leaks between calls
add_good(1)
assert add_good(2) == [2]

falsy = [v for v in (0, 0.0, "", [], {}, set(), None, False) if not v]
assert len(falsy) == 8                 # empty containers are falsy in Python

a = [1, 2]; b = [1, 2]
assert a == b and a is not b           # equal value, different objects

assert list(enumerate(["x", "y"], start=1)) == [(1, "x"), (2, "y")]
assert list(zip([1, 2, 3], "ab")) == [(1, "a"), (2, "b")]   # stops at shortest

def describe(*args, sep="-", **kwargs):
    return sep.join(map(str, args)), sorted(kwargs)

assert describe(1, 2, sep="+", z=1, a=2) == ("1+2", ["a", "z"])

total = 0
for n in range(10):
    if n % 2:
        continue
    total += n
else:                                  # for-else runs when loop did not break
    total += 100
assert total == 0 + 2 + 4 + 6 + 8 + 100
print("python basics: all checks passed")
```

### Pass criteria
- Self-test mein 5 mein se kam se kam 4 sahi, aur Q1 (mutable default) bilkul sahi hona chahiye -- yeh production bug ka classic source hai.
- Code run karne se pehle saare asserts ka result sahi predict kiya (especially `for-else` aur `zip`).

### If you failed
Study: https://docs.python.org/3/tutorial/ (sections 3, 4 and 4.8 "More on Defining Functions").

30-min plan:
- 10 min -- tutorial section 4 (if/for/range/break/continue/else on loops) padho.
- 10 min -- section 4.8: default values, keyword args, `*args`/`**kwargs`, keyword-only params.
- 10 min -- upar wala block bina dekhe khud dobara likho, phir self-test re-take karo.
