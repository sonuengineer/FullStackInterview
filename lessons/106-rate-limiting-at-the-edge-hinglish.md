# Rate Limiting App Ke Andar = Trap - Edge Par Kyun Karna Chahiye (Hinglish)

> **Builds on**: [[79-blog-rate-limiting]] (algorithms - token bucket, sliding window). Naya yahan ye hai: **rate limit lagana KAHAN hai**, aur app ke andar lagane se kya cost lagti hai.

## 1. Trap Kya Hai

Aapne `express-rate-limit` + Redis laga diya. Test mein perfect - 101st request par `429`. Phir ek scraper 40,000 req/s bhejta hai aur server phir bhi gir jaata hai. Kyun? Kyunki **429 dene se pehle aap already saara kaam kar chuke ho**.

Ek "blocked" request bhi ye sab kharcha karwa chuki hoti hai: TCP handshake (ek socket/FD), TLS handshake (CPU + 1-2 RTT), HTTP parse (headers aur body ka memory), poora middleware chain, ek Redis round trip, aur phir 429 response + log line (log pipeline, metrics cardinality).

Node single-threaded hai - har blocked request event loop ka ek slot khaati hai. Attacker ko aapne data nahi diya, par **time de diya**. Legit users usi loop ke peeche queue mein lag jaate hain, latency badhti hai, health check fail hota hai, cascade shuru ([[14-cascading-failure-recovery]]).

> In-app limiting galat nahi hai - bas **akela** kaafi nahi. Wo "fairness" tool hai, "flood defence" tool nahi.

## 2. Sahi Jawab - Layered Defence

```
Client -> [1] CDN / WAF -> [2] ALB / nginx -> [3] App (Node) -> DB
```

Rule: **jitna upar block karoge, utna sasta hai.** Layer 1 par drop ek rule match hai; layer 3 par drop poora request lifecycle hai.

## 3. Har Layer Kya Dekh Sakti Hai

| Layer | Dekhti hai | Nahi dekhti | Achhi kiske liye |
|---|---|---|---|
| CDN / WAF | IP, ASN, country, path, headers, bot score | user ID, uska plan, quota | volumetric floods, scrapers, credential stuffing |
| nginx / ALB | IP, connection count, request rate, URI | business context | burst smoothing, connection hogging, slow clients |
| App | user, API key, plan, endpoint ki cost | jo traffic pahuncha hi nahi | fair usage, quotas, billing limits |

Asli trade-off: **edge sasta hai par andha hai; app smart hai par mehnga hai.** Isliye dono chahiye.

Aur **SYN flood / L4 volumetric attack** middleware ka problem hai hi nahi - wahan HTTP request banti hi nahi. Uske liye network-layer DDoS protection (AWS Shield jaisa) chahiye. Koi Node middleware ise nahi rok sakta.

## 4. nginx Layer - Chhota Config

```nginx
limit_req_zone  $binary_remote_addr zone=perip:10m rate=10r/s;
limit_conn_zone $binary_remote_addr zone=conn_perip:10m;

server {
    location /api/ {
        limit_req      zone=perip burst=20 nodelay;   # 20 ka burst allow
        limit_req_status 429;
        limit_conn     conn_perip 20;
        limit_conn_status 429;
        proxy_pass http://app_upstream;
    }
}
```

`burst` zaroori hai - iske bina ek normal page load (parallel assets) hi 429 kha jaayega. Aur CDN/ALB ke peeche ho to `$binary_remote_addr` proxy ka IP dega - `set_real_ip_from <lb-cidr>` + `real_ip_header X-Forwarded-For` lagao, warna sab users ek hi IP ban ke ek saath block ho jaayenge.

## 5. App Layer - Business Limits

App par IP mat socho, **identity** socho: user, API key, tenant, plan.

```javascript
// Redis fixed-window counter - simple aur billing-friendly.
async function allow(redis, userId, plan) {
  const limit  = plan === 'pro' ? 1000 : 100;          // per minute
  const key    = `rl:${userId}:${Math.floor(Date.now() / 60000)}`;
  const count  = await redis.incr(key);
  if (count === 1) await redis.expire(key, 120);       // cleanup
  return { ok: count <= limit, remaining: Math.max(0, limit - count) };
}

app.use('/api', async (req, res, next) => {
  try {
    const { ok, remaining } = await allow(redis, req.user.id, req.user.plan);
    res.set('RateLimit-Remaining', String(remaining));
    if (!ok) return res.status(429).set('Retry-After', '60').json({ error: 'rate_limited' });
    next();
  } catch (err) {
    req.log.warn({ err }, 'rate limiter down - failing open');
    next();                                            // policy - section 6
  }
});
```

## 6. Redis Gir Gaya - Fail Open Ya Fail Closed?

- **Fail open** (sab allow): availability bachti hai, par attack ke waqt darwaza khula. Normal product APIs ke liye usually yahi.
- **Fail closed** (sab block): safe, par ek Redis blip = poora outage. Login, OTP, payment par theek.

Practical mix: **fail open rakho, kyunki edge limits already lagi hain** - Redis girne par bhi CDN/nginx wali mota-filter layer zinda rehti hai. Isliye layering sirf performance nahi, **resilience** ka decision hai. Limiter down ho to alert zaroor karo.

## 7. Spike vs Attack - Alag Cheezein

Traffic badhna hamesha attack nahi. Sale ka 15k RPS legit hai - usko block karna business loss hai ([[04-handling-traffic-spike-15k-rps]]). Attack -> edge par block (WAF rule, bot score, IP/ASN). Legit spike -> autoscale + cache + queue, limit nahi. Ek buggy client -> per-API-key limit app par. Mehnga endpoint (export, search) -> alag aur kam limit. Ek hi global number sab par thop dena sabse common galti hai.

## 🧠 Remember

> Block cheap and early, shape precisely and late - flood CDN/WAF aur nginx par ruke jahan drop sasta hai, aur app sirf wahi limit lagaye jo user, plan ya billing jaane bina lag hi nahi sakti.

## Quick Self-Test

1. Aapka Node app 429 de raha hai aur phir bhi CPU 100% hai. Kya ho raha hai?
2. CDN layer per-user plan quota kyun lagu nahi kar sakti?
3. Rate limiter ka Redis down hai - login endpoint aur product listing endpoint ke liye alag policy kyun chunoge?
