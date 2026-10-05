# Day 0 — Start Here: The Syllabus

**Module:** 00 — Start Here
**Time:** about 20 minutes
**Purpose:** Your roadmap, your stack, and how to study. Read this once before Day 1.

---

## 1. What you will have at the end

A working AI research agent that you built yourself, running as a real service, with a dashboard in front of it. Not a tutorial copy. Your own code, which you can explain line by line and change without fear.

More importantly: you will be able to build things that are not in any tutorial, because you will understand what is happening underneath.

---

## 2. The big idea (read this twice)

Twenty-one topics looks like a mountain. It is not. These are really six ideas, taught three times each, a little deeper every time.

| Idea | What it means in plain words | Days |
|---|---|---|
| **The call** | Send text to a model, get text back | 1 |
| **State** | Remembering what happened before | 2, 11 |
| **Instruction** | Controlling behaviour using words | 3 |
| **Tools** | Letting the model trigger your own functions | 4, 8, 13 |
| **Retrieval** | Giving the model knowledge it does not have | 5, 6, 12 |
| **The loop** | Model decides, acts, looks at the result, repeats | 7, 9, 10, 14 |

Everything after Day 14 is packaging: making it reliable (15), using someone else's version of these six (16 to 19), putting it online (20), and joining it all together (21).

> An AI agent is a loop, plus a model, plus tools, plus memory, plus a rule for when to stop.

That is the whole secret. The 21 days simply make each of those five words rich.

---

## 3. The 21 days

Five modules. Each day has one real question it answers.

### 01 — Build the Foundation (Days 1 to 5)

| Day | Topic | The question it answers |
|---|---|---|
| 1 | Build Your First AI Chatbot | How do I talk to a model from my own code? |
| 2 | Conversation Memory | Why does it forget, and what do I send back? |
| 3 | Prompt Engineering | How do I make behaviour reliable, not lucky? |
| 4 | AI Tools | How does a text model actually do things? |
| 5 | Document AI: Read Files | How do I get my own data into the prompt? |

### 02 — AI Agents (Days 6 to 9)

| Day | Topic | The question it answers |
|---|---|---|
| 6 | Build Your First RAG System | What if my data is too big for the prompt? |
| 7 | Build Your First AI Agent | Who decides the next step, me or the model? |
| 8 | Model Context Protocol (MCP) | How do tools become reusable everywhere? |
| 9 | Autonomous AI Agent | How does it run without me approving each step? |

### 03 — Advanced Agent Systems (Days 10 to 15)

| Day | Topic | The question it answers |
|---|---|---|
| 10 | Advanced Agent Planning | How does it break a big goal into steps? |
| 11 | Memory Engineering | What should it remember, and what should it forget? |
| 12 | Advanced RAG | Why is it finding the wrong information? |
| 13 | MCP in Depth | How do I build my own tool server, safely? |
| 14 | Multi-Agent Systems and Orchestration | When are many agents better than one? |
| 15 | Making AI Agent Production Ready | Cost, speed, failures, limits, testing. |

### 04 — Frameworks (Days 16 to 19)

| Day | Topic | The question it answers |
|---|---|---|
| 16 | LangGraph | Agents drawn as a map of states. |
| 17 | CrewAI | Agents as roles in a team. |
| 18 | Build Our AI Research Agent | A full build using a framework. |
| 19 | LangChain for Agent Engineers | The glue layer, and when to avoid it. |

### 05 — Deployment and Capstone (Days 20 to 21)

| Day | Topic | The question it answers |
|---|---|---|
| 20 | AI Agent Deployment | Putting it online so other people can use it. |
| 21 | Capstone: Research AI Agent Platform | Build the whole thing. Ship it. |

---

## 4. One project, twenty-one upgrades

You will not build 21 small throwaway scripts. You build one thing and add to it every day: a **Research Assistant**. By Day 21 the capstone is already most of the way built.

| After day | Your assistant can... |
|---|---|
| Day 1 | Reply to you |
| Day 2 | Remember the conversation |
| Day 3 | Follow rules and behave consistently |
| Day 4 | Run your own Python functions |
| Day 5 | Read a file you give it |
| Day 6 | Search across many documents |
| Day 7 | Choose its own next step |
| Day 9 | Work alone, without you approving each step |
| Day 11 | Remember things across days, not just one chat |
| Day 14 | Split work between several agents |
| Day 20 | Run online as a real service |
| Day 21 | Be a platform, with your dashboard in front |

