# Prerequisites

## Git basics (clone, commit, push, pull)

> Diagnostic | Fast CP1 / Slow CP1 | ~15 min | Pass = move on. Fail = study only this, then re-test.

Customer ke laptop ya jump box pe aapke paas sirf terminal hoga, koi GUI nahi. Yeh test check karta hai ki working tree, staging area aur remote ka mental model clear hai.

### Self-test (answer without looking anything up)
1. Working tree, staging area (index) aur local repo -- `git add`, `git commit`, `git push` har ek kis cheez ko kahan le jaata hai?
2. `git pull` actually kin do commands ka combination hai? `git fetch` akela kab safer hai?
3. Galti se `.env` commit ho gaya (push nahi hua). Last commit se kaise hataoge aur dobara kaise rokoge? Agar push ho gaya tha to sabse pehla kaam kya hai?
4. `git status`, `git diff`, `git diff --staged` aur `git log --oneline` -- har ek kya dikhata hai?
5. `git push` "rejected (fetch first)" de raha hai. Kyun, aur kya karoge?

### Prove it in code
Yeh script ek temp folder mein fake "remote" (bare repo) aur do clones banati hai -- aapke kisi real repo ko touch nahi karti. Predict karo: Bob ke pull ke baad `notes.txt` mein kya hoga?

```python
# runnable
import pathlib, subprocess, tempfile

def git(*args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, check=True,
                          capture_output=True, text=True).stdout.strip()

with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    git("init", "--bare", "-b", "main", "remote.git", cwd=root)
    for who in ("alice", "bob"):
        git("clone", "remote.git", who, cwd=root)
        for k, v in (("user.name", who), ("user.email", f"{who}@example.com"),
                     ("commit.gpgsign", "false")):
            git("config", k, v, cwd=root / who)       # local config only, temp repo
    alice, bob = root / "alice", root / "bob"

    (alice / "notes.txt").write_text("hello\n")
    assert "?? notes.txt" in git("status", "--porcelain", cwd=alice)   # untracked
    git("add", "notes.txt", cwd=alice)
    assert "A  notes.txt" in git("status", "--porcelain", cwd=alice)   # staged
    git("commit", "-m", "add notes", cwd=alice)
    git("push", "-u", "origin", "main", cwd=alice)

    git("pull", "origin", "main", cwd=bob)            # fetch + merge
    assert (bob / "notes.txt").read_text() == "hello\n"
    assert git("log", "--oneline", cwd=bob).endswith("add notes")
    print("git basics: all checks passed")
```

### Pass criteria
- Self-test mein 4/5 sahi; Q3 mein "leaked secret ko pehle rotate karo, phir history saaf karo" aaya.
- Script ka flow (untracked -> staged -> committed -> pushed -> pulled) aap bina dekhe kagaz pe draw kar sakte ho.

### If you failed
Study: https://git-scm.com/book/en/v2 (chapter 2 "Git Basics", sections 2.1-2.5).

30-min plan:
- 15 min -- chapter 2.2 (recording changes) aur 2.5 (working with remotes).
- 5 min -- `.gitignore` section padho, ek `.gitignore` likho jo `.env` aur `venv/` ko ignore kare.
- 10 min -- upar wali script ko modify karo: Bob ek change push kare, Alice pull kare; phir re-test.
