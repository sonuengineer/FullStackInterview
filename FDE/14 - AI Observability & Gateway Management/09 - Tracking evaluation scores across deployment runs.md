# AI Observability & Gateway Management

## Tracking evaluation scores across deployment runs

> Extended (slow track only) | Slow CP10 only | ~1.2 h

Eval score (M14-05..08) ek baar nikalna kaafi nahi -- har deploy ke saath wahi eval set chalao aur result ko **run metadata** ke saath store karo: git sha, prompt version, model id, retriever config, dataset version, date.
Tab aap customer ko graph dikha sakte ho: "release 14 pe faithfulness 0.91 se 0.84 gira, aur ye prompt v7 ki wajah se hua." Bina metadata ke score sirf ek number hai, debugging ka saboot nahi.
FDE ko ye CI mein milta hai: PR pe eval chale, pichhle `main` run se compare ho, aur drop threshold se zyada ho to merge block.
Dhyan rakho: dataset version badla to purane scores se seedha compare mat karo -- apples vs oranges. Aur LLM judges noisy hain, isliye chhote differences (1-2 points) ke liye confidence interval ya repeated runs dekho.
Ek baat yaad rakho: **score + exact config jo usse produce kiya** -- dono saath store, warna trend line jhooth bolti hai.

**Try this (20-40 min):** Ek `eval_runs.sqlite` table banao (run_id, git_sha, prompt_v, model, dataset_v, metric, value). Do fake runs insert karo aur ek script likho jo latest vs previous compare kare aur 0.03 se zyada drop pe exit code 1 de.

**Read:** https://langfuse.com/docs
