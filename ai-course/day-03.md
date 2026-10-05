# Day 3 — Prompt Engineering: Teach Your AI How to Behave

**Module:** 01 — Build the Foundation
**Time:** about 1 hour
**Builds on:** Day 2 — `chat.py` with working memory and a pinned system prompt

---

## 1. Today in one line

Your assistant stops improvising and starts behaving the same way every time — and by the end it will return data your code can actually use.

---

## 2. The problem

Look at the system prompt you have been carrying since Day 1:

```python
SYSTEM_PROMPT = "You are a research assistant. Give clear, short answers. If you are not sure about something, say so."
```

It sounds fine. Try this. Ask it the same kind of question five times:

```
You: Summarise the causes of the 2008 financial crisis.
You: Summarise the causes of World War One.
You: Summarise the causes of the Industrial Revolution.
```

Watch what comes back. One answer is three paragraphs. One is a bullet list. One starts with "Great question!". One is 80 words, another is 400. One ends with a follow-up question, the others do not.

**You cannot build software on top of that.**

Tomorrow you are going to write code that reads the model's output. On Day 6 you will need it to say clearly when the answer is not in a document. On Day 9 an agent will decide what to do next based on what it produced. Every one of those needs the output to have a **shape you can rely on**.

"Usually does the right thing" is not a foundation. Today we fix that.

And there is a second, quieter problem. When your assistant does not know something, it does not say so. It produces a confident, fluent, completely invented answer. That behaviour is not a bug you can patch — it is what the model is. But it *can* be steered, and steering it is a prompt job.

---

## 3. Mental model

**The system prompt is a job description you hand to a brand new employee — on their first day — every single morning.**

They are extremely capable and very well read. They are also completely new. They have never met you, do not know your company, and will never remember today.

So the job description has to carry everything:

- who they are and what they are for
- the rules they must follow
- exactly what their output should look like
- one or two examples of good work
- what to do when they do not know something

Leave any of those out, and they fill the gap themselves. Sensibly, confidently, and differently every day.

**Where this comparison breaks down:**

A new employee who is confused will ask you a question. The model never will. It has no sense of "I am unsure about this". It just produces the most likely-looking text and hands it over with total confidence.

So the most important line in most good prompts is the one that gives it permission to fail:

> "If the answer is not in the information you have been given, say: I don't know."

Without that line, "I don't know" is a very unlikely-looking answer, so it almost never comes out. You have to make it an allowed move.

---

## 4. How it really works

**First, a correction that matters.**

The three roles — `system`, `user`, `assistant` — feel like three separate channels. They are not. Underneath, everything is joined into one long piece of text and handed to the model. The roles are labels inside that text. Models are trained to take `system` seriously, so it carries more weight — but it is not a locked control panel. It is strong text in a strong position.

This explains a lot:

- A very long user message can overpower a short system prompt.
- Text inside a document you paste can act like an instruction. (That is **prompt injection**, and it becomes a real security problem on Day 13.)
- Where you put an instruction changes how well it is followed.

**What actually steers behaviour**

The model is picking the next word, over and over, based on everything in front of it. Your prompt does not command it. Your prompt changes what looks likely.

Six things that shift the odds strongly:

**1. A role.** "You are a research assistant who writes for busy people" pulls the whole answer toward a particular style.

**2. Rules that are positive, not negative.** "Do not be verbose" is weak — the model has to imagine the thing and then avoid it. "Answer in at most 4 sentences" is strong, because it describes the target directly. Always say what to do, not what to avoid.

**3. A format you spell out.** If you want three bullets and a one-line summary, say that exactly. Vague prompts produce vague shapes.

**4. Examples.** One or two examples of a good answer teach more than a paragraph of description. This is called **few-shot prompting**, and it is the most under-used tool in the whole list.

**5. Delimiters.** Wrapping input in clear markers — triple quotes, XML-style tags — tells the model where the data ends and the instructions begin. Without them, a pasted document blurs into your rules.

**6. An escape hatch.** Explicit permission to say "I don't know", plus a specific phrase to use.

