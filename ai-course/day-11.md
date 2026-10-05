# Day 11 -- Memory Engineering

**Module:** 03 -- Advanced Agent Systems
**Time:** about 1 hour
**Builds on:** Day 2 -- the sliding window problem; Day 6 -- embeddings; Day 7 and 9 -- the scratchpad

---

## 1. Today in one line

You stop keeping what is **recent** and start keeping what **matters** -- which fixes the problem Day 2 left open and the one Day 9 is about to hit.

---

## 2. The problem

Three open wounds, all from earlier days.

**Day 2's.** Your sliding window keeps the last eight messages. Tell it your name, chat about something else for ten turns, ask your name. Gone. Keeping everything instead is not an option -- the cost curve you watched climbing was real.

**Day 9's.** A thirty-step autonomous run accumulates thirty tool results in the scratchpad. Long runs overflow the context window, and you cannot trim them, because trimming splits the `tool_calls` / `tool` pairs and the API rejects it. You have been avoiding this by raising the limit. That stops working.

**The one nobody has mentioned yet.** Close your program. Open it tomorrow. It knows nothing about you. Not your name, not your job, not that you said last week you prefer short answers. Every conversation starts from zero, forever.

The instinct is to store more. That is the wrong instinct, and you can see why by thinking about what "store everything" actually means: a complete transcript of every conversation, which you then have to search, and which mostly contains "ok", "thanks" and "what about the other one".

The right question is not *how do I keep more*. It is **what deserves to be kept, and in what form**.

---

## 3. Mental model

**A transcript versus a notebook.**

A transcript is everything that was said, in order. Complete, enormous, and almost useless -- to find one fact you must search the whole thing.

A notebook holds what you decided was worth writing down. Facts, not conversations. "Rahul works in fintech, prefers short answers, based in Mumbai." Three lines that replace forty exchanges.

Your memory is a notebook, not a recording. You do not remember Tuesday's conversation word for word. You remember that your friend changed jobs. You extracted the fact and discarded the transcript, without deciding to.

**Where this comparison breaks, in a way that matters:**

**Human forgetting is graceful.** Things fade -- you half-remember, you recognise when prompted, you know that you used to know. Systems forget catastrophically. A fact is either in the store or it is not, and when it is not, the assistant does not hesitate. It does not know that it does not know.

So a system's memory needs to be *deliberately* selective. Nothing fades on its own. Whatever you do not write down is gone completely and silently.

---

## 4. How it really works

**Memory is not one thing. It is five, and they have different lifetimes.**

| Kind | What it holds | Lives for | Where you have met it |
|---|---|---|---|
| **Working** | This agent run's scratchpad | One task | Day 7, 9 |
| **Short-term** | This conversation | One session | Day 2 |
| **Long-term (semantic)** | Facts about the user and world | Forever | Today |
| **Episodic** | What happened in past sessions | Forever | Today, lightly |
| **Procedural** | Learned how-to, refined instructions | Forever | Days 16+ |

Most confusion about "AI memory" comes from mixing these up. "Should the assistant remember this?" has no answer until you say *which memory*. A one-off correction belongs in short-term. "I'm vegetarian" belongs in long-term. A tool result from step 4 belongs in working memory and should vanish at the end of the run.

**The three operations**

**Writing.** After each turn, decide what is worth keeping. This needs judgement, so it is a model call -- a small one. It is called **extraction**: turning a conversation into facts.

**Reading.** At the start of each turn, pull the *relevant* memories -- not the recent ones. You already have the tool for this: embeddings, Day 6. Embed the memory, embed the incoming message, find what is close.

**This is the central swap of the whole day.** Day 2 used recency because it was easy. Today you use relevance, because you have embeddings. "What's my name?" retrieves the name fact regardless of how many turns ago it was mentioned.

**Forgetting.** Unglamorous and necessary. Without it, memory fills with stale facts. "I live in Mumbai" from March and "I moved to Pune" from September are both true statements that were made, and only one is true now. Three kinds of forgetting: **superseding** (the new fact replaces the old), **decay** (old and unused facts fade), and **explicit** ("forget that").

**The cost you are paying**

Every turn now costs an extra small call for extraction, plus an embedding lookup, plus the retrieved memories occupy context. Memory is not free. On Day 15 you will decide whether to extract on every turn or every fifth.

