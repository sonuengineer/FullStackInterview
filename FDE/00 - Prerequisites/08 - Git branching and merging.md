# Prerequisites

## Git branching and merging

> Diagnostic | Fast CP1 / Slow CP1 | ~15 min | Pass = move on. Fail = study only this, then re-test.

Customer ki team aur aap ek hi repo pe kaam karoge, aksar ek hi file pe (prompt templates, config). Conflicts aayenge hi. Yeh test check karta hai ki aap bina panic kiye unhe resolve kar sakte ho.

### Self-test (answer without looking anything up)
1. Fast-forward merge kab hota hai aur kab merge commit banta hai? `--no-ff` kyun use karte hain?
2. `git merge main` vs `git rebase main` (feature branch pe) -- history mein kya farak dikhega? Shared/pushed branch ko rebase kyun nahi karna chahiye?
3. Merge conflict aaya. Steps likho: file mein markers (`<<<<<<<`, `=======`, `>>>>>>>`) ka kya matlab hai, resolve ke baad kaun se commands chalaoge? Beech mein abort kaise karoge?
4. `git switch -c feat/x`, `git branch -d` vs `git branch -D` -- kya karte hain?
5. Rebase ke baad push reject hua. `--force` aur `--force-with-lease` mein farak kya hai, aur kaunsa use karoge?

### Prove it in code
Script temp folder mein ek naya repo banati hai (real repos untouched). Predict karo: merge ke baad `config.txt` mein kya hoga, aur rebase ke baad history linear hogi ya nahi?

```python
# runnable
import pathlib, subprocess, tempfile

with tempfile.TemporaryDirectory() as tmp:
    repo = pathlib.Path(tmp)
    def git(*a, ok=True):
        r = subprocess.run(["git", *a], cwd=repo, capture_output=True, text=True)
        assert (r.returncode == 0) == ok, r.stderr
        return r.stdout.strip()
    def commit(name, text, msg):
        (repo / name).write_text(text); git("add", name); git("commit", "-m", msg)

    git("init", "-b", "main")
    for k, v in (("user.name", "fde"), ("user.email", "fde@example.com"), ("commit.gpgsign", "false")):
        git("config", k, v)                      # local config of the temp repo only
    commit("config.txt", "model=small\n", "init")

    git("switch", "-c", "feat/model"); commit("config.txt", "model=large\n", "use large")
    git("switch", "main");             commit("config.txt", "model=medium\n", "use medium")

    git("merge", "feat/model", ok=False)         # both changed the same line -> conflict
    assert "<<<<<<<" in (repo / "config.txt").read_text()
    (repo / "config.txt").write_text("model=large\n")   # resolve: pick the right value
    git("add", "config.txt"); git("commit", "--no-edit")
    assert len(git("log", "-1", "--format=%P").split()) == 2   # merge commit has 2 parents

    git("switch", "-c", "feat/docs", "HEAD~1")   # branch from before the merge
    commit("README.md", "docs\n", "add docs")
    git("rebase", "main")                        # replay feat/docs on top of main
    assert git("log", "--merges", "--oneline", "main..feat/docs") == ""   # linear on top
    assert git("merge-base", "main", "feat/docs") == git("rev-parse", "main")
    print("branching: all checks passed")
```

### Pass criteria
- Self-test mein 4/5 sahi; Q3 mein `git add <file>` + `git commit` (ya `git merge --continue`) aur `git merge --abort` dono aaye.
- Q5 mein `--force-with-lease` chuna, aur reason bata paaye (doosre ka push overwrite nahi hoga).

### If you failed
Study: https://git-scm.com/book/en/v2 (chapter 3 "Git Branching": 3.1, 3.2, 3.6 Rebasing).

30-min plan:
- 10 min -- 3.2 "Basic Branching and Merging", especially "Basic Merge Conflicts".
- 10 min -- 3.6 "Rebasing" aur "The Perils of Rebasing".
- 10 min -- upar wali script mein conflict ko `git merge --abort` se cancel karke dekho, phir rebase ke saath conflict create karke `git rebase --continue` try karo; phir re-test.