**One thing that does not work as well as people claim:** politeness, pleading, and capital letters. "PLEASE ALWAYS BE ACCURATE, THIS IS VERY IMPORTANT" does almost nothing. Specific, testable instructions do everything.

**Position matters too.** Instructions at the very start and the very end of the prompt get followed more reliably than instructions buried in the middle. For long prompts, put the critical rule in both places.

---

## 5. Setup

Nothing to install today.

```bash
cd research-assistant/ai
source venv/bin/activate      # Windows: venv\Scripts\activate
```

One new file. Prompts are about to get long, and long strings do not belong in the middle of your logic.

```bash
touch prompts.py
```

Delete `conversation.json` before you start, so old messages from Day 2 do not confuse today's tests:

```bash
rm conversation.json
```

---

## 6. Build it

---

### Stage 1 — Get the prompts out of the way

Put this in `prompts.py`:

```python
BASIC_PROMPT = "You are a research assistant. Give clear, short answers. If you are not sure about something, say so."
```

In `chat.py`, remove the old `SYSTEM_PROMPT` line and import instead:

```python
from prompts import BASIC_PROMPT

SYSTEM_PROMPT = BASIC_PROMPT
```

Small change, real reason. By Day 9 you will have several prompts, each dozens of lines long, and you will be switching between them to compare. Keeping them in one file means you can read your logic without scrolling past walls of text.

Run `chat.py` and check nothing broke. Same behaviour as yesterday.

---

### Stage 2 — Write a prompt that actually controls something

Add this to `prompts.py`:

```python
RESEARCH_PROMPT = """You are a research assistant helping a busy professional.

HOW TO ANSWER
- Start with a direct one-sentence answer to the question asked.
- Then give at most 3 supporting points, each one line.
- Use plain language. Explain any technical term the first time you use it.
- Maximum 120 words in total.

RULES
- If you do not know something, write exactly: "I don't know."
- If you are unsure, say which part you are unsure about.
- Never begin with "Great question" or any similar phrase.
- Never end by offering to help further.
- If the question is vague, ask one clarifying question instead of guessing.

Answer in at most 120 words."""
```

Switch to it in `chat.py`:

```python
from prompts import RESEARCH_PROMPT

SYSTEM_PROMPT = RESEARCH_PROMPT
```

**Now compare properly.** Run the same three "causes of..." questions you ran at the start of today.

You should see: direct opening sentence, three points, consistent length, no "Great question", no offer to help further. The same shape every time.

**Things to notice in that prompt:**

- Headings in capitals. Not decoration — they help the model see the structure.
- "at most 3", "maximum 120 words". Numbers, not adjectives.
- `write exactly: "I don't know."` — an exact phrase. On Day 6 your code will check for that exact string, which only works if it is exact.
- The word limit appears **twice**: once in the middle, once at the very end. That repetition is deliberate. The last line of a prompt is heavily weighted.
- "ask one clarifying question instead of guessing" — turning guessing into an allowed alternative, rather than just forbidding it.

**Now test the escape hatch:**

```
You: What did my neighbour eat for breakfast yesterday?
```

It should say `I don't know.` With the Day 1 prompt, it would often produce a polite paragraph explaining that it cannot know, sometimes with an invented example. Different behaviour, from words alone.

---

### Stage 3 — Show it, do not tell it

Some things are very hard to describe and very easy to demonstrate. Tone is the classic case.

Add to `prompts.py`:

```python
RESEARCH_PROMPT_WITH_EXAMPLES = RESEARCH_PROMPT + """

EXAMPLES OF GOOD ANSWERS

Question: What is inflation?
Answer: Inflation is the rate at which prices rise over time, reducing what your money can buy.
- Measured by tracking the price of a fixed basket of goods.
- Central banks usually target around 2 percent per year.
- Wages rising slower than prices means people get poorer in real terms.

Question: Who will win the next election?
Answer: I don't know.
- Election results cannot be predicted reliably.
- I also have no information about events after my training data ends.
"""
```

Switch to it and test both kinds of question.