---

## 5. Setup

Nothing new to install -- Chroma and sentence-transformers are already there from Day 6.

```bash
cd research-assistant/ai
source venv/bin/activate

touch memory.py
```

---

## 6. Build it

---

### Stage 1 -- Extract facts from conversation

`memory.py`:

```python
import os, json, uuid
from datetime import datetime, timezone
from dotenv import load_dotenv
from openai import OpenAI
import chromadb
from chromadb.utils import embedding_functions

load_dotenv()
client = OpenAI(api_key=os.environ["GROQ_API_KEY"],
                base_url="https://api.groq.com/openai/v1")
MODEL = "llama-3.3-70b-versatile"

EXTRACT_PROMPT = """You pull out facts worth remembering long-term about a user.

Keep ONLY things that will still be true and useful next week:
- who they are, their work, their situation
- stable preferences ("prefers short answers", "vegetarian")
- ongoing projects and goals
- important people, places and constraints in their life

Do NOT keep:
- the question they just asked
- anything you told them
- temporary states ("I'm tired today")
- small talk, pleasantries, one-off requests

Reply with JSON only:
{"facts": [{"text": "a complete standalone sentence", "kind": "identity|preference|project|context"}]}

Each fact must make sense alone, with no pronouns referring outside itself.
Write "Rahul works in fintech", never "he works there".
If there is nothing worth keeping, return {"facts": []}. This is common and fine."""


def extract_facts(user_message, assistant_reply=""):
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": EXTRACT_PROMPT},
            {"role": "user", "content": f"USER SAID: {user_message}\n\nASSISTANT REPLIED: {assistant_reply[:500]}"}
        ],
        temperature=0,
        response_format={"type": "json_object"}
    )
    return json.loads(response.choices[0].message.content).get("facts", [])


if __name__ == "__main__":
    print(extract_facts("Hi, I'm Rahul. I'm building a fintech startup in Mumbai and I prefer short answers."))
    print(extract_facts("What's the weather like?"))
    print(extract_facts("Thanks, that's helpful!"))
```

Run it:

```
[{'text': 'The user is named Rahul.', 'kind': 'identity'},
 {'text': 'Rahul is building a fintech startup in Mumbai.', 'kind': 'project'},
 {'text': 'Rahul prefers short answers.', 'kind': 'preference'}]
[]
[]
```

**Two things doing the real work here.**

**The "do NOT keep" list is longer than the "keep" list, on purpose.** Without it, extraction saves everything -- every question asked, every answer given -- and within a week your memory is a worse transcript than the transcript.

**"Each fact must make sense alone."** This is not a style note. Facts get retrieved one at a time, out of order, months later, with no surrounding conversation. "He mentioned it was important" is worthless on its own. This one rule is the difference between a memory store that works and one that produces confusing noise.

Returning `[]` for small talk is the correct and most common outcome.

---

### Stage 2 -- Store them

```python
chroma = chromadb.PersistentClient(path="./chroma_db")
embedder = embedding_functions.SentenceTransformerEmbeddingFunction(
    model_name="all-MiniLM-L6-v2")

memories = chroma.get_or_create_collection(name="memories", embedding_function=embedder)


def remember(text, kind="context", user="default"):
    memories.upsert(
        ids=[uuid.uuid4().hex],
        documents=[text],
        metadatas=[{
            "kind": kind,
            "user": user,
            "created": datetime.now(timezone.utc).isoformat(),
            "used": 0
        }]
    )


def recall(query, top_n=5, user="default"):
    if memories.count() == 0:
        return []

    results = memories.query(
        query_texts=[query],
        n_results=min(top_n, memories.count()),
        where={"user": user}
    )

    found = []
    for text, meta, distance in zip(results["documents"][0],
                                    results["metadatas"][0],
                                    results["distances"][0]):
        score = 1 - distance
        if score > 0.25:
            found.append({"text": text, "kind": meta["kind"], "score": score})
    return found
```

**A separate collection from your documents.** They are different things with different lifetimes, and mixing them means a document chunk can be retrieved as if it were a fact about you.

**`user` in the metadata, even though you are the only user.** Adding it later means migrating everything. Adding it now costs one line. On Day 20, when this runs as a service, you will be glad.

