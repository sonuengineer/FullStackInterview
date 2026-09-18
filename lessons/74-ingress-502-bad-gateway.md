# Troubleshooting a 502 Bad Gateway From a Kubernetes Ingress

> **Connects to**: [[02-debugging-random-500-errors]] (the error may come from the layer *above* your app) and [[08-ec2-no-internet-troubleshooting]] (check each network layer in order).

## 1. What 502 Actually Means

**502 Bad Gateway** = the proxy (here, the Ingress controller, e.g. NGINX) tried to talk to the **upstream** (your Service/Pods) and got **no valid response**: connection refused, connection reset, or a garbage response.

So your app might never have seen the request. The question is: **where between Ingress and container did the connection fail?**

Related codes help narrow it down:
- **502**: upstream refused/reset/returned something invalid.
- **503**: no healthy upstream at all (often zero endpoints).
- **504**: upstream accepted the connection but was too slow (timeout).

## 2. The Path, and What to Check at Each Hop

`Client -> Ingress controller -> Service -> Endpoints -> Pod -> container port -> app`

**1. Are the pods running and ready?**
```bash
kubectl get pods -l app=myapp -o wide
kubectl describe pod <pod>        # CrashLoopBackOff? OOMKilled? readiness failing?
kubectl logs <pod> --previous     # logs from the crashed container
```
Crashing or restarting pods reset connections mid-request, a classic 502 cause.

**2. Does the Service actually point at the pods?**
```bash
kubectl get endpoints myapp-svc   # empty = selector doesn't match pod labels
kubectl describe svc myapp-svc
```
Compare the Service `selector` with the pod labels. One typo and there are no endpoints.

**3. Do the ports line up?**
Ingress `backend.service.port` -> Service `port` -> Service `targetPort` -> the port the container actually listens on. A mismatch anywhere means "connection refused."

**4. Is the app listening on the right interface?**
An app bound to `127.0.0.1` inside the container is unreachable from outside the pod. It must listen on `0.0.0.0`.

**5. Test from inside the cluster, skipping the Ingress:**
```bash
kubectl run tmp --rm -it --image=curlimages/curl -- sh
curl -v http://myapp-svc.<namespace>.svc.cluster.local:<port>/health
```
- Works here but fails via Ingress -> the problem is in Ingress config.
- Fails here too -> the problem is the Service/pod/app.

**6. Read the Ingress controller logs** - they usually say exactly what happened:
```bash
kubectl logs -n ingress-nginx deploy/ingress-nginx-controller | grep 502
```
Look for `connect() failed (111: Connection refused)`, `upstream prematurely closed connection`, or `upstream sent too big header`.

**7. Protocol mismatch.** The backend serves HTTPS but the Ingress sends HTTP (or gRPC vs HTTP). Fix with the right backend-protocol annotation.

**8. Keep-alive timeout mismatch (intermittent 502s).** If the app closes idle connections sooner than the Ingress expects, the Ingress sometimes reuses a connection the app just closed -> reset -> 502. Make the app's keep-alive timeout **longer** than the proxy's.

**9. Headers too big.** Large cookies/JWTs overflow the proxy buffer -> "upstream sent too big header." Increase proxy buffer size.

**10. Deployments and scaling.** 502s only during rollouts means pods are killed while still serving traffic: add readiness probes, a `preStop` sleep, and graceful shutdown so in-flight requests finish.

## 3. Mental Model

> A 502 is the Ingress saying "I called your service and got nonsense or nothing." Walk the chain hop by hop - pods, endpoints, ports, bind address, protocol, timeouts - and test from inside the cluster to split "Ingress problem" from "app problem."

## 4. 🧠 Remember

> For an Ingress 502, check pod health and restarts, Service endpoints and selectors, the full port chain, the app's bind address, and the controller logs - and if the 502s are intermittent, suspect keep-alive mismatches or ungraceful pod shutdowns during deploys.

## 5. Quick Self-Test

1. How do 502, 503, and 504 differ in what went wrong upstream?
2. Why does an app listening on `127.0.0.1` cause failures only when called from outside the pod?
3. Why can a keep-alive timeout mismatch cause random, occasional 502s?
