/* Part 1: Kinds of AI */
(function () {
  const { $, $$, el, svg, clear, rich, onActivate, seg, picks } = G;

  /* ====================================================== AI family */
  const LAYERS = {
    ai: {
      title: "Artificial Intelligence (AI)",
      text: "Any computer program that does something that looks smart. It can be very simple rules, or a huge learned model.",
      ex: ["Chess computer", "Spam filter", "Voice assistant"]
    },
    rules: {
      title: "Rule-based AI",
      text: "AI made of if-then rules written by people. It never learns. Works for small fixed tasks, but breaks as soon as something unexpected happens.",
      ex: ["Old FAQ chatbots", "Early expert systems", "Phone menu bots"]
    },
    ml: {
      title: "Machine Learning (ML)",
      text: "AI that learns from examples instead of rules. Show it 10,000 spam emails and it finds by itself what spam looks like.",
      ex: ["Netflix suggestions", "Fraud detection", "Price prediction"]
    },
    dl: {
      title: "Deep Learning",
      text: "Machine learning with a very big \"neural network\": many layers of simple math that pass numbers to each other. Great for pictures, sound and language.",
      ex: ["Face unlock", "Voice typing", "Self-driving cars"]
    },
    gen: {
      title: "Generative AI",
      text: "Deep learning that creates something new: text, images, music, video or code, instead of only sorting or predicting.",
      ex: ["Image makers", "Music makers", "Chat AI"]
    },
    llm: {
      title: "Large Language Model (LLM)",
      text: "Generative AI for text. \"Large\" because it has billions of internal numbers (parameters) and learned from a huge amount of text. Its core skill: guess the next token very well.",
      ex: ["Gemini", "Claude", "ChatGPT", "Llama"]
    }
  };

  function setLayer(key) {
    $$(".layer").forEach((g) => g.classList.toggle("active", g.dataset.k === key));
    const data = LAYERS[key];
    const box = clear($("#family-detail"));
    box.appendChild(el("h4", null, data.title));
    box.appendChild(el("p", null, data.text));
    const chips = el("div", "chips");
    data.ex.forEach((x) => chips.appendChild(el("span", "chip", x)));
    box.appendChild(chips);
  }

  $$(".layer").forEach((g) => onActivate(g, () => setLayer(g.dataset.k)));
  setLayer("llm");

  /* ====================================================== Rule-based bot */
  const RULES = [
    { name: "Greeting", words: ["hi", "hello"], reply: "Hello! Welcome to our shop." },
    { name: "Opening hours", words: ["open", "hours"], reply: "Our hours: Monday to Saturday, 9 am to 6 pm." },
    { name: "Prices", words: ["price", "cost", "cheap"], reply: "Basic plan: $5 per month. Pro plan: $15 per month." },
    { name: "Goodbye", words: ["bye"], reply: "Goodbye! Have a nice day." }
  ];
  const FALLBACK = "Sorry, I do not understand. Please use other words.";

  const RB_EXAMPLES = [
    {
      text: "hello",
      llm: "Hi there! How can I help you today?",
      lesson: "Easy case. \"hello\" is in the rules, so both bots do fine."
    },
    {
      text: "When do you open?",
      llm: "We open at 9 am, Monday to Saturday.",
      lesson: "Works, because the message contains the keyword \"open\"."
    },
    {
      text: "What time can I come in?",
      llm: "You can visit any time from 9 am to 6 pm, Monday to Saturday.",
      lesson: "The same question in different words. No keyword matches, so the rule bot is lost."
    },
    {
      text: "Which one is cheaper?",
      llm: "The Basic plan is cheaper: $5 per month, compared to $15 for Pro.",
      lesson: "The greeting rule looks for \"hi\". The word \"W-hi-ch\" contains \"hi\", so the bot says hello. Rules check letters, not meaning."
    },
    {
      text: "I am NOT happy with your price",
      llm: "I am sorry to hear that. Would you like to see our discounts, or talk to a person from support?",
      lesson: "The bot sees \"price\" and lists prices. It cannot tell that the customer is upset."
    },
    {
      text: "r u open on sunday??",
      llm: "Sorry, we are closed on Sundays. We open again on Monday at 9 am.",
      lesson: "\"open\" matches, but the bot ignores \"sunday\" and gives a general answer. It never really answers the question."
    }
  ];

  function matchRule(text) {
    const lower = text.toLowerCase();
    for (let i = 0; i < RULES.length; i++) {
      for (const word of RULES[i].words) {
        if (lower.includes(word)) return { index: i, word };
      }
    }
    return null;
  }

  function renderRuleTable(hitIndex) {
    const body = clear($("#rb-rules"));
    RULES.forEach((rule, i) => {
      const tr = el("tr", i === hitIndex ? "hit" : null);
      tr.appendChild(el("td", null, (i + 1) + ". " + rule.name));
      tr.appendChild(el("td", null, rule.words.map((w) => "\"" + w + "\"").join(" or ")));
      tr.appendChild(el("td", null, rule.reply));
      body.appendChild(tr);
    });
  }

  function askBots(text, example) {
    const hit = matchRule(text);
    const ruleBox = $("#rb-rule-answer");
    ruleBox.textContent = hit ? RULES[hit.index].reply : FALLBACK;
    renderRuleTable(hit ? hit.index : -1);

    const lesson = clear($("#rb-lesson"));
    if (example) {
      lesson.textContent = example.lesson;
    } else if (hit) {
      lesson.textContent = "Matched rule " + (hit.index + 1) + " only because the text contains \"" + hit.word + "\".";
    } else {
      lesson.textContent = "No keyword found, so the bot gives its fallback reply.";
    }

    if (example) {
      $("#rb-llm-answer").textContent = example.llm;
      $("#rb-llm-note").textContent = "Example answer. An LLM reads the meaning of the whole message.";
    } else {
      $("#rb-llm-answer").textContent = "(No real AI is connected to this page.)";
      $("#rb-llm-note").textContent = "A real LLM would understand what you mean, even with typos or different words, because it reads meaning instead of matching letters.";
    }
  }

  const rbPicks = picks($("#rb-examples"), RB_EXAMPLES.map((e) => e.text), 3, (i) => {
    $("#rb-input").value = RB_EXAMPLES[i].text;
    askBots(RB_EXAMPLES[i].text, RB_EXAMPLES[i]);
  });

  function askTyped() {
    const text = $("#rb-input").value.trim();
    if (!text) return;
    const index = RB_EXAMPLES.findIndex((e) => e.text.toLowerCase() === text.toLowerCase());
    if (index >= 0) {
      rbPicks.set(index);
    } else {
      rbPicks.clearActive();
      askBots(text, null);
    }
  }

  $("#rb-send").addEventListener("click", askTyped);
  $("#rb-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") askTyped();
  });

  $("#rb-input").value = RB_EXAMPLES[3].text;
  askBots(RB_EXAMPLES[3].text, RB_EXAMPLES[3]);

  /* ====================================================== ML algorithms */
  // [links in email, CAPITAL words]
  const HAM = [[0, 0], [2, 0], [1, 1], [0, 2], [3, 1], [2, 2], [1, 3], [3, 2], [0, 4], [1, 5]];
  const SPAM = [[6, 2], [8, 1], [5, 4], [7, 5], [6, 6], [2, 8], [4, 8], [5, 7], [9, 8], [8, 9]];
  const TRAIN = HAM.map((p) => ({ x: p[0], y: p[1], spam: false })).concat(
    SPAM.map((p) => ({ x: p[0], y: p[1], spam: true }))
  );
  const START_POINT = { x: 4, y: 1 };

  const X = (v) => 50 + v * 35;
  const Y = (v) => 300 - v * 28;

  let mlPoint = { ...START_POINT };
  let mlAlgo = "knn";

  function knn(p) {
    const nearest = TRAIN.map((t) => ({ t, d: Math.hypot(t.x - p.x, t.y - p.y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    const spamVotes = nearest.filter((n) => n.t.spam).length;
    return {
      spam: spamVotes >= 2,
      nearest,
      why: spamVotes + " of the 3 nearest emails are spam"
    };
  }

  function tree(p) {
    if (p.x > 3) return { spam: true, why: "links " + p.x.toFixed(1) + " > 3, so spam" };
    if (p.y > 5) return { spam: true, why: "links <= 3, but capitals " + p.y.toFixed(1) + " > 5, so spam" };
    return { spam: false, why: "links <= 3 and capitals <= 5, so not spam" };
  }

  function linear(p) {
    const score = p.x + 0.6 * p.y;
    return {
      spam: score > 5,
      why: "score " + score.toFixed(1) + (score > 5 ? " > 5" : " <= 5")
    };
  }

  const ALGOS = {
    knn: {
      label: "k-Nearest Neighbors",
      fn: knn,
      explain: "Finds the 3 known emails closest to the new one. The new email gets the answer that most of those 3 have. No training needed, it just remembers all examples."
    },
    tree: {
      label: "Decision tree",
      fn: tree,
      explain: "Learned a flowchart of yes/no questions from the examples. Question 1: more than 3 links? Then spam. If not, question 2: more than 5 capital words? Then spam. Otherwise not spam."
    },
    linear: {
      label: "Linear model",
      fn: linear,
      explain: "Learned one straight line. Score = links + 0.6 x capital words. A score above 5 means spam. Everything on the shaded side of the line is spam."
    }
  };

  const mlSvg = $("#ml-svg");

  function drawMl() {
    clear(mlSvg);

    // Algorithm-specific background first
    if (mlAlgo === "tree") {
      mlSvg.appendChild(svg("rect", { x: X(3), y: Y(10), width: X(10) - X(3), height: Y(0) - Y(10), class: "region" }));
      mlSvg.appendChild(svg("rect", { x: X(0), y: Y(10), width: X(3) - X(0), height: Y(5) - Y(10), class: "region" }));
    } else if (mlAlgo === "linear") {
      const points = [[0, 5 / 0.6], [0, 10], [10, 10], [10, 0], [5, 0]]
        .map((p) => X(p[0]) + "," + Y(p[1])).join(" ");
      mlSvg.appendChild(svg("polygon", { points, class: "region" }));
    }

    for (let v = 0; v <= 10; v += 2) {
      mlSvg.appendChild(svg("line", { x1: X(v), y1: Y(0), x2: X(v), y2: Y(10), class: "gridline" }));
      mlSvg.appendChild(svg("line", { x1: X(0), y1: Y(v), x2: X(10), y2: Y(v), class: "gridline" }));
      const tx = svg("text", { x: X(v), y: Y(0) + 16, "text-anchor": "middle", class: "axis-label" });
      tx.textContent = v;
      mlSvg.appendChild(tx);
      const ty = svg("text", { x: X(0) - 8, y: Y(v) + 4, "text-anchor": "end", class: "axis-label" });
      ty.textContent = v;
      mlSvg.appendChild(ty);
    }

    mlSvg.appendChild(svg("line", { x1: X(0), y1: Y(0), x2: X(10), y2: Y(0), class: "axis" }));
    mlSvg.appendChild(svg("line", { x1: X(0), y1: Y(0), x2: X(0), y2: Y(10), class: "axis" }));

    const xLabel = svg("text", { x: X(5), y: 334, "text-anchor": "middle", class: "axis-label" });
    xLabel.textContent = "links in the email";
    mlSvg.appendChild(xLabel);
    const yLabel = svg("text", { x: 14, y: Y(5), "text-anchor": "middle", class: "axis-label", transform: "rotate(-90 14 " + Y(5) + ")" });
    yLabel.textContent = "CAPITAL words";
    mlSvg.appendChild(yLabel);

    if (mlAlgo === "tree") {
      mlSvg.appendChild(svg("line", { x1: X(3), y1: Y(0), x2: X(3), y2: Y(10), class: "boundary" }));
      mlSvg.appendChild(svg("line", { x1: X(0), y1: Y(5), x2: X(3), y2: Y(5), class: "boundary" }));
    } else if (mlAlgo === "linear") {
      mlSvg.appendChild(svg("line", { x1: X(0), y1: Y(5 / 0.6), x2: X(5), y2: Y(0), class: "boundary" }));
    } else {
      knn(mlPoint).nearest.forEach((n) => {
        mlSvg.appendChild(svg("line", { x1: X(mlPoint.x), y1: Y(mlPoint.y), x2: X(n.t.x), y2: Y(n.t.y), class: "nn-line" }));
      });
    }

    TRAIN.forEach((t) => {
      mlSvg.appendChild(svg("circle", { cx: X(t.x), cy: Y(t.y), r: 6, class: t.spam ? "spam" : "ham" }));
    });

    mlSvg.appendChild(svg("circle", { cx: X(mlPoint.x), cy: Y(mlPoint.y), r: 8, class: "newpt" }));
    const label = svg("text", {
      x: X(mlPoint.x) + (mlPoint.x > 7.5 ? -12 : 12),
      y: Y(mlPoint.y) - 10,
      "text-anchor": mlPoint.x > 7.5 ? "end" : "start",
      class: "newpt-label"
    });
    label.textContent = "new email";
    mlSvg.appendChild(label);
  }

  function renderMlResults() {
    const body = clear($("#ml-results"));
    const results = Object.keys(ALGOS).map((key) => ({ key, r: ALGOS[key].fn(mlPoint) }));

    results.forEach(({ key, r }) => {
      const tr = el("tr", key === mlAlgo ? "sel" : null);
      tr.appendChild(el("td", null, ALGOS[key].label));
      const td = el("td");
      td.appendChild(el("span", "pill " + (r.spam ? "bad" : "good"), r.spam ? "spam" : "not spam"));
      tr.appendChild(td);
      tr.appendChild(el("td", null, r.why));
      body.appendChild(tr);
    });

    const spamCount = results.filter((x) => x.r.spam).length;
    $("#ml-agree").textContent =
      spamCount === 0 || spamCount === 3
        ? "All three algorithms agree here. Far from the border, the pattern is clear."
        : "The algorithms disagree here. Near the border between groups, different methods give different answers. That is normal in ML, and why people test several algorithms.";

    const explain = clear($("#ml-explain"));
    explain.appendChild(el("h4", null, ALGOS[mlAlgo].label));
    explain.appendChild(el("p", null, ALGOS[mlAlgo].explain));
    explain.appendChild(el("p", "note", "New email: " + mlPoint.x.toFixed(1) + " links, " + mlPoint.y.toFixed(1) + " capital words."));
  }

  function updateMl() {
    drawMl();
    renderMlResults();
  }

  mlSvg.addEventListener("click", (event) => {
    const pt = mlSvg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const local = pt.matrixTransform(mlSvg.getScreenCTM().inverse());
    const clamp = (v) => Math.round(Math.max(0, Math.min(10, v)) * 10) / 10;
    mlPoint = { x: clamp((local.x - 50) / 35), y: clamp((300 - local.y) / 28) };
    updateMl();
  });

  seg($("#ml-algo"), Object.keys(ALGOS).map((k) => ({ value: k, label: ALGOS[k].label })), mlAlgo, (value) => {
    mlAlgo = value;
    updateMl();
  });

  $("#ml-reset").addEventListener("click", () => {
    mlPoint = { ...START_POINT };
    updateMl();
  });

  updateMl();

  const ALGO_CARDS = [
    ["Linear regression", "Supervised", "info", "Draws the best straight line through the data to predict a number.", "House price from its size"],
    ["Logistic regression", "Supervised", "info", "Predicts yes or no, with a probability.", "Will this customer leave?"],
    ["Decision tree", "Supervised", "info", "A flowchart of yes/no questions learned from the data.", "Approve a loan or not"],
    ["Random forest", "Supervised", "info", "Many decision trees vote together. Usually more accurate than one tree.", "Credit card fraud detection"],
    ["k-Nearest Neighbors", "Supervised", "info", "Copies the answer of the most similar known examples.", "\"People like you also bought\""],
    ["k-Means clustering", "Unsupervised", "warn", "Splits data into k groups of similar items, without any answers given.", "Grouping customers by behavior"],
    ["Neural network", "Supervised (mostly)", "info", "Many layers of simple math that can learn very complex patterns.", "Photos, speech, LLMs"],
    ["Q-learning", "Reinforcement", "good", "Learns the best action in each situation from rewards and penalties.", "Game-playing AI, robots"]
  ];

  const algoGrid = $("#ml-algos");
  ALGO_CARDS.forEach(([name, type, tone, text, example]) => {
    const card = el("div", "box");
    card.appendChild(el("span", "pill " + tone, type));
    card.appendChild(el("h4", null, name));
    card.appendChild(el("p", null, text));
    card.appendChild(el("p", "ex", "Example: " + example));
    algoGrid.appendChild(card);
  });

  /* ====================================================== Narrow vs general */
  const TASKS = [
    "Detect spam emails",
    "Play chess",
    "Unlock a phone with your face",
    "Translate a sentence",
    "Summarize a long PDF",
    "Write computer code",
    "Answer history questions",
    "Write a poem"
  ];

  const GP_MODELS = {
    spam: { label: "Spam filter", kind: "Narrow AI", can: { 0: "yes" } },
    chess: { label: "Chess engine", kind: "Narrow AI", can: { 1: "yes" } },
    face: { label: "Face unlock", kind: "Narrow AI", can: { 2: "yes" } },
    llm: {
      label: "General-purpose LLM",
      kind: "General-purpose AI",
      can: { 0: "yes", 1: "partly", 2: "no", 3: "yes", 4: "yes", 5: "yes", 6: "yes", 7: "yes" },
      notes: {
        1: "It can play, but a chess engine is far stronger.",
        2: "It can describe a face in a photo, but it is not built for secure unlocking."
      }
    }
  };

  const STATUS = {
    yes: ["good", "Can do"],
    partly: ["warn", "Partly"],
    no: ["bad", "Cannot"]
  };

  function renderGeneral(key) {
    const model = GP_MODELS[key];
    $("#gp-kind").textContent = model.kind;
    const list = clear($("#gp-tasks"));
    let count = 0;

    TASKS.forEach((task, i) => {
      const status = model.can[i] || "no";
      if (status === "yes") count++;
      const row = el("div", "task-row");
      const label = el("span", null, task);
      if (model.notes && model.notes[i]) label.appendChild(el("small", null, model.notes[i]));
      row.appendChild(label);
      row.appendChild(el("span", "pill " + STATUS[status][0], STATUS[status][1]));
      list.appendChild(row);
    });

    $("#gp-count").textContent = "Can fully do " + count + " of " + TASKS.length + " tasks";
  }

  seg($("#gp-models"), Object.keys(GP_MODELS).map((k) => ({ value: k, label: GP_MODELS[k].label })), "spam", renderGeneral);
  renderGeneral("spam");

  /* ====================================================== Generative AI */
  const OPENINGS = ["Thank you for your honest review!", "Thanks so much for visiting us.", "We really appreciate your feedback."];
  const MIDDLES = ["We are sorry your food arrived cold.", "Cold food is not the experience we want for you.", "We have told our kitchen team about the cold food."];
  const CLOSINGS = ["We are glad our staff made you feel welcome.", "Our team will be happy to hear your kind words.", "Next time, your dessert is on us."];

  const genOutputs = [];
  let lastGenerated = "";

  const randomItem = (list) => list[Math.floor(Math.random() * list.length)];

  function addGenOutput(kind) {
    let text;
    let note;

    if (kind === "classify") {
      text = "Label: MIXED review. Food: negative. Staff: positive.";
      const same = genOutputs.some((o) => o.kind === "classify");
      note = same ? "Same result as before" : "Always gives this result";
    } else {
      do {
        text = randomItem(OPENINGS) + " " + randomItem(MIDDLES) + " " + randomItem(CLOSINGS);
      } while (text === lastGenerated);
      lastGenerated = text;
      note = "New text each time";
    }

    genOutputs.unshift({ kind, text, note });
    if (genOutputs.length > 4) genOutputs.pop();
    renderGen();
  }

  function renderGen() {
    const list = clear($("#gen-out"));
    genOutputs.forEach((o, i) => {
      const li = el("li", i === 0 ? "appear" : null);
      const meta = el("div", "meta");
      meta.appendChild(el("span", "pill " + (o.kind === "classify" ? "plain" : "info"), o.kind === "classify" ? "Classic AI" : "Generative AI"));
      meta.appendChild(el("span", "note", o.note));
      li.appendChild(meta);
      li.appendChild(el("span", null, o.text));
      list.appendChild(li);
    });
  }

  $("#gen-classify").addEventListener("click", () => addGenOutput("classify"));
  $("#gen-generate").addEventListener("click", () => addGenOutput("generate"));
  addGenOutput("classify");
  addGenOutput("generate");

  /* ====================================================== Raw LLM vs chat */
  const RAW_PROMPTS = [
    {
      prompt: "What is the capital of France?",
      base: "\nWhat is the capital of Germany?\nWhat is the capital of Italy?\nWhat is the capital of Spain?\n\nAnswers are on page 12.",
      chat: "The capital of France is Paris."
    },
    {
      prompt: "Write a short poem about rain.",
      base: " Use at least three rhyming words. The poem must be 8 lines long. Due on Friday.\n\nGrade 5 English worksheet, page 3",
      chat: "Soft rain taps the window,\nslow and silver-grey,\nwashing all the dusty streets\nand my tired thoughts away."
    },
    {
      prompt: "My laptop is very slow. What should I do?",
      base: " I have restarted it many times. It is a 2015 model with 4GB RAM.\n\nReply #1 by techguy88: Same problem here, following this thread.",
      chat: "Try these quick fixes:\n1. Restart and close apps you do not use.\n2. Open Task Manager and stop programs using a lot of memory.\n3. Free up disk space.\n4. With only 4GB RAM, adding more RAM helps a lot."
    }
  ];

  let rawIndex = 0;

  function renderRaw() {
    const item = RAW_PROMPTS[rawIndex];
    const base = clear($("#raw-base"));
    base.appendChild(el("span", "given", item.prompt));
    base.appendChild(el("span", "added", item.base));

    const chat = clear($("#raw-chat"));
    if ($("#raw-template").checked) {
      chat.appendChild(el("span", "given", "<start_of_turn>user\n" + item.prompt + "<end_of_turn>\n<start_of_turn>model\n"));
      chat.appendChild(el("span", "added", item.chat));
      chat.appendChild(el("span", "given", "<end_of_turn>"));
      chat.appendChild(el("span", "note", "\n\nSpecial tokens mark who is talking (this is the Gemma format; every model family has its own). The chat model is still continuing text, but it learned that after \"model\" comes a helpful answer."));
    } else {
      chat.appendChild(el("span", "added", item.chat));
    }
  }

  picks($("#raw-prompts"), RAW_PROMPTS.map((p) => p.prompt), 0, (i) => {
    rawIndex = i;
    renderRaw();
  });
  $("#raw-template").addEventListener("change", renderRaw);
  renderRaw();

  /* ====================================================== Agents */
  const TYPE_LABEL = {
    you: "You",
    think: "Thinks",
    tool: "Uses tool",
    observe: "Sees result",
    answer: "Answer",
    human: "Asks you",
    review: "Checks"
  };

  const AGENT_MODES = {
    chatbot: {
      label: "Chatbot",
      autonomy: 1,
      autonomyText: "Low: you do the work",
      trace: [
        { type: "you", text: "Book a table for 2 near my office tomorrow at 7 pm, and add it to my calendar." },
        { type: "answer", text: "Here is how you can do it: 1. Search restaurants near your office on a map app. 2. Call or use a booking website for 7 pm. 3. Add the booking to your calendar." },
        { type: "human", text: "You still search, call, book and update the calendar yourself." }
      ]
    },
    agent: {
      label: "AI agent",
      autonomy: 2,
      autonomyText: "Medium: finishes one task alone",
      trace: [
        { type: "think", text: "I need restaurants near the office. I will use the search tool." },
        { type: "tool", code: "search_restaurants(near: \"office\", people: 2, time: \"tomorrow 19:00\")" },
        { type: "observe", text: "3 results: Olive Tree (4.6 stars), Tokyo Bowl (4.4), Green Leaf (4.2)" },
        { type: "think", text: "Olive Tree has the best rating. Check if a table is free." },
        { type: "tool", code: "check_availability(restaurant: \"Olive Tree\", time: \"19:00\", people: 2)" },
        { type: "observe", text: "Free tables at 19:00 and 19:30" },
        { type: "tool", code: "book_table(restaurant: \"Olive Tree\", time: \"19:00\", people: 2)" },
        { type: "observe", text: "Booked. Confirmation #A4821" },
        { type: "tool", code: "add_calendar_event(title: \"Dinner at Olive Tree\", time: \"tomorrow 19:00\")" },
        { type: "observe", text: "Event added to calendar" },
        { type: "answer", text: "Done! Table for 2 at Olive Tree, tomorrow at 7 pm (booking #A4821). It is in your calendar." }
      ]
    },
    agentic: {
      label: "Agentic AI (team of agents)",
      autonomy: 3,
      autonomyText: "High: plans many steps, asks you only for key choices",
      trace: [
        { type: "think", who: "Planner agent", text: "Split the goal into 3 jobs: find a restaurant, check the calendar, book and confirm. Your saved rule: max $40 per person." },
        { type: "tool", who: "Research agent", code: "search_restaurants(...)  read_reviews(...)  compare_prices(...)", text: "Shortlist: Olive Tree ($35 per person) and Green Leaf ($25 per person)." },
        { type: "tool", who: "Calendar agent", code: "check_calendar(date: \"tomorrow\")", text: "You have a meeting until 18:30. 19:00 works with 15 minutes of travel." },
        { type: "human", text: "Olive Tree ($35) or Green Leaf ($25)? You pick Olive Tree." },
        { type: "tool", who: "Booking agent", code: "book_table(restaurant: \"Olive Tree\", time: \"19:00\", people: 2)", text: "Booked. Confirmation #A4821" },
        { type: "tool", who: "Calendar agent", code: "add_calendar_event(...)  add_reminder(time: \"18:40\", text: \"Leave for dinner\")", text: "Event and travel reminder added." },
        { type: "review", who: "Reviewer agent", text: "Time matches the calendar, 2 people, price under budget. All good." },
        { type: "answer", text: "All done: Olive Tree, tomorrow 7 pm, booking #A4821. A reminder to leave will pop up at 6:40 pm." }
      ]
    }
  };

  let agentMode = "agent";
  let replayTimer = null;

  function traceItem(step) {
    const li = el("li");
    const badgeText = step.who || TYPE_LABEL[step.type];
    const badgeClass = step.who && step.type !== "review" ? "agent" : step.type;
    li.appendChild(el("span", "badge " + badgeClass, badgeText));
    const body = el("div", "body");
    if (step.who && step.type !== "review") body.appendChild(el("span", "note", TYPE_LABEL[step.type]));
    if (step.code) body.appendChild(el("pre", "code", step.code));
    if (step.text) body.appendChild(el("span", null, step.text));
    li.appendChild(body);
    return li;
  }

  function renderAgentStats(mode) {
    const data = AGENT_MODES[mode];
    const stats = clear($("#agent-stats"));
    const add = (value, label) => {
      const s = el("div", "mini-stat");
      s.appendChild(typeof value === "string" || typeof value === "number" ? el("b", null, String(value)) : value);
      s.appendChild(el("span", null, label));
      stats.appendChild(s);
    };

    const dots = el("b", "dots");
    for (let i = 1; i <= 3; i++) dots.appendChild(el("i", i <= data.autonomy ? "on" : ""));
    add(dots, "Autonomy: " + data.autonomyText);
    add(data.trace.length, "steps");
    add(data.trace.filter((s) => s.type === "tool").length, "tool steps");
    add(data.trace.filter((s) => s.type === "human").length, "times it needs you");
  }

  function renderAgent(mode, animate) {
    if (replayTimer) clearInterval(replayTimer);
    replayTimer = null;
    agentMode = mode;
    renderAgentStats(mode);

    const list = clear($("#agent-trace"));
    const steps = AGENT_MODES[mode].trace;

    if (!animate || G.reducedMotion()) {
      steps.forEach((s) => list.appendChild(traceItem(s)));
      return;
    }

    let i = 0;
    const addNext = () => {
      const li = traceItem(steps[i]);
      li.classList.add("appear");
      list.appendChild(li);
      i++;
      if (i >= steps.length) {
        clearInterval(replayTimer);
        replayTimer = null;
      }
    };
    addNext();
    replayTimer = setInterval(addNext, 900);
  }

  seg($("#agent-modes"), Object.keys(AGENT_MODES).map((k) => ({ value: k, label: AGENT_MODES[k].label })), agentMode, (m) => renderAgent(m, false));
  $("#agent-replay").addEventListener("click", () => renderAgent(agentMode, true));
  renderAgent(agentMode, false);
})();