**Why this is so much stronger than describing the format:** the second example does not explain the "I don't know" rule, it *performs* it. The model now has a concrete pattern to copy, including what a good refusal looks like — which is much harder to get from a description.

Two or three examples is usually the sweet spot. Beyond about five you are paying tokens on every single call for shrinking returns.

---

### Stage 4 — Make it return data, not prose

This stage is the bridge to tomorrow. Everything in Day 4 depends on it.

So far your output is for a human to read. But often your *code* needs to read it. For that you need a strict shape: JSON.

Add to `prompts.py`:

```python
CLASSIFIER_PROMPT = """You sort incoming questions for a research assistant.

Reply with a JSON object and nothing else. No explanation. No markdown fences.

The JSON object must have exactly these keys:
  "topic"      - one of: science, history, technology, business, personal, other
  "complexity" - one of: simple, medium, hard
  "needs_web"  - true if answering needs information from after your training data, otherwise false
  "rewritten"  - the question rewritten clearly in one sentence

Example input: whats up with tarrifs lately
Example output: {"topic": "business", "complexity": "medium", "needs_web": true, "rewritten": "What are the recent developments in trade tariffs?"}"""
```

Make a new file `classify.py`:

```python
import os, json
from dotenv import load_dotenv
from openai import OpenAI
from prompts import CLASSIFIER_PROMPT

load_dotenv()
client = OpenAI(api_key=os.environ["GROQ_API_KEY"],
                base_url="https://api.groq.com/openai/v1")


def classify(question):
    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": CLASSIFIER_PROMPT},
            {"role": "user", "content": question}
        ],
        temperature=0,
        response_format={"type": "json_object"}
    )

    raw = response.choices[0].message.content
    return json.loads(raw)


if __name__ == "__main__":
    for q in ["how do black holes form",
              "whats the price of bitcoin right now",
              "i had a fight with my brother what do i do"]:
        print(q)
        print(classify(q))
        print()
```

**Line by line on the important bits:**

- `temperature=0` — we want the same input to give the same output. Randomness is useful for writing and harmful for classifying. On Day 1 you saw what temperature does; this is the first time you have a real reason to pin it down.
- `response_format={"type": "json_object"}` — **JSON mode**. The provider forces the output to be valid JSON. One catch: the word "json" must appear somewhere in your prompt, or the API rejects the request. Ours says "JSON object", so we are fine.
- `json.loads(raw)` — turns the JSON text into a real Python dictionary.

Run it. You get dictionaries. Your code can now branch on `result["needs_web"]`.

**Belt and braces.** JSON mode is not available on every model, and the model can still wrap output in markdown fences on some providers. Add this so the code survives either way:

```python
def extract_json(raw):
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw.strip())
```

Use `extract_json(raw)` instead of `json.loads(raw)`. Boring, and it will save you an hour some evening.

---

### Stage 5 — Test your prompt like it is code

A prompt is code. It has bugs. When you change it, it breaks in places you were not looking.

The moment you start editing prompts seriously, you need a way to check you did not make things worse. Here is the smallest useful version.

Make `test_prompt.py`:

```python
from classify import classify

TESTS = [
    ("how do black holes form",              {"topic": "science", "needs_web": False}),
    ("what is the bitcoin price today",      {"topic": "business", "needs_web": True}),
    ("my sister is not talking to me",       {"topic": "personal", "needs_web": False}),
    ("explain how MCP servers work",         {"topic": "technology", "needs_web": False}),
    ("who won the last cricket world cup",   {"needs_web": True}),
]

passed = 0
for question, expected in TESTS:
    result = classify(question)
    ok = all(result.get(k) == v for k, v in expected.items())
    print(f"{'PASS' if ok else 'FAIL'}  {question}")
    if not ok:
        print(f"      expected {expected}")
        print(f"      got      {result}")
    passed += ok

print(f"\n{passed}/{len(TESTS)} passed")
```

Run it. Some will fail. That is the point.

Now **change one line of `CLASSIFIER_PROMPT`** — remove the example, or drop a category — and run the tests again. Watch the score move.

