# Cloud Fundamentals & Networking

## Navigating the AWS Billing console

> Extended (slow track only) | Slow CP6 only | ~1.2 h

**Billing and Cost Management** console woh jagah hai jahan "paisa kahan gaya" ka jawab milta hai: **Bills** (mahine ka invoice, service + region ke breakdown ke saath), **Cost Explorer** (graphs, group by service / usage type / tag), **Budgets** (M03-13), aur **Cost allocation tags**.
FDE isse tab milta hai jab customer ka FinOps puchhe "OmniGuard ka kharcha kitna hai?" -- jawab sirf tab de paoge jab aapke resources pe `Project=omniguard` tag ho aur woh tag Billing mein **cost allocation tag** ke roop mein activate ho (activation ke baad hi data aana shuru hota hai, purana nahi).
Cost Explorer mein **Usage type** group-by sabse useful hai: `NatGateway-Bytes`, `DataTransfer-Out-Bytes`, `TimedStorage-ByteHrs` jaise lines seedha batati hain ki NAT (M03-07), egress ya S3 (M03-02) mein kya badha.
Yaad rakho: customer account mein Billing access by default IAM users/roles ko nahi milta -- aapke role ko alag se permission chahiye, aur aksar sirf management (payer) account mein poora data hota hai.

**Try this (20-40 min):** Apne sandbox mein 2-3 resources pe `Project=omniguard` tag lagao, Billing -> Cost allocation tags mein activate karo, aur Cost Explorer mein last 30 din ka cost "Group by: Usage type" aur "Filter: Region" ke saath dekho. Top 3 usage types aur unka matlab `omniguard/infra/cost-notes.md` mein likho.

**Read:** https://docs.aws.amazon.com/cost-management/latest/userguide/ce-what-is.html
