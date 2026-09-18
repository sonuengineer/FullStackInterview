# You Pushed a Secret to a Public Git Repository. What Now?

## 1. Story

You push a commit. Two minutes later you notice `.env` was included: a production database password and an AWS access key, now sitting in a **public** repository.

## 2. The Most Important Fact

**Assume it's already stolen.** Bots scan public GitHub pushes continuously, and leaked cloud keys are often abused within **minutes** (commonly to spin up crypto-mining servers on your bill). Deleting the file or the commit does **not** undo that: the commit stays in history, forks and clones already have it, and scanners already copied it.

So the order matters: **make the secret useless first, clean up second.**

## 3. The Response, in Order

**1. Revoke and rotate immediately.**
- Cloud keys: deactivate/delete the key in AWS IAM (or equivalent), create a new one.
- Database passwords, API tokens, OAuth secrets, webhook secrets: rotate them all.
- Deploy the new secrets to the systems that need them.

This is the step that actually stops the damage. Everything else is cleanup.

**2. Check for misuse.**
Look at cloud audit logs (e.g. CloudTrail), billing, database access logs, and API provider dashboards for activity since the push. If something was accessed, it becomes a security incident: follow your company's incident process.

**3. Remove it from Git history.**
- Use `git filter-repo` (or BFG Repo-Cleaner) to strip the file/string from **all** commits, then force-push.
- Ask collaborators to re-clone.
- Contact GitHub Support to purge cached views and pull-request references if needed.
- Remember: this reduces future exposure, but **it doesn't un-leak** what's already copied.

**4. If it was personal data, not just credentials**, involve security/legal: data-protection laws may require notifying users or regulators within a deadline.

**5. Prevent it next time.**
- `.gitignore` for `.env` and key files, plus a `.env.example` with fake values.
- **Pre-commit secret scanning** (gitleaks, detect-secrets) and **GitHub push protection / secret scanning**, which block the push before it lands.
- Store secrets in a **secrets manager** (AWS Secrets Manager, Vault, Doppler) instead of files.
- Prefer **short-lived credentials** (IAM roles, OIDC for CI) over long-lived keys, so a leak expires by itself.

## 4. Mental Model

> A leaked secret is a lost house key. Deleting your photo of the key from Instagram doesn't help - someone already has a copy. Change the lock first, then clean up the photo.

## 5. Common Mistakes

- Deleting the file in a new commit and calling it fixed (it's still in history).
- Rewriting history but never rotating the key.
- Making the repo private and assuming that undoes the exposure.

## 6. 🧠 Remember

> Rotate first, investigate second, scrub history third, and prevent it with secret scanning, a secrets manager, and short-lived credentials - because a secret that hit a public repo must be treated as compromised.

## 7. Quick Self-Test

1. Why is rotating the secret more important than deleting the commit?
2. Why doesn't making the repository private fix the leak?
3. What two tools or practices stop this from happening again?