Test it:

```python
    for fact in extract_facts("Hi, I'm Rahul. I'm building a fintech startup in Mumbai and I prefer short answers."):
        remember(fact["text"], fact["kind"])

    print(recall("what is my name"))
    print(recall("what am I working on"))
    print(recall("how should you talk to me"))
```

**Look at the third one.** "How should you talk to me" retrieves "Rahul prefers short answers" -- no shared words at all. Day 6's embeddings, doing the thing keyword search could never do.

---

### Stage 3 -- Inject memories into the conversation

Now connect it. In `chat.py`:

```python
from memory import extract_facts, remember, recall


def build_system_prompt(question):
    found = recall(question, top_n=5)
    if not found:
        return SYSTEM_PROMPT

    lines = "\n".join(f"- {m['text']}" for m in found)
    return (SYSTEM_PROMPT +
            "\n\nWHAT YOU KNOW ABOUT THIS USER:\n" + lines +
            "\n\nUse these naturally. Do not announce that you remember them.")
```

And in the loop:

```python
    messages.append({"role": "user", "content": question})

    send = [{"role": "system", "content": build_system_prompt(question)}] + trim_history(messages)[1:]
    response = ask_model(send, tools=TOOL_SCHEMAS)
    ...

    for fact in extract_facts(question, answer):
        remember(fact["text"], fact["kind"])
```

**Read what just happened.** The system prompt is now **rebuilt every turn**, based on what the current question is about. Different question, different memories injected. Memory is not a block of text you carry around -- it is a lookup, run fresh each turn.

**Now the test Day 2 failed.** Run `chat.py`:

```
You: Hi, I'm Rahul and I work in fintech.
You: What's the capital of France?
... eight more unrelated turns ...
You: What's my name?
Assistant: Your name is Rahul.
```

**Then quit, restart, and ask again.** It still knows. Memory now outlives the conversation.

"Do not announce that you remember them" is there for a reason. Without it you get "As I recall, you mentioned you work in fintech..." every single turn, which is both irritating and slightly unsettling.

---

### Stage 4 -- Handle contradictions

Say this:

```
You: I live in Mumbai.
... later ...
You: I've moved to Pune.
```

Now `recall("where do I live")` returns **both**, and the model gets two contradictory facts with nothing to choose between them.

```python
CONFLICT_PROMPT = """You decide whether a new fact replaces existing ones.

Reply with JSON only:
{"replaces": [list of existing fact numbers this supersedes],
 "keep_new": true/false,
 "reason": "one short sentence"}

A fact REPLACES another when it updates the same thing about the same subject
(moved house, changed job, changed preference).
It does NOT replace when both can be true at once (two hobbies, two projects).
Set keep_new to false only if the new fact is already covered by an existing one."""


def remember_carefully(text, kind="context", user="default"):
    similar = recall(text, top_n=4, user=user)

    if not similar:
        remember(text, kind, user)
        return "added"

    numbered = "\n".join(f"{i}. {m['text']}" for i, m in enumerate(similar))
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": CONFLICT_PROMPT},
            {"role": "user", "content": f"EXISTING:\n{numbered}\n\nNEW FACT:\n{text}"}
        ],
        temperature=0,
        response_format={"type": "json_object"}
    )
    decision = json.loads(response.choices[0].message.content)

    for index in decision.get("replaces", []):
        if 0 <= index < len(similar):
            old = memories.get(where_document={"$contains": similar[index]["text"]})
            if old["ids"]:
                memories.delete(ids=old["ids"])

    if decision.get("keep_new", True):
        remember(text, kind, user)
        return f"added, replaced {len(decision.get('replaces', []))}"
    return "skipped, already known"
```

Swap `remember` for `remember_carefully` in `chat.py` and test the Mumbai/Pune sequence. The old fact should disappear.

**Two things worth being honest about.**

This costs an extra model call per fact. On Day 15 you will decide whether that is worth it -- one reasonable answer is to only run conflict resolution for `identity` and `preference` facts, where contradictions actually matter, and skip it for `project` and `context`.

And deletion is permanent. A better production design keeps superseded facts with an `active: false` flag, so you have a history and can recover from a wrong call. Your version deletes, which is simpler and less forgiving.

---

### Stage 5 -- Fix the agent scratchpad

