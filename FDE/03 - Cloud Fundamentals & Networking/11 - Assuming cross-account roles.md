# Cloud Fundamentals & Networking

## Assuming cross-account roles

> Extended (slow track only) | Slow CP6 only | ~1.2 h

Customer aapko apne account ka IAM user ya access key nahi dega -- woh apne account mein ek **role** banayega jiski trust policy aapke account (ya aapke specific role) ko `sts:AssumeRole` allow karti hai. Aap apne credentials se `AssumeRole` call karte ho aur 1 ghante jaise short-lived temporary credentials milte hain.
Third-party vendor ke liye customer aksar **ExternalId** condition maangta hai -- "confused deputy" problem rokne ke liye, taaki koi aur aapke account ke through unka role na pehen sake.
FDE ke liye yahi normal din hai: dev ke liye ek role, prod ke liye read-only role, aur har role ka session CloudTrail mein aapke naam (`--role-session-name`) se dikhta hai.
Yaad rakhne wali baat: **long-lived access keys share karna kabhi solution nahi** -- role + trust policy + short session hi standard hai, aur trust policy mein `"AWS": "*"` kabhi nahi.

```bash
aws sts assume-role \
  --role-arn arn:aws:iam::444455556666:role/OmniGuardDeployer \
  --role-session-name sonu-fde-omniguard \
  --external-id omniguard-acme-7f3k \
  --duration-seconds 3600
# Or in ~/.aws/config: [profile acme-dev] role_arn=... source_profile=default external_id=...
aws sts get-caller-identity --profile acme-dev
```

**Try this (20-40 min):** Apne do free sandbox accounts (ya AWS Organizations ke 2 member accounts) mein account B mein `ReadOnlyAccess` wala role banao jiski trust policy sirf account A ke ek role + ExternalId allow kare. `~/.aws/config` mein profile banao, `get-caller-identity` chalao, phir ExternalId hata ke dekho ki fail hota hai. Result `omniguard/infra/iam/cross-account.md` mein likho.

**Read:** https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_common-scenarios_third-party.html
