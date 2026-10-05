# Day 1 — Build Your First AI Chatbot

**Module:** 01 — Build the Foundation
**Time:** about 1 hour
**Stack today:** Python, Groq free tier, `llama-3.3-70b-versatile`

---

## 1. Today in one line

By the end of today, you will type a question in your terminal, and a real AI model will answer you — from code you wrote yourself.

---

## 2. The problem

Right now you can open a chat website and talk to an AI. Nice. But you cannot do anything with it.

You cannot make it read your 40 PDFs. You cannot make it send an email. You cannot make it run every night at 2am. You cannot put it inside your own app.

A chat website is a **locked room**. You can go in and talk, but you cannot bring anything with you and you cannot take anything out.

Today we get the key. Once your own code can talk to the model, you control everything around it — what goes in, what comes out, and what happens next. Every single thing in the next 20 days depends on this one skill.

It takes about 8 lines of code. That is the surprising part.

---

## 3. Mental model

**Think of the model as a vending machine for text.**

You put text in. You get text out. That is it.

- It does not know who you are.
- It does not know you used it 5 seconds ago.
- Every use is completely separate and fresh.

**Where this comparison breaks:**

A vending machine gives you the exact same chocolate every time you press B4. The model does not. Ask the same question twice and you may get two different answers. It is not looking up a stored answer — it is **guessing the next word, again and again, very fast**. Same question, slightly different guesses.

Keep both halves of this in your head:

> Text in, text out, no memory — but the output is a guess, not a lookup.

That one sentence explains about 70% of the strange behaviour you will meet over the next three weeks.

---

## 4. How it really works

Let us follow one message, step by step.

**Step 1 — Your code builds a list of messages.**

This is the shape. Learn it today, you will use it for 21 days:

```
[
  {"role": "system",    "content": "You are a helpful research assistant."},
  {"role": "user",      "content": "What is photosynthesis?"}
]
```

A Python **list**, containing **dictionaries**. Each dictionary has exactly two keys: `role` and `content`.

Three roles exist:

| Role | Who is speaking | Use it for |
|---|---|---|
| `system` | You, the builder | Rules the AI must follow |
| `user` | The person typing | Their question |
| `assistant` | The AI | Its past answers |

**Step 2 — Your code sends that list over the internet.**

It goes to Groq's computers as an HTTP request. Your Python program stops and waits.

**Step 3 — Groq's computer runs the model.**

The model reads your whole list. Then it starts guessing: what word comes next? Then the next. Then the next. It keeps going until it decides the answer is finished.

**Step 4 — An object comes back.**

Not plain text. A whole object, with the answer buried inside it, plus extra information you will care about later.

**Step 5 — Your code digs out the text.**

```
response.choices[0].message.content
```

That chain of words looks ugly. It means: take the response → take the first answer in the list of answers → take its message → take the text inside.

**The important line:**

> Your code does everything except the guessing. The model does nothing except the guessing.

The model never opens a file. Never searches Google. Never remembers. Never runs code. All of that is **your** job, and it is exactly what Days 2 to 21 teach you to build around it.

---

## 5. Setup

Do this once. About 15 minutes.

### 5.1 — Check Python

Open your terminal and type:

```bash
python3 --version
```

You need 3.10 or higher. If you see a lower number or an error, install Python from python.org first.

### 5.2 — Make the project folders

We set up **both** folders today — Python and Node — even though Node stays empty until later. Doing it now means nothing has to move on Day 20.

```bash
mkdir research-assistant
cd research-assistant
mkdir ai
mkdir dashboard
```

You now have:

```
research-assistant/
├── ai/          ← Python lives here. The AI brain.
└── dashboard/   ← Node lives here. Empty for now.
```

This folder is your project for all 21 days. Never delete it.

### 5.3 — Make a virtual environment

A virtual environment is a **private box for this project's Python libraries**. Without it, every project on your laptop shares the same libraries, and they start fighting each other.

```bash
cd ai
python3 -m venv venv
```

Now switch it on:

```bash
# Mac or Linux:
source venv/bin/activate

# Windows:
venv\Scripts\activate
```

