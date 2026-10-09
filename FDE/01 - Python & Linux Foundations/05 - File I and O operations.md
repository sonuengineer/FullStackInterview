# Python & Linux Foundations

## File I and O operations

> Extended (slow track only) | Slow CP1 only | ~1.2 h

Customer data aksar files mein aata hai: CSV exports, JSONL logs, PDFs, SFTP drops. Python mein `with open(path, encoding="utf-8") as f:` hi standard hai -- `with` error pe bhi file close karta hai.
Bade files ko kabhi poora `read()` mat karo: line-by-line iterate karo (`for line in f`), ya `csv.DictReader` / JSONL ko stream karo -- 5 GB export bhi constant memory mein.
`pathlib.Path` use karo (`/` operator, `.glob()`, `.read_text()`), string jod ke paths mat banao -- Windows aur Linux dono pe chalega.
Hamesha `encoding` explicit do (Windows pe default UTF-8 nahi bhi ho sakta), aur writes atomic banao: temp file mein likho, phir `os.replace()` -- crash pe aadhi file nahi bachegi.
Ek cheez yaad rakho: async code mein bada file I/O bhi blocking hai -- `asyncio.to_thread` (M01-10) se bhejo.

**Try this (20-40 min):** Ek 200,000 line JSONL file generate karo, phir ek streaming script likho jo `status == "failed"` wale records ek CSV mein atomic write (temp + `os.replace`) kare. `tracemalloc` se confirm karo ki peak memory file size se bahut kam hai.

**Read:** https://docs.python.org/3/library/pathlib.html