Now the Day 9 problem. A long run overflows, and you cannot trim naively because of tool pairs.

```python
def compress_scratchpad(messages, keep_recent=8):
    """Summarise old agent steps without breaking tool_call pairs."""
    system = messages[0]
    body = messages[1:]

    if len(body) <= keep_recent + 4:
        return messages

    split = len(body) - keep_recent

    # never split between an assistant tool_calls message and its tool results
    while split < len(body) and body[split].get("role") == "tool":
        split += 1

    old, recent = body[:split], body[split:]

    readable = []
    for m in old:
        role = m.get("role")
        if role == "tool":
            readable.append(f"tool result: {str(m.get('content'))[:200]}")
        elif m.get("tool_calls"):
            names = [c["function"]["name"] for c in m["tool_calls"]]
            readable.append(f"called: {', '.join(names)}")
        elif m.get("content"):
            readable.append(f"{role}: {str(m['content'])[:200]}")

    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content":
             "Summarise these agent steps in under 150 words. Keep every fact "
             "found, every file written, every failure, and anything already "
             "tried that did not work. Drop everything else."},
            {"role": "user", "content": "\n".join(readable)}
        ],
        temperature=0
    )

    summary = response.choices[0].message.content
    return [system, {"role": "user", "content": f"[Earlier steps summarised]\n{summary}"}] + recent
```

**The `while` loop is the fix you have been waiting for since Day 4.** It walks the split point forward past any `tool` messages, so a cut can never land between an assistant's tool request and its results. That orphaned-tool-call error is finally, properly dead.

**"Anything already tried that did not work"** in the summary prompt is the line that prevents the worst failure: the agent forgetting its failures, repeating them, and looping. Facts are useless if the agent re-does work it already knows failed.

Use it in `autonomous.py`, inside the loop before calling the model:

```python
        if len(messages) > 25:
            messages = compress_scratchpad(messages)
```

Now run a task with `max_steps=30`. It survives.

---

### Stage 6 -- Forgetting

Three kinds, all necessary.

**Explicit.** Add a tool the user can trigger:

```python
def forget(about):
    """Delete memories about a topic."""
    found = recall(about, top_n=5)
    if not found:
        return "I have no memories about that."

    removed = []
    for m in found:
        if m["score"] > 0.5:
            got = memories.get(where_document={"$contains": m["text"]})
            if got["ids"]:
                memories.delete(ids=got["ids"])
                removed.append(m["text"])
    return f"Forgotten: {removed}" if removed else "Nothing close enough to delete."
```

Register it as a tool so the user can say "forget that I live in Mumbai".

**Decay.** Track `used` in the metadata, bump it on every recall, and periodically delete `context`-kind facts that are old and never retrieved. Identity and preference facts should not decay.

**A cap.** Above a few hundred memories, injection starts getting noisy -- the top 5 for any query becomes a loose collection of vaguely related things. Keep a ceiling and drop the least useful.

**Then test the noise directly.** Add 50 memories and check what `recall("what's my name")` returns. If facts with score 0.3 are creeping in, raise the threshold. Precision matters more than recall here: one wrong memory injected confidently is worse than five right ones missed.

**One last thing, and it is not a technical point.** You have just built a file that quietly accumulates personal facts about a person from their conversations. If this ever runs for anyone but you: they should know it exists, be able to read it, and be able to delete it. That is why `forget` is a user-facing tool and not just a maintenance script.

---

## 7. Words I heard today

| Word | Plain meaning |
|---|---|
| **Working memory** | The current run's scratchpad. Dies with the task. |
| **Short-term memory** | This conversation. Dies with the session. |
| **Long-term / semantic** | Facts that last. Today's store. |
| **Episodic memory** | What happened in past sessions. |
| **Procedural memory** | Learned how-to. Refined instructions. |
| **Extraction** | Turning conversation into standalone facts. |
| **Consolidation** | Merging and tidying facts over time. |
| **Superseding** | A new fact replacing an outdated one. |
| **Decay** | Old, unused memories fading out. |
| **Recency vs relevance** | Keeping the latest versus keeping what fits. The core swap today. |
| **Memory injection** | Putting retrieved memories into the prompt. |
| **Context rot** | Quality dropping as the context fills with marginally relevant text. |