You should now see `(venv)` at the start of your terminal line. That is how you know it is on.

> **Remember this.** Every time you open a new terminal, you must switch it on again. Forgetting this is the number one reason beginners see "module not found" errors.

### 5.4 — Install the two libraries

```bash
pip install openai python-dotenv
```

Wait — the `openai` library, for Groq? Yes. Groq copied OpenAI's shape on purpose, so the same library talks to both. You just point it at a different address. This is a gift: later you can switch from Groq to Gemini or to a model on your own laptop by changing **two lines**.

Save what you installed:

```bash
pip freeze > requirements.txt
```

### 5.5 — Get your free Groq key

1. Go to **console.groq.com**
2. Sign up with email or Google. **No credit card.**
3. Click **API Keys** → **Create API Key**
4. Copy it immediately. You cannot see it again after you close the box.

### 5.6 — Store the key safely

Inside `ai/`, make a file called `.env`:

```
GROQ_API_KEY=gsk_paste_your_key_here
```

No quotes. No spaces around the `=`.

Then make a file called `.gitignore` in the same folder:

```
.env
venv/
__pycache__/
```

**Why this matters.** An API key is a password. If you paste your key directly into your code and later put that code on GitHub, bots find it within minutes. Groq scans for leaked keys and switches them off. `.gitignore` is the list of files that never leave your laptop.

Your folder now:

```
research-assistant/
├── ai/
│   ├── venv/
│   ├── .env
│   ├── .gitignore
│   └── requirements.txt
└── dashboard/
```

---

## 6. Build it

Five small stages. Type every line yourself. Do not copy-paste — typing forces you to read.

---

### Stage 1 — Say hello (8 lines)

Create `ai/hello.py`:

```python
import os
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

client = OpenAI(
    api_key=os.environ["GROQ_API_KEY"],
    base_url="https://api.groq.com/openai/v1"
)

response = client.chat.completions.create(
    model="llama-3.3-70b-versatile",
    messages=[
        {"role": "user", "content": "Explain what an API is, in two sentences."}
    ]
)

print(response.choices[0].message.content)
```

**Line by line:**

- `import os` — lets Python read environment variables (the secret values from `.env`).
- `load_dotenv()` — opens your `.env` file and loads `GROQ_API_KEY` into memory. Without this line, the next line fails.
- `client = OpenAI(...)` — builds your connection object. You make this once and reuse it.
- `api_key=os.environ["GROQ_API_KEY"]` — reads the key from memory, not from the code. The key never appears in the file.
- `base_url="https://api.groq.com/openai/v1"` — **the most important line.** This is what sends your request to Groq instead of OpenAI. Miss it and nothing works.
- `client.chat.completions.create(...)` — this is the actual call. Your program pauses here and waits.
- `model=` — which model does the guessing.
- `messages=[...]` — the list shape from section 4.
- `response.choices[0].message.content` — digging out the text.

Run it:

```bash
python hello.py
```

**What you should see:** two sentences explaining what an API is, appearing after about one second.

**If you see an error, jump to section 9 now.** Errors here are normal and each one has a known cause.

---

### Stage 2 — Look at the raw thing

This stage produces nothing useful. Do it anyway. It builds the single most valuable habit in this entire course.

Add one line to the bottom of `hello.py`:

```python
print(response)
```

Run again. Now you see the whole object, not just the text. Something like:

```
ChatCompletion(
  id='chatcmpl-...',
  choices=[
    Choice(
      finish_reason='stop',
      index=0,
      message=ChatCompletionMessage(
        content='An API is...',
        role='assistant'
      )
    )
  ],
  model='llama-3.3-70b-versatile',
  usage=CompletionUsage(
    completion_tokens=47,
    prompt_tokens=18,
    total_tokens=65
  )
)
```

Three things to notice, because they come back again and again:

- **`finish_reason='stop'`** — the model finished naturally. If you ever see `'length'`, it was cut off mid-sentence because it ran out of room.
- **`usage`** — how much you used. `prompt_tokens` is what you sent, `completion_tokens` is what came back. This is the number your rate limit counts, and later, the number your money counts.
- **`choices` is a list** — that is why you write `[0]`.

