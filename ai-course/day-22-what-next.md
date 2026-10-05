# Day 22 — What Next

**Not in the syllabus.** The course is 21 days and you have finished it. This is the part nobody writes: where you actually stand, and what to do on Monday.

---

## 1. Where you actually are

Be accurate about this, in both directions.

**What you can genuinely do now:**

- Build an agent from nothing, with no framework, and explain every line
- Read framework code and say what it is doing underneath
- Build a RAG pipeline and **measure** whether it is any good
- Recognise when a task needs an agent and when it needs one API call
- Find the security holes in an agent system, including your own
- Put a number on what your system costs and how often it works
- Deploy it and hand it to someone else

**What you cannot do yet, and should not claim:**

- You have not run anything at scale. Fifty users behaves differently from two.
- You have not operated a system for months. Drift, stale indexes and creeping cost are things you have read about, not survived.
- You have used one model family on one free tier. Model differences are real and you have not felt them.
- You have not worked inside someone else's large codebase, which is what most of this work actually is.

**The most valuable thing you have is not on either list.** It is the habit: build it by hand, measure it, look at the raw output, be honest about what failed. That habit outlasts every library named in this course, and it is the thing most people skip.

---

## 2. Test whether the six primitives really landed

Day 0 said the twenty-one topics were really six ideas. Answer these out loud, with no notes. If you cannot, the day to revisit is named.

1. **The call.** What does the model do and what does your code do? *(Day 1, 4)*
2. **State.** Where is the conversation stored, and why does it grow so fast? *(Day 2, 11)*
3. **Instruction.** Why does "at most 3 sentences" beat "don't be verbose"? *(Day 3)*
4. **Tools.** Walk the full tool-call cycle. How many API calls, and who runs the function? *(Day 4)*
5. **Retrieval.** Why does a keyword search fail on synonyms, and why does vector search fail on invoice numbers? *(Day 5, 6, 12)*
6. **The loop.** What single change turns a chatbot into an agent, and why is stopping the hard part? *(Day 7, 9)*

And three that matter as much:

7. Why can the agent not be the judge of its own success? *(Day 9)*
8. Why can prompt injection not be fixed the way SQL injection was? *(Day 13)*
9. Why does a single test run tell you almost nothing? *(Day 15)*

**Anything you fumbled, go back to that day and redo the experiments.** Not the reading — the experiments. That is where the understanding lives.

---

## 3. What to build next

Three projects, increasing in difficulty. Pick one and finish it.

**1. Something for yourself, used daily (one week)**

Not a demo. Something you actually use: your email triaged, your reading queue summarised, your bank statements categorised, your notes searched properly.

**Using your own thing daily is the fastest teacher available.** You will find failures no eval set contains, because real use is messier than any test you would write.

**2. Something for one other person (two to three weeks)**

Pick someone with a real repetitive problem — a teacher, a small business, a researcher — and build the narrow thing that solves it.

This is harder than it sounds, and the difficulty is instructive: they do not know what an agent is, they do not care, and they will use it in ways you did not plan. Building for a real user teaches product judgement, which is the thing engineers in this field most often lack.

**3. Something genuinely hard (a month or more)**

Choose one:

- **An agent that writes and runs code**, in a sandbox, with tests as verification. Verification is easy here — the tests pass or they do not — which makes it an excellent place to study agent reliability properly.
- **A voice agent.** Real-time changes everything: latency budgets in hundreds of milliseconds, interruption handling, streaming throughout.
- **An evaluation harness for agents**, properly. Less glamorous, in short supply, and the skill people actually pay for.
- **A local-only agent.** Everything on your machine, no API. You will learn what the big models were doing for you.

---

## 4. What to learn next, in order

**First: evaluation, seriously.** You built a 15-question golden set and a 10-task eval. That was the beginner version. Learn about proper test set construction, inter-rater agreement, judge calibration, and statistical significance for small samples. **This is the highest-leverage skill in applied AI right now** and the one most teams are worst at.

**Second: cost and latency at scale.** Prompt caching, batch APIs, model distillation, routing hierarchies, streaming architecture. You measured your costs; now learn to move them by an order of magnitude.

**Third: agent security, properly.** Day 13 was an introduction. Read the current literature on indirect prompt injection and agent sandboxing. It is an unsolved problem, which makes it a good place to be useful.