---

## 8. Break it on purpose

**1. The Day 2 test, properly.**
Name yourself, chat fifteen unrelated turns, restart the program, ask your name.
*You will see:* it works, across the restart.
*It teaches:* what memory actually means. Day 2 could not do this at any window size.

**2. Turn off the "do NOT keep" list.**
Delete it from `EXTRACT_PROMPT`. Have a normal ten-turn conversation. Count the memories.
*You will see:* dozens, most of them worthless.
*It teaches:* extraction quality is the whole system. A noisy store is worse than no store, because it retrieves confidently.

**3. Contradict yourself with and without conflict handling.**
Mumbai, then Pune. Run it both ways.
*You will see:* with plain `remember`, both facts get injected and the model picks one, sometimes the wrong one.
*It teaches:* storing is not the hard part. Updating is.

**4. Flood it.**
Add 50 varied memories. Run five specific queries and read what comes back.
*You will see:* marginally relevant facts creeping into the top 5.
*It teaches:* **context rot.** More memory is not better memory. Threshold and cap matter.

**5. Break the scratchpad compressor on purpose.**
Remove the `while` loop that skips past tool messages. Run a 30-step agent task.
*You will see:* the orphaned-tool-call API error, finally reproduced deliberately.
*It teaches:* exactly what that loop is for, and why Day 4's trap kept coming back.

**6. Compress away a failure.**
Change the summary prompt to only keep findings, dropping "what did not work". Run a long task where an early tool fails.
*You will see:* the agent re-attempting things it already knows failed.
*It teaches:* failures are as important as findings. Summarising is choosing, and choosing badly causes loops.

---

## 9. Traps

**Trap 1 -- remembering everything**
*Symptom:* recall returns five vaguely related things, none useful.
*Fix:* a strict extraction prompt. Returning `[]` should be the common case.

**Trap 2 -- facts with pronouns**
*Symptom:* "He said it was urgent" retrieved six weeks later, meaning nothing.
*Fix:* enforce standalone sentences at extraction time. It cannot be fixed afterwards.

**Trap 3 -- no conflict handling**
*Symptom:* the assistant confidently uses outdated information.
*Fix:* Stage 4, at least for identity and preference facts.

**Trap 4 -- memory and documents in one collection**
*Symptom:* a chunk of a PDF is injected as a fact about the user.
*Fix:* separate collections. Different lifetimes, different meanings.

**Trap 5 -- the extraction call on every single turn**
*Symptom:* every turn costs an extra call, and rate limits arrive twice as fast.
*Fix:* extract every few turns, or only when the message looks like it contains information about the user. Day 15.

**Trap 6 -- forgetting that this is personal data**
*Symptom:* not a bug. A file full of personal facts, collected without anyone asking for it.
*Fix:* let the user see it, let the user delete it, and do not collect what you would be uncomfortable showing them.

---

## 10. Check yourself

1. Name the five kinds of memory and say how long each should live.
2. What is the single biggest change from Day 2's approach, in four words?
3. Why must an extracted fact be a standalone sentence with no outside pronouns?
4. What exactly does the `while` loop in `compress_scratchpad` prevent?
5. You have 500 memories and answers get vaguer. What is happening and what are two fixes?

---

## 11. Where this goes

- **Day 12** improves the retrieval underneath all of this. Memory recall is a retrieval problem, so hybrid search and re-ranking apply to memories exactly as they do to documents.
- **Day 13** raises an uncomfortable question: a fact extracted from a document could be an instruction planted by whoever wrote it. Memory is an injection surface with a long lifetime.
- **Day 14** asks whether agents share memory or keep their own, and what happens when two agents learn contradictory things.
- **Day 15** decides how often to extract, whether conflict resolution is worth a call, and how to measure whether memory is helping at all.
- **Day 21** is where this becomes visible: an assistant that knows your work after weeks of use is a genuinely different product from one that starts fresh every time.

---

## 12. PROJECT STATE

