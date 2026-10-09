# Python & Linux Foundations

## Shell scripting basics

> Core | Fast CP1 / Slow CP1 | ~1.2 h | Builds on: M01-11, M01-13

### Kahani
Ek hospital customer har raat SFTP pe lab-results ki CSV files drop karta hai. Aapka "deploy" ek cron entry hai jo ek bash script chalati hai: files uthao, count karo, Python ingester ko do, archive karo.
Ek raat SFTP mount fail hua. Script mein `cd /mnt/drop` fail hua, lekin script chalti rahi -- aur agli line `rm -f *.csv` ne galat directory saaf kar di.
Cron ne exit code 0 report kiya, kisi ko alert nahi gaya. Teen din baad pata chala.
Teen lines (`set -euo pipefail`, `trap`, sahi exit codes) ye poora incident rok deti.

### What it is
**Shell script** ek text file hai jisme bash commands hain -- glue jo files, processes aur programs ko jodta hai (cron jobs, deploy steps, container entrypoints, CI steps).
Bash by default "errors ignore karke aage badho" mode mein chalta hai. **Strict mode** (`set -euo pipefail`) + **`trap`** (cleanup/error handler) + clear **exit codes** ise production-safe banate hain.

### Why it matters for an FDE
Customer environments mein aksar sirf SSH + bash milta hai. Entrypoint scripts, cron jobs aur one-off migration scripts aap hi likhoge -- aur silent failure wali script data delete kar sakti hai.

### Key concepts
- **`set -e`** -- koi command fail (non-zero) ho to script ruk jaaye. **`-u`** -- undefined variable = error (typo se `rm -rf "$DIRR/"` nahi chalega). **`-o pipefail`** -- pipe mein kahin bhi fail ho to poora pipe fail.
- **Exit codes** -- 0 = success, kuch bhi aur = failure; `$?` last code; `exit 2` se apna meaningful code do (cron/CI/systemd isi pe react karte hain).
- **`trap cleanup EXIT`** -- script kaise bhi khatam ho (success, error, Ctrl+C), cleanup chalega. `trap '...' ERR` -- fail hui line number log karo.
- **Quoting** -- hamesha `"$var"`; bina quotes spaces wale filenames toot jaate hain. `${1:-default}` se optional args.
- **Functions + `local`** -- chhote named steps; Python jaisa readable script.

### Code example
stdlib only (needs `bash` on PATH: Linux/macOS, or Git Bash on Windows)

```python
# runnable
import shutil
import subprocess
import tempfile
from pathlib import Path

SCRIPT = r'''#!/usr/bin/env bash
set -euo pipefail

DROP_DIR="${1:?usage: ingest.sh <drop_dir> [archive_dir]}"
ARCHIVE_DIR="${2:-$DROP_DIR/archive}"
WORK_DIR="$(mktemp -d)"

cleanup() { rm -rf "$WORK_DIR"; echo "cleanup done"; }
on_error() { echo "ERROR line $1 (exit $2)" >&2; }
trap cleanup EXIT
trap 'on_error $LINENO $?' ERR

count_rows() {
  local file="$1"
  tail -n +2 "$file" | wc -l | tr -d ' '     # skip the CSV header
}

[[ -d "$DROP_DIR" ]] || { echo "drop dir missing: $DROP_DIR" >&2; exit 2; }
mkdir -p "$ARCHIVE_DIR"

shopt -s nullglob
files=("$DROP_DIR"/*.csv)
(( ${#files[@]} > 0 )) || { echo "nothing to ingest"; exit 0; }

total=0
for f in "${files[@]}"; do
  rows="$(count_rows "$f")"
  total=$(( total + rows ))
  cp "$f" "$WORK_DIR/"
  mv "$f" "$ARCHIVE_DIR/"
  echo "ingested $(basename "$f") rows=$rows"
done
echo "TOTAL=$total"
'''

bash = shutil.which("bash")   # full path: on Windows this finds Git Bash, not System32\bash.exe (WSL)
tmp = Path(tempfile.mkdtemp())
script = tmp / "ingest.sh"
script.write_text(SCRIPT, newline="\n")

if not bash:
    print("SKIP: bash not found on PATH -- install Git Bash or run on Linux")
else:
    def run(*args):
        return subprocess.run([bash, script.as_posix(), *args], capture_output=True, text=True, timeout=15)

    syntax = subprocess.run([bash, "-n", script.as_posix()], capture_output=True, text=True)
    assert syntax.returncode == 0, syntax.stderr

    drop = tmp / "drop"
    drop.mkdir()
    (drop / "lab_a.csv").write_text("id,result\n1,ok\n2,ok\n")
    (drop / "lab b.csv").write_text("id,result\n3,high\n")   # space in name: quoting matters

    ok = run(drop.as_posix())
    print(ok.stdout)
    assert ok.returncode == 0 and "TOTAL=3" in ok.stdout and "cleanup done" in ok.stdout
    assert sorted(p.name for p in (drop / "archive").iterdir()) == ["lab b.csv", "lab_a.csv"]

    missing = run((tmp / "not-mounted").as_posix())   # the SFTP-mount-failed case
    print("missing dir ->", missing.returncode, missing.stderr.strip())
    assert missing.returncode == 2 and "cleanup done" in missing.stdout

    no_args = run()                                    # set -u + ${1:?} -> clear error
    assert no_args.returncode != 0 and "usage" in no_args.stderr

    pipe = subprocess.run([bash, "-c", "set -o pipefail; false | true"])
    assert pipe.returncode == 1                        # without pipefail this would be 0
    print("OK: strict mode, traps and exit codes behave")
```