This is called an **eval**, and it is the difference between engineering a prompt and poking at one. You now have, on Day 3, the habit most people do not pick up until something breaks in front of a customer. Day 15 turns this into a proper harness.

---

## 7. Words I heard today

| Word | Plain meaning |
|---|---|
| **Prompt** | All the text you send. System, user and assistant together. |
| **System prompt** | The standing instructions at position 0. |
| **Zero-shot** | Asking with no examples. |
| **Few-shot** | Giving 1 to 5 examples inside the prompt. Usually a big improvement. |
| **Delimiter** | A marker like `"""` or `<document>` showing where data starts and ends. |
| **Escape hatch** | Explicit permission, and an exact phrase, for saying "I don't know". |
| **Hallucination** | A confident, fluent, invented answer. |
| **Grounding** | Making answers come from supplied information rather than the model's own guesses. |
| **Temperature** | Randomness dial. 0 for classifying and code, higher for writing. |
| **JSON mode** | Forcing output to be valid JSON. Needs the word "json" in your prompt. |
| **Deterministic** | Same input, same output. What `temperature=0` gets you close to. |
| **Eval** | A small test set you run every time you change a prompt. |
| **Prompt injection** | Text inside data that the model treats as an instruction. Day 13. |

---

## 8. Break it on purpose

**1. Positive versus negative.**
Set a rule to "Do not write long answers". Ask three questions. Then change it to "Answer in at most 3 sentences" and ask the same three.
*You will see:* the second one is obeyed far more reliably.
*It teaches:* describe the target, not the thing to avoid.

**2. Remove the escape hatch.**
Delete the `"I don't know."` rule. Ask about something that cannot be known — your neighbour's breakfast, next month's news.
*You will see:* a confident invented answer, or a long polite non-answer.
*It teaches:* refusing is an unlikely output unless you make it an allowed one.

**3. Contradict yourself.**
Add "Always answer in exactly one word" while keeping "at most 3 supporting points".
*You will see:* it picks one and ignores the other, usually inconsistently.
*It teaches:* prompts fail silently. No error, just quiet disobedience. This is why you need evals.

**4. Move the rule.**
Take your most important rule and put it in the middle of a long prompt. Test. Then move it to the very last line. Test again.
*You will see:* better obedience at the end.
*It teaches:* position is a real lever. Put critical rules first and last.

**5. Add thinking room.**
Add: "Before answering, think step by step inside <thinking></thinking> tags, then give your final answer after them." Ask a multi-step reasoning question.
*You will see:* noticeably better reasoning, and more tokens used.
*It teaches:* letting the model work out loud improves hard answers. It also costs more, which is a real trade, not a free win.

**6. Fake being the assistant.**
Using yesterday's experiment 2, hand-insert an assistant message written in a completely different style, then continue chatting.
*You will see:* it copies that style, sometimes over your system prompt.
*It teaches:* the conversation is part of the prompt. Prompt engineering does not stop at position 0.

---

## 9. Traps

**Trap 1 — the polite prompt**
"Please try to be accurate and helpful if possible." Sounds nice, controls nothing.
*Symptom:* output that varies wildly between calls.
*Fix:* every rule must be testable. If you cannot write a test that checks it, the model cannot follow it reliably either.