```
PROJECT STATE after Day 11:

Folders:
  research-assistant/
    ai/
      venv/, .env, .gitignore, requirements.txt
      chat.py            (now memory-aware)
      agent.py, autonomous.py (now compresses its scratchpad), planner.py
      memory.py          (NEW)
      mcp_agent.py, mcp_client.py, mcp_servers/my_tools.py
      tools.py (now includes a forget tool), prompts.py, classify.py
      documents.py, embeddings.py, vector_store.py
      chroma_db/         (TWO collections now: "documents" and "memories")
      runs/, notes/, documents/, conversation.json
    dashboard/           (still empty)

Libraries: no new installs

memory.py contains:

  extract_facts(user_message, assistant_reply) -> [{text, kind}]
      kinds: identity | preference | project | context
      the "do NOT keep" list is deliberately longer than the keep list
      every fact must be a STANDALONE sentence with no outside pronouns,
      because facts are retrieved alone, months later, with no context
      returning [] for small talk is normal and common

  remember(text, kind, user)   - upsert into the "memories" collection
      metadata: kind, user, created (UTC iso), used counter
      "user" is stored from day one even with a single user, so Day 20
      does not require a migration

  recall(query, top_n=5, user)  - vector search, filters by user,
      drops anything scoring below 0.25, returns text/kind/score

  remember_carefully(text, kind, user)
      looks up similar existing facts, asks the model whether the new one
      SUPERSEDES them (moved house, changed job) or coexists (two hobbies)
      deletes superseded facts, skips duplicates
      costs one extra model call per fact

  compress_scratchpad(messages, keep_recent=8)
      summarises old agent steps into one message
      THE KEY LINE: a while loop walks the split point forward past any
      role="tool" messages, so a cut can never land between an assistant
      tool_calls message and its results. This finally kills the orphaned
      tool call error that has been avoided since Day 4.
      summary prompt keeps: facts found, files written, failures, and
      ANYTHING ALREADY TRIED THAT DID NOT WORK (without this the agent
      repeats failed attempts and loops)

  forget(about) - user-facing tool, deletes memories above 0.5 similarity

chat.py changes:
  build_system_prompt(question) rebuilds the system prompt EVERY TURN,
  injecting the 5 most relevant memories for that specific question
  "Do not announce that you remember them" prevents constant
  "as I recall, you mentioned..." phrasing
  facts extracted and stored after each exchange

autonomous.py changes:
  compress_scratchpad called when messages exceed 25

Key decisions made:
  - RELEVANCE replaces RECENCY. This is the whole day.
  - memories and documents live in SEPARATE Chroma collections
  - extraction is strict; an empty result is the expected normal case
  - deletion on supersede is permanent (a production design would flag
    active=false instead and keep history)
  - forget() is a user-facing tool, not a maintenance script, because this
    is a store of personal data and the user should control it

Verified working:
  - name given, 15 unrelated turns, program restarted, name still known.
    Day 2 could not do this at any window size.
  - "how should you talk to me" retrieves "prefers short answers" with no
    shared words
  - 30-step agent run survives scratchpad compression without an
    orphaned-tool-call error

Known problems, left for later:
  - extraction runs on every turn; costs a call each time (Day 15)
  - conflict resolution costs another call per fact; probably should only
    run for identity and preference kinds
  - no decay implemented yet, only the "used" counter is stored
  - above a few hundred memories, injection gets noisy (context rot);
    no cap enforced yet
  - memory recall uses pure vector search, so it has Day 6's weaknesses
    with exact names and codes (Day 12)
  - a fact extracted from document text could have been planted there
    (Day 13)
```

---

## Answers

**1.** Working (one task), short-term (one session), long-term/semantic (forever), episodic (forever, records of past sessions), procedural (forever, learned how-to). Mixing them up is the source of most confusion about what an assistant "should remember".

**2.** Relevance instead of recency. Day 2 kept the last N messages because it was easy; today you retrieve the memories that fit the current question, however long ago they were created.

**3.** Because facts are retrieved individually, out of order, long afterwards, with none of the surrounding conversation. "He said it was urgent" has no referent once the conversation is gone, so it is noise at best and misleading at worst.

**4.** It stops the split landing between an assistant message containing `tool_calls` and the `tool` messages that answer it. That orphaned pair is rejected by the API -- the error that has been lurking since Day 4.

**5.** Context rot: with many memories, the top 5 for any query includes things that are only loosely related, so the injected context is diluted. Fixes: raise the similarity threshold so weak matches are dropped, and cap the store by deleting old `context` facts that are never retrieved.
