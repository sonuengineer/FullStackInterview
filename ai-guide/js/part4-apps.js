/* Part 4: AI in real apps */
(function () {
  const { $, el, clear, rich, seg, picks, tabs } = G;

  /* ====================================================== Memory */
  const CHAT = [
    ["you", "Hi! My name is Sam.", 8],
    ["ai", "Hello Sam! How can I help?", 9],
    ["you", "I am learning React.", 7],
    ["ai", "Great choice. Start with components.", 10],
    ["you", "What is a component?", 7],
    ["ai", "A reusable piece of the page, like a button.", 12],
    ["you", "And what are props?", 6],
    ["ai", "Inputs you pass into a component.", 9],
    ["you", "What is my name?", 6]
  ];

  let memStep = 4;

  function renderMemory() {
    const cap = Number($("#window-size").value);
    const shown = CHAT.slice(0, memStep);
    const inWin = new Array(shown.length).fill(false);
    let used = 0;

    for (let i = shown.length - 1; i >= 0; i--) {
      if (used + shown[i][2] > cap) break;
      used += shown[i][2];
      inWin[i] = true;
    }

    const box = clear($("#window"));
    shown.forEach((m, i) => {
      const row = el("div", "msg " + (inWin[i] ? "in" : "out"));
      row.appendChild(el("span", "who", m[0]));
      row.appendChild(el("span", "text", m[1]));
      row.appendChild(el("span", "tk", inWin[i] ? m[2] + " tok" : "not seen"));
      box.appendChild(row);
    });

    if (memStep === CHAT.length) {
      const knows = inWin[0];
      const answer = el("div", "msg answer " + (knows ? "good" : "bad"));
      answer.appendChild(el("span", "who", "ai"));
      answer.appendChild(el("span", "text", knows ? "Your name is Sam." : "Sorry, I do not know your name. (The first message fell out of the window.)"));
      answer.appendChild(el("span", "tk", knows ? "remembered" : "forgot"));
      box.appendChild(answer);
    }

    $("#meter-label").textContent = used + " / " + cap + " tokens";
    const fill = $("#meter-fill");
    fill.style.width = Math.min(100, (used / cap) * 100) + "%";
    fill.classList.toggle("full", inWin.includes(false));

    const btn = $("#mem-next");
    btn.disabled = memStep >= CHAT.length;
    btn.textContent = memStep >= CHAT.length ? "Chat finished" : "Send next message";
  }

  $("#mem-next").addEventListener("click", () => {
    if (memStep < CHAT.length) memStep++;
    renderMemory();
  });
  $("#mem-reset").addEventListener("click", () => {
    memStep = 4;
    renderMemory();
  });
  $("#window-size").addEventListener("change", renderMemory);
  renderMemory();

  /* ====================================================== Long chats */
  const LC = {
    RECENT: 4,
    EVERY_N: 2,
    BUDGET: 100,
    MIN_KEEP: 2,
    SUMMARY_MAX: 40,
    SUMMARY_MIN: 10,
    MAX_ROUNDS: 5
  };

  const LC_FIELDS = ["user", "topics", "decisions", "details", "open_items"];
  const LC_TRIM_ORDER = ["topics", "open_items", "details", "decisions", "user"];

  const LC_PAIRS = [
    { u: "Hi, I'm Sam.", ut: 6, a: "Hello Sam! How can I help?", at: 8, fact: ["user", "Name is Sam"] },
    { u: "I'm learning React.", ut: 6, a: "Great! Start with components.", at: 8, fact: ["topics", "Learning React"] },
    { u: "What are props?", ut: 5, a: "Inputs you pass into a component.", at: 9, fact: ["decisions", "Props = component inputs"] },
    { u: "And what is state?", ut: 6, a: "Data a component keeps and can change.", at: 10, fact: ["decisions", "State = data that changes"] },
    { u: "Please keep answers short.", ut: 6, a: "Sure, short answers from now on.", at: 8, fact: ["user", "Wants short answers"] },
    { u: "How do I load data?", ut: 6, a: "Call fetch inside useEffect.", at: 8, fact: ["decisions", "Load data in useEffect"] },
    { u: "My API runs on port 3000.", ut: 8, a: "Then fetch from localhost:3000/api.", at: 10, fact: ["details", "API on port 3000"] },
    { u: "What if the request fails?", ut: 7, a: "Wrap it in try/catch and show a message.", at: 10, fact: ["decisions", "Handle errors with try/catch"] },
    { u: "Can I save history in SQLite?", ut: 8, a: "Yes, one row per message.", at: 7, fact: ["topics", "Chat history in SQLite"] },
    { u: "Thanks! What should I learn next?", ut: 8, a: "Next, learn routing with React Router.", at: 9, fact: ["open_items", "Learn React Router next"] }
  ];

  const LC_LONG = {
    u: "Here is my whole App.jsx file: import { useState } from \"react\" ... (200 lines)",
    ut: 60,
    a: "Found it: your effect runs on every render.",
    at: 12,
    fact: ["details", "Bug: effect runs every render"]
  };

  let lc;

  function lcEmptySummary() {
    return { user: [], topics: [], decisions: [], details: [], open_items: [] };
  }

  const lcItemTokens = (text) => Math.ceil(text.length / 4) + 1;

  function lcSummaryTokens() {
    const items = LC_FIELDS.flatMap((f) => lc.summary[f]);
    return items.length ? 4 + items.reduce((sum, item) => sum + lcItemTokens(item), 0) : 0;
  }

  const lcUnsummarized = () => lc.msgs.filter((m) => m.id > lc.cursor);
  const lcContextTokens = () => lcSummaryTokens() + lcUnsummarized().reduce((sum, m) => sum + m.tokens, 0);
  const lcRange = (list) => (list.length === 1 ? "#" + list[0].id : "#" + list[0].id + "-#" + list[list.length - 1].id);

  /** Remove least important items until the summary fits. Returns how many were removed. */
  function lcEnforce(limit) {
    let removed = 0;
    let index = 0;
    while (lcSummaryTokens() > limit && LC_FIELDS.some((f) => lc.summary[f].length)) {
      const field = LC_TRIM_ORDER[index % LC_TRIM_ORDER.length];
      if (lc.summary[field].length) {
        lc.summary[field].shift();
        removed++;
      }
      index++;
    }
    return removed;
  }

  function lcFold(list, events) {
    list.forEach((m) => {
      if (m.fact && !lc.summary[m.fact[0]].includes(m.fact[1])) lc.summary[m.fact[0]].push(m.fact[1]);
    });
    lc.cursor = list[list.length - 1].id;
    const removed = lcEnforce(LC.SUMMARY_MAX);
    return () => {
      if (removed) {
        events.push(["warn", "The summary went over its " + LC.SUMMARY_MAX + "-token limit, so " + removed + " least important item(s) were dropped. It can never grow past the limit."]);
      }
    };
  }

  function lcSend(pair) {
    const events = [];
    const userId = ++lc.nextId;
    lc.msgs.push({ id: userId, role: "you", text: pair.u, tokens: pair.ut, fact: pair.fact });
    events.push(["info", "Saved your message #" + userId + " (" + pair.ut + " tokens) in the database."]);

    // Before calling the AI: count, and compact while over budget
    let tokens = lcContextTokens();
    events.push([tokens > LC.BUDGET ? "bad" : "info", "Counted the context: " + tokens + " / " + LC.BUDGET + " tokens" + (tokens > LC.BUDGET ? ". Over budget!" : ". Fits.")]);

    for (let round = 1; tokens > LC.BUDGET && round <= LC.MAX_ROUNDS; round++) {
      const tail = lcUnsummarized();
      const foldable = tail.length - LC.MIN_KEEP;

      if (foldable > 0) {
        const batch = tail.slice(0, Math.ceil(foldable / 2));
        const reportTrim = lcFold(batch, events);
        events.push(["warn", "Compaction round " + round + ": folded " + lcRange(batch) + " into the summary."]);
        reportTrim();
      } else {
        const current = lcSummaryTokens();
        const target = Math.floor(current / 2);
        if (current === 0 || target < LC.SUMMARY_MIN) {
          events.push(["bad", "Cannot shrink more. The newest " + tail.length + " messages alone are over the budget, so they are sent anyway."]);
          break;
        }
        const removed = lcEnforce(target);
        events.push(["warn", "Compaction round " + round + ": only the newest " + tail.length + " messages are left (never folded), so the summary was cut from " + current + " to " + lcSummaryTokens() + " tokens by dropping " + removed + " item(s)."]);
      }

      tokens = lcContextTokens();
      events.push([tokens > LC.BUDGET ? "bad" : "good", "Counted again: " + tokens + " / " + LC.BUDGET + " tokens."]);
    }

    lc.lastSent = tokens;
    events.push(["good", "Sent to the AI: summary + " + lcUnsummarized().length + " full messages."]);

    const aiId = ++lc.nextId;
    lc.msgs.push({ id: aiId, role: "ai", text: pair.a, tokens: pair.at, fact: null });
    events.push(["info", "AI replied. Saved as message #" + aiId + "."]);

    // After the reply: periodic summary update
    const tail = lcUnsummarized();
    const threshold = LC.RECENT + LC.EVERY_N;
    if (tail.length >= threshold) {
      const batch = tail.slice(0, tail.length - LC.RECENT);
      const reportTrim = lcFold(batch, events);
      events.push(["good", "Regular update: " + tail.length + " messages were waiting, so " + lcRange(batch) + " went into the summary. The newest " + LC.RECENT + " stay as full text."]);
      reportTrim();
    } else {
      events.push(["info", tail.length + " messages not in the summary yet. The next update runs at " + threshold + "."]);
    }

    lc.events = events;
  }

  function lcReset() {
    lc = { msgs: [], cursor: 0, summary: lcEmptySummary(), nextId: 0, nextPair: 0, events: [], lastSent: 0 };
    for (let i = 0; i < 3; i++) lcSend(LC_PAIRS[lc.nextPair++]);
    renderLongChat();
  }

  function renderLongChat() {
    const sumTokens = lcSummaryTokens();
    const msgTokens = lcUnsummarized().reduce((sum, m) => sum + m.tokens, 0);
    const total = sumTokens + msgTokens;
    const scale = Math.max(LC.BUDGET * 1.4, total);

    $("#lc-fill-sum").style.width = (sumTokens / scale) * 100 + "%";
    $("#lc-fill-msg").style.width = (msgTokens / scale) * 100 + "%";
    $("#lc-fill-msg").classList.toggle("full", total > LC.BUDGET);
    $("#lc-line").style.left = (LC.BUDGET / scale) * 100 + "%";
    $("#lc-meter-label").textContent = "Next request: " + total + " / " + LC.BUDGET + " tokens (summary " + sumTokens + " + messages " + msgTokens + ")";
    const state = $("#lc-meter-state");
    clear(state).appendChild(el("span", "pill " + (total > LC.BUDGET ? "bad" : total >= LC.BUDGET * 0.8 ? "warn" : "good"), total > LC.BUDGET ? "over budget" : total >= LC.BUDGET * 0.8 ? "near budget" : "fits"));

    const db = clear($("#lc-db"));
    lc.msgs.forEach((m) => {
      const folded = m.id <= lc.cursor;
      const row = el("div", "db-row" + (folded ? " folded" : ""));
      row.appendChild(el("span", "id", "#" + m.id));
      row.appendChild(el("span", "who", m.role));
      const text = el("span", "text", m.text);
      text.title = m.text;
      row.appendChild(text);
      row.appendChild(el("span", "state " + (folded ? "summary" : "sent"), folded ? "in summary" : m.tokens + " tok"));
      db.appendChild(row);
    });
    db.scrollTop = db.scrollHeight;

    $("#lc-sum-label").textContent = "Summary (JSON, " + sumTokens + " / " + LC.SUMMARY_MAX + " tokens)";
    const summary = clear($("#lc-summary"));
    LC_FIELDS.forEach((field) => {
      const row = el("div", "f");
      row.appendChild(el("span", "k", field));
      row.appendChild(el("span", null, lc.summary[field].length ? lc.summary[field].join("; ") : "-"));
      summary.appendChild(row);
    });

    const log = clear($("#lc-log"));
    lc.events.forEach(([tone, text]) => log.appendChild(el("li", tone, text)));

    const done = lc.nextPair >= LC_PAIRS.length;
    $("#lc-send").disabled = done;
    $("#lc-send").textContent = done ? "No more example messages" : "Send next message";
  }

  $("#lc-send").addEventListener("click", () => {
    if (lc.nextPair < LC_PAIRS.length) lcSend(LC_PAIRS[lc.nextPair++]);
    renderLongChat();
  });
  $("#lc-long").addEventListener("click", () => {
    lcSend(LC_LONG);
    renderLongChat();
  });
  $("#lc-reset").addEventListener("click", lcReset);
  lcReset();

  /* ====================================================== Tools */
  const TOOL_DEFS =
    "tools: [\n" +
    "  { name: \"get_weather\",\n    description: \"Current weather for a city\",\n    parameters: { city: \"string\" } },\n" +
    "  { name: \"calculator\",\n    description: \"Exact math on an expression\",\n    parameters: { expression: \"string\" } },\n" +
    "  { name: \"send_email\",\n    description: \"Send an email. Needs user approval.\",\n    parameters: { to: \"string\", subject: \"string\", body: \"string\" } }\n" +
    "]";

  const callJson = (name, args) =>
    "{\n  \"function_call\": {\n    \"name\": \"" + name + "\",\n    \"args\": " + JSON.stringify(args, null, 2).replace(/\n/g, "\n    ") + "\n  }\n}";

  const resultJson = (name, response) =>
    "{\n  \"function_response\": {\n    \"name\": \"" + name + "\",\n    \"response\": " + JSON.stringify(response) + "\n  }\n}";

  const TOOL_QUESTIONS = [
    {
      q: "What's the weather in Tokyo right now?",
      build: () => [
        { who: "Your app -> AI", title: "Send the question and the list of tools", code: "user: \"What's the weather in Tokyo right now?\"\n\n" + TOOL_DEFS },
        { who: "AI -> your app", title: "The AI asks for a tool. It does not run it.", code: callJson("get_weather", { city: "Tokyo" }) },
        { who: "Your server runs code", title: "Your code calls a real weather service", code: "const result = await getWeather(\"Tokyo\");\n// example result:\n{ \"temp_c\": 18, \"sky\": \"light rain\" }" },
        { who: "Your app -> AI", title: "Send the result back", code: resultJson("get_weather", { temp_c: 18, sky: "light rain" }) },
        { who: "AI -> user", title: "The AI writes the final answer", text: "It is 18 C with light rain in Tokyo right now. Take an umbrella!" }
      ]
    },
    {
      q: "What is 23.5% of 1,840?",
      build: () => [
        { who: "Your app -> AI", title: "Send the question and the list of tools", code: "user: \"What is 23.5% of 1,840?\"\n\n" + TOOL_DEFS },
        { who: "AI -> your app", title: "The AI knows guessing math is risky, so it asks for the calculator", code: callJson("calculator", { expression: "0.235 * 1840" }) },
        { who: "Your server runs code", title: "Your code does the exact math", code: "const result = calculate(\"0.235 * 1840\");\n// result:\n{ \"result\": 432.4 }" },
        { who: "Your app -> AI", title: "Send the result back", code: resultJson("calculator", { result: 432.4 }) },
        { who: "AI -> user", title: "The AI writes the final answer", text: "23.5% of 1,840 is 432.4." }
      ]
    },
    {
      q: "What is the capital of France?",
      build: () => [
        { who: "Your app -> AI", title: "Send the question and the list of tools", code: "user: \"What is the capital of France?\"\n\n" + TOOL_DEFS },
        { who: "AI -> user", title: "No tool needed. It answers directly.", text: "The capital of France is Paris.", note: "The model already knows this fact, so it does not call any tool. Tools are only used when needed." }
      ]
    },
    {
      q: "Email my boss that I'll be 20 minutes late.",
      approval: true,
      build: (decision) => {
        const args = { to: "boss@company.com", subject: "Running late", body: "Hi, I will be about 20 minutes late today. Sorry!" };
        const steps = [
          { who: "Your app -> AI", title: "Send the request and the list of tools", code: "user: \"Email my boss that I'll be 20 minutes late.\"\n\n" + TOOL_DEFS },
          { who: "AI -> your app", title: "The AI prepares a send_email call", code: callJson("send_email", args) },
          { who: "Your app asks you", title: "Sending email is a real action, so your app asks first", approval: true }
        ];
        if (decision === "approve") {
          steps.push(
            { who: "Your server runs code", title: "You approved. Your code sends the email.", code: "await sendEmail(args);\n// result:\n{ \"status\": \"sent\" }" },
            { who: "Your app -> AI", title: "Send the result back", code: resultJson("send_email", { status: "sent" }) },
            { who: "AI -> user", title: "The AI confirms", text: "Done. I emailed your boss that you will be about 20 minutes late." }
          );
        } else if (decision === "deny") {
          steps.push(
            { who: "Your app -> AI", title: "You said no. The app tells the AI.", code: resultJson("send_email", { status: "cancelled_by_user" }) },
            { who: "AI -> user", title: "The AI responds", text: "Okay, I did not send the email. Do you want me to change the message first?" }
          );
        }
        return steps;
      }
    }
  ];

  let toolIndex = 0;
  let toolDecision = null;

  function renderTools() {
    const question = TOOL_QUESTIONS[toolIndex];
    const steps = question.build(toolDecision);
    const flow = clear($("#tool-flow"));

    steps.forEach((step, i) => {
      const card = el("div", "tool-step" + (step.approval && !toolDecision ? " wait" : ""));
      const head = el("div", "head");
      head.appendChild(el("span", "num", String(i + 1)));
      head.appendChild(el("span", "pill info", step.who));
      head.appendChild(el("strong", null, step.title));
      card.appendChild(head);

      if (step.code) card.appendChild(el("pre", "code", step.code));
      if (step.text) card.appendChild(el("div", "answer good", step.text));
      if (step.note) card.appendChild(el("p", "note", step.note));

      if (step.approval) {
        if (!toolDecision) {
          card.appendChild(el("p", null, "Send this email to boss@company.com? Nothing happens until you choose."));
          const row = el("div", "row");
          const yes = el("button", "btn primary", "Approve");
          const no = el("button", "btn danger", "Deny");
          yes.type = "button";
          no.type = "button";
          yes.addEventListener("click", () => { toolDecision = "approve"; renderTools(); });
          no.addEventListener("click", () => { toolDecision = "deny"; renderTools(); });
          row.appendChild(yes);
          row.appendChild(no);
          card.appendChild(row);
        } else {
          card.appendChild(rich("p", ["You chose: ", [toolDecision === "approve" ? "Approve" : "Deny", "pill " + (toolDecision === "approve" ? "good" : "bad")]]));
        }
      }

      flow.appendChild(card);
    });
  }

  picks($("#tool-questions"), TOOL_QUESTIONS.map((t) => t.q), 0, (i) => {
    toolIndex = i;
    toolDecision = null;
    renderTools();
  });
  renderTools();

  /* ====================================================== Limits */
  const LIMITS = [
    ["bad", "Check it", "It makes things up", "When it does not know, it can invent facts, links, names or code functions, and still sound 100% sure. This is called a \"hallucination\".", "Check important facts. Ask for sources. Test the code."],
    ["warn", "Know this", "It has no memory", "Every request starts fresh. It only \"remembers\" because the app sends old messages again inside the context window.", "Save chat history in your app and send it (or a summary) with each request."],
    ["warn", "Know this", "Its knowledge has an end date", "It learned from text up to a certain date (the \"knowledge cutoff\"). It does not know news or new versions after that.", "Give it the fresh info in the prompt, or connect a search tool."],
    ["bad", "Check it", "Weak at exact math and counting", "It predicts text that looks right. It does not really calculate, so big numbers or counting letters can go wrong.", "Let it use a calculator tool, or ask it to write and run code."],
    ["good", "Easy fix", "Unclear question, unclear answer", "Small changes in how you ask can change the answer a lot. It cannot read your mind about format or level.", "Say who it is for, the format you want, and give an example."],
    ["bad", "Check it", "It can repeat human bias", "It learned from human writing, so it can repeat unfair ideas or one-sided views found in that writing.", "Ask for other viewpoints. Use human review for decisions about people."]
  ];

  const limitsBox = $("#limits-list");
  LIMITS.forEach(([tone, pillText, title, text, fixText]) => {
    const card = el("article", "limit");
    card.appendChild(el("span", "pill " + tone, pillText));
    card.appendChild(el("h4", null, title));
    card.appendChild(el("p", null, text));
    card.appendChild(rich("p", [["What to do: ", null, "b"], fixText], "fix"));
    limitsBox.appendChild(card);
  });

  /* ====================================================== Improve */
  const IMPROVE = [
    ["Better prompt", "Prompt engineering", "Write clearer instructions. Say the role, the goal, the format, and show 1 or 2 examples of a good answer.", 1, 1, "Always. Start here first.", true],
    ["Tools / agents", "Function calling", "Let the AI use tools you give it: search the web, run code, read a database, send an email. It decides when to use them.", 2, 2, "It needs live data or must do actions, not only talk.", false],
    ["RAG", "Retrieval-Augmented Generation", "Search your own documents first, then paste the useful parts into the prompt. The AI answers from that text.", 2, 2, "It must answer from your own files, docs or company data.", false],
    ["Fine-tuning", "Extra training", "Train the model a bit more on hundreds or thousands of your own examples, so the style becomes built in.", 3, 3, "You need a fixed style or format and have many good examples.", false]
  ];

  function dots(n) {
    const d = el("span", "dots");
    d.setAttribute("aria-label", n + " of 3");
    for (let i = 1; i <= 3; i++) d.appendChild(el("i", i <= n ? "on" : ""));
    return d;
  }

  const improveBody = $("#improve-body");
  IMPROVE.forEach(([name, alias, text, effort, cost, when, start]) => {
    const tr = el("tr");
    const nameTd = el("td");
    nameTd.appendChild(document.createTextNode(name));
    if (start) nameTd.appendChild(el("span", "start-here", "start"));
    nameTd.appendChild(el("small", null, alias));
    tr.appendChild(nameTd);
    tr.appendChild(el("td", null, text));
    const effortTd = el("td");
    effortTd.appendChild(dots(effort));
    tr.appendChild(effortTd);
    const costTd = el("td");
    costTd.appendChild(dots(cost));
    tr.appendChild(costTd);
    tr.appendChild(el("td", null, when));
    improveBody.appendChild(tr);
  });

  /* ====================================================== Framework, deploy, FDE */
  function buildFramework(panel) {
    panel.appendChild(el("h4", "sub-title", "Framework = a ready-made structure for your app"));
    panel.appendChild(el("p", null, "Building an app from zero is like building a house from zero. A framework is the frame of the house: rooms, walls and pipes are already planned. You fill in your own parts, in the places the framework expects."));

    let view = "library";
    const segBox = el("div");
    const result = el("div", "stack-v");

    function render() {
      clear(result);
      if (view === "library") {
        result.appendChild(el("p", null, "A library is a toolbox. YOUR code is the boss and calls the library when it needs something."));
        result.appendChild(el("pre", "code", "// You decide when to call it\nimport { format } from \"date-fns\";\n\nconst text = format(new Date(), \"dd MMM yyyy\");"));
      } else {
        result.appendChild(el("p", null, "A framework is the boss. It runs the app and calls YOUR code at the right moment. You follow its rules and folder structure."));
        result.appendChild(el("pre", "code", "// Express calls your function when a request arrives\napp.post(\"/api/chat\", async (req, res) => {\n  // your code here\n});"));
      }
    }

    panel.appendChild(segBox);
    panel.appendChild(result);
    seg(segBox, [{ value: "library", label: "Library: you call it" }, { value: "framework", label: "Framework: it calls you" }], view, (v) => { view = v; render(); });
    render();

    const scroll = el("div", "scroll-x");
    const table = el("table", "data-table");
    table.innerHTML = "<thead><tr><th>You are building</th><th>Popular frameworks</th></tr></thead>";
    const body = el("tbody");
    [
      ["A website or web app", "Next.js, Angular, Vue (Nuxt)"],
      ["A server / API", "Express, FastAPI, Django"],
      ["An AI app or agent", "LangChain, LlamaIndex, Google ADK"],
      ["Training AI models", "PyTorch, TensorFlow, JAX"]
    ].forEach(([what, examples]) => {
      const tr = el("tr");
      tr.appendChild(el("td", null, what));
      tr.appendChild(el("td", null, examples));
      body.appendChild(tr);
    });
    table.appendChild(body);
    scroll.appendChild(table);
    panel.appendChild(scroll);
  }

  const DEPLOY_CHECKS = [
    "The app works correctly on my own computer",
    "The AI API key is only on the server, never in React code",
    "Settings are in environment variables (.env), not written in the code",
    "A token budget and max output size are set, so costs stay under control",
    "Errors are handled: users see a clear message when the AI fails",
    "Rate limits: one user cannot send 1,000 requests a minute",
    "Logs and usage monitoring are turned on",
    "HTTPS and a domain name are set up"
  ];

  function buildDeploy(panel) {
    panel.appendChild(el("h4", "sub-title", "Deploy = move your app from your computer to a server"));
    panel.appendChild(el("p", null, "On your computer (localhost) only you can use the app. Deploying puts it on a server that is always on and reachable on the internet, so anyone with the link can use it."));

    const pipeline = el("div", "pipeline");
    [
      ["Your computer", "localhost:3000, only you"],
      ["Build", "bundle and optimize the code"],
      ["Server or cloud", "Vercel, Render, AWS, Google Cloud Run"],
      ["Live", "https://your-app.com, for everyone"]
    ].forEach(([title, text]) => {
      const step = el("div", "pipe");
      step.appendChild(el("b", null, title));
      step.appendChild(el("span", null, text));
      pipeline.appendChild(step);
    });
    panel.appendChild(pipeline);

    panel.appendChild(el("p", "note", "Before going live with an AI app, tick what you have done:"));
    const meter = el("div", "meter");
    const top = el("div", "meter-top");
    const label = el("span");
    const status = el("span");
    top.appendChild(label);
    top.appendChild(status);
    const track = el("div", "meter-track");
    const fill = el("div", "meter-fill");
    track.appendChild(fill);
    meter.appendChild(top);
    meter.appendChild(track);
    panel.appendChild(meter);

    const list = el("div", "checklist");
    const boxes = DEPLOY_CHECKS.map((text, i) => {
      const row = el("label");
      const input = el("input");
      input.type = "checkbox";
      input.id = "deploy-check-" + i;
      input.checked = i === 0;
      row.htmlFor = input.id;
      row.appendChild(input);
      row.appendChild(el("span", null, text));
      input.addEventListener("change", update);
      list.appendChild(row);
      return { input, row };
    });
    panel.appendChild(list);

    function update() {
      const done = boxes.filter((b) => b.input.checked).length;
      boxes.forEach((b) => b.row.classList.toggle("done", b.input.checked));
      label.textContent = done + " of " + DEPLOY_CHECKS.length + " done";
      fill.style.width = (done / DEPLOY_CHECKS.length) * 100 + "%";
      fill.classList.toggle("full", done < DEPLOY_CHECKS.length);
      clear(status).appendChild(el("span", "pill " + (done === DEPLOY_CHECKS.length ? "good" : "warn"), done === DEPLOY_CHECKS.length ? "ready to go live" : "not ready yet"));
    }

    update();
  }

  const ROLES = {
    fde: {
      label: "FDE",
      full: "Forward Deployed Engineer",
      where: "With the customer: at the hospital, in their meetings, in their systems.",
      does: "Learns how doctors really write notes, connects the AI to the hospital's note system, tests summaries with real doctors, handles privacy rules, and builds the missing pieces. Sends what customers need back to the product team.",
      skill: "Coding plus talking to customers. Turns a general AI product into something that works for this customer."
    },
    ml: {
      label: "ML engineer",
      full: "Machine Learning Engineer",
      where: "At the AI company, far from the customer.",
      does: "Trains and tests the model so its medical summaries become more accurate, for all customers.",
      skill: "Math, data, training and evaluating models."
    },
    swe: {
      label: "Software engineer",
      full: "Software Engineer",
      where: "At the AI company, building the product.",
      does: "Builds the summary feature, the website and the API that every hospital customer will use.",
      skill: "Building reliable software for many users."
    },
    sales: {
      label: "Solutions engineer",
      full: "Sales / Solutions Engineer",
      where: "With the customer, before they buy.",
      does: "Shows demos, answers technical questions and helps the hospital decide to buy.",
      skill: "Explaining technology and matching it to business needs."
    }
  };

  function buildFde(panel) {
    panel.appendChild(el("h4", "sub-title", "FDE = Forward Deployed Engineer"));
    panel.appendChild(el("p", null, "\"Forward deployed\" means sent to the front line: the customer. An FDE is an engineer who works directly inside a customer's team to make an AI product solve their real problem. Palantir made the job title famous, and many AI companies now hire FDEs."));
    panel.appendChild(el("div", "box soft")).appendChild(rich("p", [["Example project: ", null, "b"], "A hospital wants AI to summarize doctors' notes. Who does what?"]));

    const segBox = el("div");
    const card = el("div", "box role-card");
    panel.appendChild(segBox);
    panel.appendChild(card);

    function render(key) {
      const role = ROLES[key];
      clear(card);
      card.appendChild(el("h4", null, role.full));
      const dl = el("dl");
      [["Works where", role.where], ["In this project", role.does], ["Main skill", role.skill]].forEach(([k, v]) => {
        dl.appendChild(el("dt", null, k));
        dl.appendChild(el("dd", null, v));
      });
      card.appendChild(dl);
    }

    seg(segBox, Object.keys(ROLES).map((k) => ({ value: k, label: ROLES[k].label })), "fde", render);
    render("fde");
  }

  tabs($("#product-tabs"), $("#product-panel"), [
    { label: "Framework", build: buildFramework },
    { label: "Deploy", build: buildDeploy },
    { label: "FDE", build: buildFde }
  ], 0);
})();
