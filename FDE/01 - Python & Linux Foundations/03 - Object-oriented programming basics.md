# Python & Linux Foundations

## Object-oriented programming basics

> Extended (slow track only) | Slow CP1 only | ~1.2 h

Python classes JS classes jaisi hi hain, bas `self` explicit hai, constructor `__init__` hai, aur "private" sirf convention (`_name`) hai.
FDE code mein OOP ka sabse common use: **client wrappers** (`CRMClient`, `LLMClient`) jo auth, retries aur timeouts ek jagah rakhte hain, aur **interfaces** (`typing.Protocol` / `abc.ABC`) taaki tests mein `FakeLLM` asli client ki jagah lag sake -- is module ke saare examples yahi karte hain.
Data ke liye class haath se mat likho: `@dataclass` ya pydantic `BaseModel` (M02-02) use karo.
Dunder methods (`__repr__`, `__eq__`, `__enter__`/`__exit__`, `__aenter__`/`__aexit__`) se objects Python ke syntax mein fit hote hain (M01-08).
Ek cheez yaad rakho: inheritance kam, composition zyada -- deep class hierarchies customer code ko samajhna mushkil bana deti hain (chhoti exception hierarchy, M01-04, theek hai).

**Try this (20-40 min):** Ek `LLMClient` `Protocol` banao (`complete(prompt) -> str`) aur uske do implementations: `FakeLLM` aur `EchoLLM`. Ek `Summarizer` class jo client constructor mein le (dependency injection), aur dono ke saath pytest se test karo.

**Read:** https://docs.python.org/3/tutorial/classes.html