**The habit:** whenever something behaves strangely, print the raw object. From Day 16 onwards, frameworks will hide all of this from you. The people who can debug agents are the people who still know how to look underneath.

---

### Stage 3 — Make it an actual chatbot

One answer is not a chatbot. A chatbot keeps talking.

Create `ai/chat.py`:

```python
import os
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

client = OpenAI(
    api_key=os.environ["GROQ_API_KEY"],
    base_url="https://api.groq.com/openai/v1"
)

SYSTEM_PROMPT = "You are a research assistant. Give clear, short answers. If you are not sure about something, say so."

print("Research Assistant is ready. Type 'quit' to stop.\n")

while True:
    question = input("You: ")

    if question.lower() in ["quit", "exit"]:
        print("Goodbye.")
        break

    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": question}
        ]
    )

    answer = response.choices[0].message.content
    print(f"\nAssistant: {answer}\n")
```

**What changed:**

- `SYSTEM_PROMPT` — a standing instruction. The model reads it before every answer. Today we use a simple one. **Day 3 is entirely about this**, and you will find out it is far more powerful than it looks.
- `while True:` — loop forever.
- `input("You: ")` — wait for the human to type.
- The `quit` check — always give yourself a way out. Otherwise `Ctrl+C` is your only escape.
- `f"..."` — an f-string. Python drops the value of `answer` into the text.

Run it:

```bash
python chat.py
```

Talk to it. Ask three or four questions.

**Now do this exact test.** It matters more than anything else today:

```
You: My name is Rahul.
Assistant: Nice to meet you, Rahul! ...

You: What is my name?
Assistant: I don't have access to that information...
```

**It forgot. Ten seconds later.**

This is not a bug, and do not try to fix it. Look at your code — you send a fresh list every single time. The old messages are never included. The model receives only the newest question, and genuinely has no way to know anything came before it.

This is the vending machine. Text in, text out, no memory.

**That feeling of "wait, that's broken" is Day 2.** Sit with it. Tomorrow's fix is smaller than you think, and understanding *why* it works will teach you more than the fix itself.

---

### Stage 4 — Survive the rate limit

Groq's free tier gives you roughly **30 requests per minute** and **6,000 tokens per minute**.

The token limit is the one that will actually bite you. Not today — today your messages are tiny. But by Day 9 your agent will send the whole conversation back on every loop, and you will hit 6,000 tokens per minute fast.

When you hit it, the server says **429**. Most beginners see a crash and assume their code is broken. It is not. It is just "too fast, wait a moment".

Add this properly, today, so it is never a problem again.

At the top of `chat.py`:

```python
import time
from openai import RateLimitError
```

Then add this function just below your `client = OpenAI(...)` block:

```python
def ask_model(messages, max_tries=4):
    for attempt in range(max_tries):
        try:
            return client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=messages
            )
        except RateLimitError:
            wait_seconds = 2 ** attempt
            print(f"[Rate limited. Waiting {wait_seconds}s...]")
            time.sleep(wait_seconds)

    raise RuntimeError("Still rate limited after several tries. Wait a minute.")
```

Now replace the call inside your loop:

```python
    response = ask_model([
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": question}
    ])
```

**What `2 ** attempt` does:** it waits 1 second, then 2, then 4, then 8. Each failure doubles the wait. This is called **exponential backoff**. Waiting longer each time gives the limit room to reset, instead of you hammering a door that is not open yet.

This is a real production pattern, and you now have it on Day 1.

---

### Stage 5 — Streaming (optional, 5 minutes)

Right now you wait in silence, then the whole answer appears at once. Real chat apps show words as they arrive. The total time is the same — it just *feels* far faster.

Add `stream=True` and loop over the pieces:

```python
    stream = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": question}
        ],
        stream=True
    )

    print("\nAssistant: ", end="")
    for chunk in stream:
        piece = chunk.choices[0].delta.content
        if piece:
            print(piece, end="", flush=True)
    print("\n")
```

Two changes worth noticing: it is `delta` now, not `message`, because each chunk is only the *new* part. And `flush=True` forces Python to print immediately instead of saving up text.

