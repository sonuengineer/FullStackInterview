# Containerization & CI-CD

## Load balancer integration

> Extended (slow track only) | Slow CP6 only | ~1.2 h

**Application Load Balancer (ALB)** public subnet mein baithta hai, HTTPS (ACM certificate) terminate karta hai, aur traffic **target group** ko bhejta hai jisme ECS tasks ke private IPs (`target_type = ip`, kyunki Fargate `awsvpc` hai) register hote hain.
ECS service ka `loadBalancers` block container name + port ko target group se jodta hai; deploy pe ECS naye tasks register aur purane **deregister** karta hai.
FDE ko ye milta hai jab customer bolta hai "deploy pe 502 aate hain" -- aksar wajah: target group health check path galat (`/` jo 404 deta hai), ya **deregistration delay** (default 300 s) aur app ka graceful shutdown match nahi karte.
Security groups (M03-08): ALB SG internet se 443 allow kare; task SG sirf ALB SG se port 8000 allow kare -- kabhi `0.0.0.0/0` se nahi.
Ek baat yaad rakho: **target group health check `/readyz` pe, container healthCheck `/healthz` pe** -- readiness traffic decide karta hai, liveness restart (M04-13).

**Try this (20-40 min):** OmniGuard ke liye `docs/alb.md` mein ek table banao: listener (443 -> target group, 80 -> redirect 443), target group settings (path `/readyz`, matcher 200, interval 15 s, healthy threshold 2, deregistration delay 30 s), aur dono security group rules. Phir likho ki `deregistration_delay` aur uvicorn `--timeout-graceful-shutdown` ka relation kya hai.

**Read:** https://docs.aws.amazon.com/AmazonECS/latest/developerguide/alb.html
