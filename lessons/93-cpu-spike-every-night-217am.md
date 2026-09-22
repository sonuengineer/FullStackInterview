# CPU Hits 100% Every Night at 2:17 AM. No Cron, No Deploy, No Traffic Spike.

> **Similar-question flag**: the method is the checklist from [[20-sudden-latency-spike-checklist]] and the "load = requests x cost per request" idea from [[58-less-traffic-more-cpu]]. What's new here is the clue that matters most: it repeats at a **fixed time**, which means something *scheduled* - just not scheduled where you looked.

## 1. The Clue Is the Clock

Anything that happens at the same minute every night is on a timer. "No cron jobs" usually means **no cron jobs in your application repo**. Timers live in many other places.

The odd minute matters too: `2:17` is not a human choice like `2:00`, so it smells like a job started at an offset, a staggered fleet-wide schedule, or a job that begins earlier and *reaches* your service at 2:17.

## 2. Where the Timer Is Hiding

**On the machine itself**
- OS-level `cron` / `systemd` timers on the server (`crontab -l`, `sudo crontab -l`, `ls /etc/cron.*`, `systemctl list-timers`) - log rotation, package updates, antivirus or security scans, certificate renewal.
- Backup agents and snapshot tools (EBS snapshots, Velero), which can hammer disk and CPU.
- Container platforms: a Kubernetes **CronJob** (possibly in another namespace) landing on the same node.

**In the database**
- Autovacuum / `ANALYZE` (Postgres), `OPTIMIZE TABLE`, index rebuilds, statistics jobs.
- A scheduled dump/backup, a read replica catching up, or a nightly reporting/ETL query run by the analytics team.
- **TTL/expiry sweeps** - a "delete old rows" job doing exactly what [[03-ttl-deletion-at-scale]] warns about.

**In your own stack, but not called "cron"**
- `setInterval` in a long-running Node process, a BullMQ/Agenda **repeatable job**, a cache warmer.
- **Synchronized expiry**: connections or cache entries created together expire together ([[16-synchronized-connection-pool-expiry]]) - a nightly restart makes them all line up at the same minute forever after.
- Certificate/token refresh, feature-flag or config polling that fans out.

**Outside your company**
- A partner or client system pulling a nightly export, a scraper on a schedule, or a cloud provider maintenance window.

## 3. How to Find It (in Order)

1. **Confirm the pattern**: is it exactly daily? Same minute? Every host or one host? (One host = a local timer. All hosts = something shared, like the database or an external caller.)
2. **Profile during the window** - this is the fastest answer. Capture a CPU profile or flame graph at 2:17 (`node --cpu-prof`, `perf`, or your APM's profiler) and see the function names.
3. **Check the boring lists**: `systemctl list-timers`, `crontab -l` for every user, `kubectl get cronjobs -A`, database scheduled jobs.
4. **Correlate**: do logs, DB connections, disk I/O, or network bytes also spike? High CPU with high disk I/O suggests backup/vacuum; high CPU with no I/O suggests computation or GC.
5. **Check GC and memory**: a nightly memory peak can trigger heavy garbage collection ([[22-nodejs-memory-leak-debugging]]).

## 4. Mental Model

> A spike at the same minute every night is never random - it's a schedule you don't own yet. Your job is to find whose timer it is: the OS, the database, a library inside your app, or someone outside.

## 5. What to Do Once You Find It

- **Move it** to a genuinely quiet time, or spread it out with **jitter** so it doesn't align with everything else.
- **Throttle it**: batch with sleeps, lower its priority, or run it on a separate instance/replica so user traffic isn't affected.
- If it's a legitimate job that must run, **scale for it** or accept it and make sure alerts don't fire on a known window.

## 6. 🧠 Remember

> An exact repeating time means a schedule, so if your app has no cron, look at the OS timers, the database's own maintenance, scheduled jobs inside your process, and outside callers - then profile during the window to name the exact function.

## 7. Quick Self-Test

1. Why does "it happens on every host" point somewhere different than "it happens on one host"?
2. Why is a CPU profile taken during the spike more useful than reading code beforehand?
3. Name two schedulers that exist outside your application repo but can still peg your CPU.