Note that streaming and the retry function do not combine neatly — keep `stream=True` in a separate experiment file for now. We handle both properly on Day 15.

---

## 7. Words I heard today

| Word | Plain meaning |
|---|---|
| **LLM** | Large Language Model. A program that guesses the next word, trained on enormous amounts of text. |
| **API** | A way for your code to use someone else's program over the internet. |
| **API key** | A password proving the request is yours. |
| **Client** | The object in your code that handles talking to the API. |
| **base_url** | The address your request is sent to. Changing it changes provider. |
| **Prompt** | The text you send to the model. |
| **Message** | One item in the conversation list — a role plus content. |
| **Role** | Who is speaking: `system`, `user`, or `assistant`. |
| **System prompt** | Standing rules the model reads before every answer. |
| **Token** | A chunk of text, roughly 4 characters or ¾ of a word. Models count tokens, not words. |
| **Inference** | The model doing its guessing. "Running inference" = getting an answer. |
| **Stateless** | Keeps no memory between calls. Every call starts empty. |
| **Rate limit** | A cap on how much you can use per minute or per day. |
| **429** | The error code meaning "you went too fast". |
| **RPM / TPM** | Requests per minute / tokens per minute. |
| **Exponential backoff** | Wait longer after each failed try. |
| **Temperature** | A dial from 0 to 2 for how random the guessing is. |
| **Environment variable** | A value stored outside your code, so secrets stay out of your files. |

---

## 8. Break it on purpose

This is where the learning happens. Do at least three. Write down what you saw.

**1. Turn the randomness dial.**
Add `temperature=0` to your call. Ask "Write one sentence about the ocean" three times. Then change to `temperature=1.8` and ask three more times.
*You will see:* at 0, nearly identical answers. At 1.8, wild and sometimes broken ones.
*It teaches:* low temperature for facts and code, high for creative work. There is no "correct" setting, only the right one for the job.

**2. Squeeze the answer.**
Add `max_tokens=15`. Ask a big question.
*You will see:* it stops mid-sentence. Print the raw response — `finish_reason` now says `'length'`, not `'stop'`.
*It teaches:* the model does not shorten its answer to fit. It gets cut off. Two very different things.

**3. Ask it what you just said.**
Tell it your favourite food. Then ask what your favourite food is.
*You will see:* it has no idea.
*It teaches:* stateless, truly. This is the single most important thing to feel today.

**4. Use a much smaller model.**
Change the model to `llama-3.1-8b-instant`. Ask the same hard question you asked the big one.
*You will see:* much faster, noticeably weaker reasoning.
*It teaches:* model choice is a trade between speed, cost and quality. By Day 15 you will be picking different models for different jobs inside one app.

**5. Tell it to be strange.**
Change your system prompt to: "You are a pirate. Answer everything as a pirate would."
*You will see:* everything changes.
*It teaches:* the system prompt is not decoration. It steers real behaviour. Day 3 turns this into a serious tool.

**6. Break it properly.**
Send `{"role": "user", "content": ""}` — an empty message.
*You will see:* an error from the API, not a polite reply.
*It teaches:* validate what the user typed before you send it. Your code's job, not the model's.

---

## 9. Traps

**Trap 1 — `ModuleNotFoundError: No module named 'openai'`**
*Cause:* your virtual environment is off. You opened a new terminal and forgot.
*Fix:* `source venv/bin/activate` (or `venv\Scripts\activate` on Windows). Look for `(venv)` in your prompt.
*This will happen to you more than once. It is not a real error.*

**Trap 2 — `401` or "Incorrect API key provided"**
*Cause, most likely:* you left out `base_url`. Without it the library goes to OpenAI, and your Groq key is meaningless there.
*Other causes:* key copied with a space, or quotes in `.env`, or `load_dotenv()` missing, or `.env` is in the wrong folder.
*Fix:* check `base_url` first. Then `print(os.environ["GROQ_API_KEY"][:8])` to confirm the key is actually loading.

