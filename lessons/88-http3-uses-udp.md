# Why Does HTTP/3 Use UDP Instead of TCP?

## 1. The Puzzle

TCP already gives reliability, ordering and congestion control - everything the web needs. So why would HTTP/3 build on **UDP**, which gives none of that?

**Short answer:** HTTP/3 doesn't give up reliability. It runs on **QUIC**, a new transport built **on top of UDP** that re-implements reliability and congestion control - **but better for the web** - and adds things TCP can't. UDP is just the delivery envelope that every network already allows.

## 2. Problem 1 - Head-of-Line Blocking (the big one)

HTTP/2 sends many requests (HTML, CSS, JS, images) over **one TCP connection**. TCP guarantees **one ordered byte stream**. If a single packet is lost, TCP **holds back everything after it** until that packet is re-sent - even data for completely different files.

```
HTTP/2 over TCP:   [css][js][img][css][js] ... one packet of img lost
                   -> css and js packets that arrived must WAIT too
HTTP/3 over QUIC:  each file is its own stream
                   -> only the img stream waits; css and js keep going
```

**QUIC knows about streams.** A lost packet only delays the stream it belongs to. On lossy mobile networks this makes a real difference.

**Term: Head-of-line blocking** - one delayed item at the front of a queue holding up everything behind it.

## 3. Problem 2 - Slow Connection Setup

- **TCP + TLS 1.3:** a TCP handshake (1 round trip), then a TLS handshake (1 more) -> about **2 round trips** before any data.
- **QUIC:** transport and TLS 1.3 handshakes are **combined** -> **1 round trip**, and **0 round trips** when resuming a recent connection (0-RTT).

On a 150 ms mobile connection, saving a round trip or two is very noticeable.

## 4. Problem 3 - Switching Networks Breaks TCP

A TCP connection is identified by **IP address + port**. Walk out of Wi-Fi onto 4G and your IP changes, so every connection breaks and must start over.

QUIC identifies a connection by a **connection ID**, not the IP. When your phone switches networks, the connection **continues**. This is called **connection migration**.

## 5. Problem 4 - TCP Is Stuck ("Ossified")

TCP is implemented inside **operating system kernels** and inspected by **middleboxes** (routers, firewalls, NATs) all over the internet. Changing TCP means waiting years for every OS and device to update - and many middleboxes break on anything unfamiliar.

QUIC runs in **user space** (inside the browser/app) and is **encrypted**, so middleboxes can't meddle with it. Google, Cloudflare and browsers can improve it with a normal software update.

## 6. So Why UDP Specifically?

- **You can't invent a new transport protocol on the internet** - firewalls and NATs only let TCP and UDP through reliably.
- UDP is **minimal**: it adds ports and a checksum and nothing else, so it doesn't get in QUIC's way.
- Result: QUIC gets through existing networks **and** keeps full control over reliability, ordering and congestion.

## 7. The Costs

- **More CPU:** encryption and packet handling in user space cost more than kernel TCP (improving over time).
- **Some networks block or throttle UDP** - so browsers **fall back to HTTP/2 over TCP** automatically. Servers advertise HTTP/3 with the `Alt-Svc` header.
- **Harder to debug** - everything is encrypted, so classic packet inspection sees little.
- **0-RTT data can be replayed** by an attacker - only safe for idempotent requests like GET.

## 8. In Practice

You rarely write QUIC code. You **turn it on at the edge**: CloudFront, Cloudflare and modern load balancers/servers support HTTP/3, and browsers use it automatically when available. Your Node.js app behind the CDN usually still speaks HTTP/1.1 or HTTP/2.

## 🧠 Remember

> HTTP/3 uses UDP only as an envelope; QUIC on top rebuilds reliability per stream (no head-of-line blocking), combines the handshakes (faster setup), survives network changes (connection migration), and can evolve without waiting for kernels and middleboxes.

## Self-Test

1. Why does one lost packet slow down every file in HTTP/2 but not HTTP/3?
2. What lets a QUIC connection survive a switch from Wi-Fi to 4G?
3. Why build on UDP instead of creating a brand-new protocol?

Related: [[25-api-styles-comparison]], [[78-who-resolves-the-dns-server]]
