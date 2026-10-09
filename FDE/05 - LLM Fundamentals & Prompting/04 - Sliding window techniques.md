# LLM Fundamentals & Prompting

## Sliding window techniques

> Extended (slow track only) | Slow CP3 only | ~1.2 h

**Sliding window** = poori chat history ya poora document bhejne ki jagah sirf "last N turns" ya "last N tokens" ka window bhejna, aur window aage khiskate rehna.
FDE ko ye do jagah milega: lambi support chats jahan history context window se badi ho jaati hai, aur 300-page contracts jinhe overlapping chunks mein process karna padta hai (har chunk ke saath pichhle chunk ka thoda hissa, taaki sentence beech mein na kate).
Window **tokens se** naapo (M05-03), turns se nahi. System prompt aur pinned facts (customer ID, open ticket) ko window ke **bahar** hamesha rakho -- warna 20 turn baad model bhool jaata hai user kaun hai.
Tool calls ke saath: `tool_use` aur uska `tool_result` hamesha saath kaato, ek ko chhod ke doosra nahi (M05-14). Aur trimmed history `user` turn se hi shuru honi chahiye.
Yaad rakhne wali baat: sliding window sasta aur simple hai, lekin purani info hamesha ke liye gayab -- important purane facts ke liye rolling summary (M05-05) saath mein lagao.

**Try this (20-40 min):** `omniguard/window.py` mein `trim_history(messages, max_tokens, pinned)` likho jo purane turns tab tak hataye jab tak approx tokens limit ke andar na aa jaayein; pehla message hamesha `user` role ka ho aur tool_use/tool_result pair kabhi split na ho. 3 pytest cases likho.

**Read:** https://docs.anthropic.com/en/docs/build-with-claude/context-windows