---

## 5. Your stack

Two languages, two jobs. This is also how real teams build, so you are not making a compromise.

| Part | Choice | Why |
|---|---|---|
| AI code | Python | All the AI libraries live here |
| Dashboard, UI | Node.js | Better at web things |
| They talk by | HTTP | Python is the brain, Node is the face |
| Model | Groq free tier, `llama-3.3-70b-versatile` | Free, no card, fast, does tool calling |
| Backup model | Gemini free tier | For when Groq limits you |
| Embeddings | sentence-transformers, on your laptop | Free and unlimited, no API needed |
| Vector store | Chroma, local | No server, no account |
| Python server | FastAPI | Needed from Day 20 |

**One decision worth understanding.** All model calls are written using the OpenAI-compatible client. Groq, Gemini and models running on your own laptop all accept that same shape. So changing provider means changing two lines, never rewriting your code.

**One warning.** The Groq free tier allows roughly 30 requests and 6,000 tokens per minute. The token limit is the one that bites. From Day 9 your agent sends the whole conversation on every loop. That is why retry-with-waiting goes into your code on Day 1, not Day 15.

---

## 6. Before you start Day 1

You do not need to know AI. You do need these. If two or more are shaky, spend one day on them first. It will save you a week of confusion.

- Python: functions, lists, dictionaries, loops
- Running `pip install` and knowing what a virtual environment is
- Reading a Python error message without panic
- Using a terminal: moving between folders, running a file
- Basic JavaScript, for the dashboard side only (needed from Day 20)

Also: a laptop with about 4 GB of free space, and a free Groq account from **console.groq.com**. No credit card is needed anywhere in this course.

---

## 7. How to study each day

Five stages, always in this order. Most people stop after stage two. **The learning is in stage three.**

| Stage | Time | What it means |
|---|---|---|
| 1. READ | 20 min | Read the lesson once. Do not type anything yet. |
| 2. CODE | 45 min | Type it yourself. Never copy-paste. Typing forces you to read. |
| 3. EXPERIMENT | 45 min | Break it on purpose. This is the real class. |
| 4. UNDERSTAND | 20 min | Answer the check questions out loud, without looking. |
| 5. BUILD | 30 min | Make one small change that is yours, not the lesson's. |

Short on time? Read 20, Code 30, Experiment 30. Ninety minutes is enough. Never skip Experiment. Cutting that is cutting the course.

---

## 8. The six rules

1. **Type the code.** Copy-paste teaches your fingers nothing and your head less.
2. **Print the raw thing.** The actual prompt sent, the actual tool call, the actual text found. Frameworks hide these. People who can debug agents are the people who still look underneath.
3. **Break something every day.** Change a number to an extreme. Delete a line that looks important. Read the error properly.
4. **Do not skip ahead to the frameworks.** Days 16 to 19 will make Days 7 to 14 look like wasted time. They are not. Learn the framework first and you will never be able to fix it, because you will not know what it is doing.
5. **Keep one notes file.** After each day, paste in the PROJECT STATE block. That is how the next day knows what you already built.
6. **Explain it to someone.** Out loud, no notes. If you cannot, you have not learned it yet. That is useful information, not failure.

---

## 9. Checkpoints: how to know it is working

At these points, you should be able to do the following with no notes in front of you.

| After | You should be able to... |
|---|---|
| Day 5 | Explain why the model forgets, and draw what is actually sent on message number ten of a conversation. |
| Day 9 | Draw the agent loop on paper and name its stopping rule. Say when retrieval is the wrong answer. |
| Day 15 | Say why your agent is slow and expensive, and name the three things you would change first. |
| Day 19 | Read framework code and say what it is doing underneath. |
| Day 21 | Build something that is not in this syllabus, without a tutorial. |

If you fail a checkpoint, stop and go back. Falling behind the schedule costs you a few days. Falling behind the understanding costs you the whole course.

Now open Day 1. The first thing you build takes eight lines of code.
