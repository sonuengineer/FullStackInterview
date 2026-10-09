# Python & Linux Foundations

## Navigating the file system

> Extended (slow track only) | Slow CP1 only | ~1.2 h

Customer ke Linux server pe SSH karte hi pehla sawaal: "main kahan hoon aur cheezein kahan hain?" -- `pwd`, `ls -la`, `cd`, `find`, `du -sh`, `df -h`.
Linux layout yaad rakho: `/etc` (config), `/var/log` (logs), `/opt` ya `/srv` (apps), `/tmp` (temp), `/home/<user>`, aur `/proc` (running processes ki info, M01-13).
Absolute path (`/var/log/app.log`) vs relative path (`./logs`) -- cron aur systemd ka working directory aksar wo nahi hota jo aap sochte ho, isliye scripts mein absolute paths ya `cd "$(dirname "$0")"` use karo (M01-14).
Disk full hona classic outage hai: `df -h` (kaunsa mount full), `du -sh /var/log/* | sort -h` (kaun jagah kha raha hai).
Ek cheez yaad rakho: `rm -rf` se pehle `pwd` aur `ls` -- hamesha.

**Try this (20-40 min):** Git Bash, WSL ya kisi Linux VM mein: `find / -name "*.log" -size +10M 2>/dev/null`, `du -sh ~/* | sort -h | tail`, `df -h`. Phir ek folder tree banao aur `find . -mtime -1 -type f` se aaj modified files dhoondo.

**Read:** https://www.gnu.org/software/findutils/manual/html_mono/find.html