- `set -euo pipefail` -- pehli fail hui command pe script rukti hai; undefined var pe error; `false | true` bhi fail maana jaata hai.
- `"${1:?usage...}"` -- arg missing ho to message ke saath non-zero exit. `${2:-...}` -- optional arg with default.
- `trap cleanup EXIT` -- teeno cases (success, `exit 2`, usage error) mein `cleanup done` print hua -- temp dir kabhi leak nahi hota.
- `[[ -d ... ]] || { ...; exit 2; }` -- mount fail = clear exit code 2, cron/systemd alert kar sakte hain. Kahani wala `rm` kabhi chalega hi nahi.
- `"lab b.csv"` space wala filename sirf isliye kaam karta hai kyunki har jagah `"$f"` quoted hai.
- Python side `shutil.which("bash")` full path deta hai -- Windows pe plain `"bash"` System32 wala WSL bash pakad sakta hai.

Common one-liners you will type on customer boxes:

```bash
bash -n deploy.sh && shellcheck deploy.sh     # syntax check + lint before running anything
./ingest.sh /mnt/drop; echo "exit code: $?"
crontab -l                                    # what runs on a schedule?
find /mnt/drop -name '*.csv' -mtime -1 | wc -l
grep -c ERROR /var/log/ingest.log
```

### Mini-exercise (30-60 min)
`fde-exercises/scripts/` mein `run_worker.sh` banao jo CP1 async worker (M01-07/M01-10) ka wrapper ho:
- `set -euo pipefail`, `trap` cleanup, `.env` file ho to load kare (`set -a; source .env; set +a`), required vars check (`: "${CONCURRENCY:?}"`).
- Python worker chalaye, uska exit code preserve kare, aur runtime + exit code ek log line mein likhe.
- Acceptance: `bash -n` + `shellcheck` (agar installed ho) clean; missing env var pe exit 1 with message; worker fail ho to script bhi same non-zero code de; `tests/test_run_worker.py` subprocess se teeno cases check kare.

### Common pitfalls
- Unquoted variables -- `rm -rf $DIR/*` jab `DIR` khaali ho = `rm -rf /*`. Hamesha quote + `set -u`.
- `set -e` ke bharose sab chhod dena -- `if`, `&&`, `||` ke andar wali commands aur command substitution ke kuch cases mein ye trigger nahi hota. Critical checks explicit likho.
- Secrets ko script mein hardcode karna ya `set -x` (debug trace) on rakhna jab script tokens use karti hai -- trace logs mein secret print ho jaata hai.

### Checklist before moving on
- [ ] Main `set -euo pipefail` ka har flag explain kar sakta hoon.
- [ ] Meri script `trap ... EXIT` se hamesha cleanup karti hai.
- [ ] Main meaningful exit codes deta hoon aur `$?` check kar sakta hoon.
- [ ] Maine spaces wale filenames ke saath apni script test ki hai.

### Related
- M01-13 Process monitoring
- M01-15 Environment variable configurations
- M04-09 Creating workflow YAML files (CI steps are shell scripts)
- M04-01 Writing optimized Dockerfiles (entrypoint scripts)

### Self-quiz
1. Kahani wali script mein kaunsi ek line add karne se `rm` nahi chalta, aur kyun?
2. `cmd1 | cmd2` mein `cmd1` fail hua. `pipefail` ke saath aur bina, `$?` kya hoga?
3. `trap cleanup EXIT` aur `trap cleanup ERR` mein kya fark hai? Dono kab chalenge?
4. Cron job ka script exit 0 de raha hai lekin kaam nahi hua. Kaun-kaun si cheezein check karoge?