**Trap 3 — `404` or "model not found" or "model has been decommissioned"**
*Cause:* Groq retires model names. They change more often than you would expect.
*Fix:* open **console.groq.com/docs/models**, take the current name, paste it in. Keep the model name in one variable at the top of your file so you only ever change it in one place.

**Trap 4 — `429 Too Many Requests`**
*Cause:* over 30 requests or 6,000 tokens in a minute.
*Fix:* your Stage 4 retry function. If it still fails after four tries, you are properly over the limit — wait a minute, or switch to a smaller model.
*Note:* the limit is on your whole account, not per key. Making a second key does not help.

**Trap 5 — silent and expensive: the key in your code**
*Cause:* pasting the key directly to "just test quickly", then forgetting.
*Symptom:* nothing, for weeks. Then your key stops working, because a bot found it on GitHub.
*Fix:* `.env` from the very first minute. Never the exception, not even once.

---

## 10. Check yourself

Answer out loud, from memory, before looking. Answers at the very bottom.

1. Why does the chatbot forget your name ten seconds after you tell it?
2. What does `base_url` do, and what happens if you leave it out?
3. What are the three roles in a message list, and who does each one represent?
4. What is the difference between `finish_reason` being `'stop'` and being `'length'`?
5. You hit a 429 error. What actually happened, and what should your code do about it?

If you cannot answer question 1 clearly, do not start Day 2. Re-read section 4.

---

## 11. Where this goes

- **Day 2** fixes the forgetting. You will send the old messages back along with the new one. That is the whole trick — but *what* to send, and what to leave out, becomes a real problem later.
- **Day 3** takes your one-line system prompt and turns it into reliable, controlled behaviour.
- **Day 4** adds the `tools` parameter to this exact same call, and suddenly the model can trigger your Python functions.
- **Day 15** comes back to this file with cost tracking, proper error handling and model switching.
- **Day 20** wraps `chat.py` in FastAPI so your Node dashboard can call it over HTTP.

Everything in this course is this one API call, with more and more built around it.

---

## 12. PROJECT STATE

*Copy this into tomorrow's prompt.*

```
PROJECT STATE after Day 1:

Folders:
  research-assistant/
    ai/          (Python, venv active, .env with GROQ_API_KEY, .gitignore)
      hello.py   (single test call, prints raw response object)
      chat.py    (the main chatbot)
      requirements.txt
    dashboard/   (empty, Node goes here later)

Libraries: openai, python-dotenv
Model: llama-3.3-70b-versatile via Groq, OpenAI-compatible client, base_url set

What chat.py can do now:
  - loops and takes typed input until the user types quit
  - has a SYSTEM_PROMPT variable set to a basic research-assistant instruction
  - calls the model through an ask_model() helper with exponential backoff
    retry on RateLimitError (1s, 2s, 4s, 8s, four tries)
  - prints the answer

Key decisions made:
  - API key in .env, never in code
  - all calls go through ask_model(), not direct calls, so retry is everywhere
  - model name lives in one place so it is easy to change
  - streaming tested separately with stream=True, not merged into chat.py yet

Not done on purpose:
  - NO memory. Each call sends only the system prompt and the newest question.
    The bot forgets everything between messages. This is Day 2's job.
  - system prompt is deliberately basic. Day 3 handles it properly.
```

---

## Answers

**1.** Because you build a brand new `messages` list on every loop, containing only the system prompt and the newest question. The old messages are never sent. The model is stateless — it has no storage of its own, so if it is not in the list you send, it does not exist.

**2.** It sets the internet address the request goes to. The `openai` library defaults to OpenAI's servers. Setting it to `https://api.groq.com/openai/v1` redirects to Groq. Leave it out and your Groq key gets sent to OpenAI, which rejects it with a 401.

**3.** `system` is you, the builder, giving standing rules. `user` is the human typing. `assistant` is the model's own past replies.

**4.** `'stop'` means the model finished its thought naturally. `'length'` means it was still talking and got cut off because it reached the token limit. The answer is incomplete, not shorter.

**5.** You sent more than the free tier allows in one minute — over 30 requests or, more likely, over 6,000 tokens. Your code should catch it, wait, and try again, doubling the wait each time. It should not crash, and it should not retry instantly.