**Fourth, only if you need it: fine-tuning.** Most people reach for it too early. The honest rule: try prompting, then few-shot, then RAG, then a better model, and only then fine-tune. Fine-tuning teaches style and format well; it teaches facts badly, and RAG does that job better.

**Also worth your time:** structured output and constrained decoding, multimodal input (documents as images often beats text extraction), and async Python properly, since you met it several times and skated past it.

---

## 5. How to stay current without drowning

The field produces enormous noise. Most of it will not matter in six months.

**What actually matters:**

- Model releases that change capability meaningfully — a few a year, not weekly
- New primitives — tool use, MCP and structured output were real. Most named techniques are not.
- Cost changes. An order-of-magnitude price drop changes what is buildable.

**What does not:**

- Prompt tricks with names
- Benchmark leaderboard movements
- Framework feature announcements
- Almost every thread beginning "this changes everything"

**A sustainable habit:** read the model providers' own docs and release notes directly. Follow a small number of practitioners who ship things. Skim one paper a week, properly, rather than fifty abstracts. Ignore everything else and you will lose nothing.

**And the test to apply:** when you read about a new technique, ask "what does this replace in what I built?" If you cannot answer, it is probably a rename of something you already know. A striking number of them are.

---

## 6. Keeping your project alive

If you stop touching it, it rots. Specifically:

- **Model names change.** Groq deprecates them. Pin them in one place and check quarterly.
- **Your index goes stale.** Documents change and the embeddings do not. Re-index on a schedule.
- **Dependencies break.** LangChain especially. Pinned versions, and a deliberate upgrade once a quarter rather than whenever pip feels like it.
- **Costs drift.** Prompts grow, context grows, nobody notices. Your Day 15 report is the check.

**A monthly half hour:** run the evals, run the golden set, read the cost report, upgrade one dependency on purpose. That is the whole maintenance routine, and doing it is what separates a project from an abandoned repository.

---

## 7. Talking about the work

If this goes on a CV or into an interview, most people describe what they built. Describe what you **measured**. It is far rarer.

**Weak:** "Built an AI research agent with RAG and multi-agent orchestration using LangGraph and CrewAI."

**Strong:** "Built a research agent that produces cited reports. Measured retrieval at 87% recall@5 on a 15-question set, improving from 60% by adding hybrid search and cross-encoder reranking. Median cost $0.021 per report. Compared single-agent against multi-agent on the same eval set — multi-agent cost 70% more for no quality gain, so I kept the single agent."

The second one says you can engineer. Anyone can list libraries.

**Questions you should now be able to answer well:**

- "How do you know your RAG is working?" — the golden set, recall@k, MRR, measured before and after each change
- "How do you stop an agent doing something harmful?" — least privilege, budgets, approval gates, verification outside the agent
- "When would you not use an agent?" — most of the time; one call is cheaper and more reliable when the task is one step
- "How do you handle hallucination?" — grounding, an escape hatch with an exact phrase, citations verified in code, and accepting that the rate is never zero

**Have the failures ready too.** "The multi-agent version was worse and I removed it" is a better answer than any success story, because it shows you measured rather than assumed.

---

## 8. The honest state of the field

**What is real:** these systems do useful work today, tool use is genuinely transformative, RAG solves a real problem, costs are falling fast, and the gap between demo and production is where nearly all the difficulty lives.

**What is oversold:** autonomy. Most "autonomous agents" are supervised pipelines with good marketing. Reliability is the binding constraint, not capability — and you now know exactly why, because you measured a task that passed twice out of three.

**What is genuinely unsolved:** prompt injection. Reliable long-horizon autonomy. Evaluation of open-ended output. Knowing when a model does not know.

**Where that leaves you:** the demand is not for people who can call an API. It is for people who can make these systems reliable enough to trust, and who can tell the difference between a system that works and one that looks like it works.

That is the specific thing you spent twenty-one days learning.

---

## 9. The last thing

You built an agent from scratch before touching a framework. Most people never do that, and it is the reason you can debug things they cannot.

Keep the habit. When the next framework arrives — and it will, with a new vocabulary for the same six ideas — you will be able to read it in an afternoon and judge whether it is worth adopting, because you know what it is wrapping.

Now go and use the thing you built. On real work, for a fortnight. That is where the next set of lessons is.