**Trap 2 — JSON in markdown fences**
*Symptom:* `json.decoder.JSONDecodeError: Expecting value: line 1 column 1`.
*Cause:* the model wrapped the JSON in ```` ```json ```` because that is how JSON usually appears in its training data.
*Fix:* JSON mode, plus `extract_json` as backup. Belt and braces.

**Trap 3 — the prompt that grew**
Prompts accumulate. After ten edits you have 400 lines with three rules quietly contradicting each other.
*Symptom:* fixing one behaviour breaks another.
*Fix:* re-read the whole prompt end to end whenever you edit it. Delete rules that your evals do not check. A rule nobody tests is usually a rule nobody needs.

**Trap 4 — testing with one example**
*Symptom:* "I fixed it!" followed by the same bug two days later.
*Cause:* one test passing is luck, not evidence.
*Fix:* five fixed questions in `test_prompt.py`. Always run all of them.

**Trap 5 — expecting 100 percent**
*Symptom:* endless prompt tweaking to chase the last stubborn failure.
*Reality:* prompts are steering, not commands. Some failure rate always remains.
*Fix:* if the last few percent really matter, handle it in code — validate the output, retry once, fall back to something safe. Day 15 covers this properly.

---

## 10. Check yourself

1. Why is "answer in at most 3 sentences" more reliable than "do not be verbose"?
2. What is an escape hatch, and why does the exact wording of the phrase matter?
3. Why does `temperature=0` belong in `classify.py` but not in your chat assistant?
4. You have one crucial rule and a 300-line prompt. Where do you put the rule, and why?
5. What is an eval, and what specifically goes wrong without one?

---

## 11. Where this goes

- **Day 4 is prompt engineering wearing a different hat.** Every tool you write needs a description, and that description is a prompt. A vague one means the model picks the wrong tool.
- **Day 5 and 6** depend on today's escape hatch. "Only answer from the document, otherwise say I don't know" is how you stop it inventing things about your files.
- **Day 7 and 9** need Stage 4. An agent decides its next step by producing structured output your code can read.
- **Day 10** is prompting for planning: getting a big goal broken into steps.
- **Day 13** meets the dark side of section 4. If instructions are just text, then text inside a document can act like an instruction.
- **Day 15** grows `test_prompt.py` into a real evaluation harness.

---

## 12. PROJECT STATE

```
PROJECT STATE after Day 3:

Folders:
  research-assistant/
    ai/
      venv/, .env, .gitignore, requirements.txt
      hello.py, chat_day1_backup.py
      chat.py            (memory + trimming + saving, from Day 2)
      prompts.py         (NEW - all prompts live here)
      classify.py        (NEW - JSON output, temperature 0, JSON mode)
      test_prompt.py     (NEW - 5 fixed test cases, prints pass/fail)
      conversation.json
    dashboard/           (still empty)

Libraries: openai, python-dotenv (no new installs on Day 3)

prompts.py contains:
  BASIC_PROMPT                     (Day 1 version, kept for comparison)
  RESEARCH_PROMPT                  (role, numbered format rules, exact
                                    "I don't know." escape hatch, 120 word
                                    limit stated twice - middle and last line)
  RESEARCH_PROMPT_WITH_EXAMPLES    (RESEARCH_PROMPT + 2 few-shot examples,
                                    one of which demonstrates refusing)
  CLASSIFIER_PROMPT                (returns JSON: topic, complexity,
                                    needs_web, rewritten)

chat.py now imports its prompt from prompts.py instead of defining it inline.

classify.py:
  - classify(question) -> dict
  - temperature=0, response_format={"type":"json_object"}
  - extract_json() helper strips markdown fences as a fallback

Key decisions made:
  - prompts separated from logic, so they can be swapped and compared
  - positive instructions with numbers, never "do not" phrasing
  - exact refusal phrase "I don't know." so code can check for it later
  - critical limits repeated at the end of the prompt
  - evals exist from Day 3, not added later after something breaks

Known problems, left for later:
  - prompts are static; nothing adapts to the user yet
  - no retry when the model disobeys the format (Day 15)
  - test_prompt.py only checks exact key matches, no scoring (Day 15)
```

---

## Answers

**1.** Because it describes the target directly. A negative instruction makes the model represent the unwanted thing first, and gives it no clear alternative. "At most 3 sentences" is also testable — you can count.

**2.** Explicit permission, with an exact phrase, to admit it does not know. The wording matters because your code will later check for that exact string. "I don't know." and "I'm not sure about that" are different strings, and a check for one will miss the other.

**3.** Classifying should be repeatable — the same question must always get the same category, or your program behaves differently on identical input. Chat benefits from variation, and identical phrasing every time feels robotic.

**4.** First and last. The start and end of a prompt get the most attention; the middle gets the least. For a rule that really matters, state it in both places.

**5.** A small fixed set of test inputs with expected outputs, run every time you change the prompt. Without it, prompt changes fail silently — you fix one behaviour, quietly break another, and only find out much later.
