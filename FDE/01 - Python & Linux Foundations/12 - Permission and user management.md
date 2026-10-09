# Python & Linux Foundations

## Permission and user management

> Extended (slow track only) | Slow CP1 only | ~1.2 h

Linux mein har file ka ek owner user, ek group, aur teen permission sets hote hain: `rwx` for user / group / others -- `ls -l` mein `-rw-r-----` dikhta hai, numeric mein `640`.
FDE ko ye roz milta hai: log dir pe "Permission denied", `.env` jo world-readable hai (`chmod 600 .env`), script jo execute nahi hoti (`chmod +x run.sh`), ya service jo root se chal rahi hai.
Rule: apna service ek dedicated non-root user se chalao (`useradd --system ingest`), sirf zaroori directories uske owner banao (`chown -R ingest:ingest /srv/ingest`) -- least privilege (M03-09) ka local version.
`sudo` sirf zaroorat pe, aur customer ke server pe jo `sudo` kiya wo note karo; `id`, `groups`, `whoami` se check karo aap kaun ho.
Ek cheez yaad rakho: `chmod 777` kabhi fix nahi hai -- wo security finding hai.

**Try this (20-40 min):** Linux VM / WSL / container mein ek user `svc` banao, `/srv/demo` ka owner `svc` banao with `750`, aur ek secret file `600`. `sudo -u svc cat` aur apne user se `cat` try karo, aur har result ko `ls -l` output se explain karo.

**Read:** https://www.gnu.org/software/coreutils/manual/html_node/File-permissions.html
