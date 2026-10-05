/* Part 5: Build AI you can trust - hallucination, prompting lab, RAG */
(function () {
  const { $, el, clear, rich, seg, picks, barRow, pct } = G;

  /* ====================================================== Why AI hallucinates */
  const HQ = [
    {
      q: "Who wrote the novel Pride and Prejudice?",
      prefix: "Pride and Prejudice was written by",
      steps: [
        [" Jane", [["Jane", 0.93], ["Charlotte", 0.03], ["Emily", 0.02]]],
        [" Austen", [["Austen", 0.98], ["Smith", 0.01], ["Eyre", 0.01]]],
        [" in", [["in", 0.61], ["and", 0.2], [".", 0.19]]],
        [" 1813.", [["1813", 0.72], ["1811", 0.14], ["1815", 0.08]]]
      ],
      plain: ["good", "Correct", "This fact appears thousands of times in the training text, so the most likely words are also the true ones."],
      search: {
        query: "Pride and Prejudice author",
        results: [["Pride and Prejudice - novel", "A novel by Jane Austen, first published in 1813.", "encyclopedia page"]],
        answer: "Pride and Prejudice was written by Jane Austen and first published in 1813 [1].",
        verdict: ["good", "Correct and cited", "Same answer, but now you can click the source and check it."]
      },
      rag: {
        found: null,
        answer: "I can't find this in the company documents I was given.",
        verdict: ["good", "Honest", "RAG only searches your own documents. A novel is not in them, so the model correctly says so."]
      }
    },
    {
      q: "Who won the 2031 Nobel Prize in Physics?",
      prefix: "The 2031 Nobel Prize in Physics was awarded to",
      steps: [
        [" Dr.", [["Dr.", 0.22], ["Professor", 0.19], ["the", 0.14]]],
        [" Elena", [["Elena", 0.08], ["Maria", 0.07], ["James", 0.07]]],
        [" Varga", [["Varga", 0.04], ["Rossi", 0.04], ["Chen", 0.04]]],
        [" for", [["for", 0.71], [",", 0.2], ["and", 0.09]]],
        [" quantum", [["quantum", 0.33], ["dark", 0.12], ["new", 0.09]]],
        [" error correction.", [["error correction", 0.18], ["gravity", 0.12], ["computing", 0.11]]]
      ],
      plain: ["bad", "Made up", "2031 has not happened yet. Every word had a low chance, but the model still picked one each time and wrote a fluent, confident sentence. The person is invented."],
      search: {
        query: "2031 Nobel Prize in Physics winner",
        results: [],
        answer: "The 2031 Nobel Prize in Physics has not been announced, so I can't tell you who won.",
        verdict: ["good", "Honest", "Search found nothing, and the app told the model to answer only from the results."]
      },
      rag: {
        found: null,
        answer: "I can't find this in the company documents I was given.",
        verdict: ["good", "Honest", "Nothing matched, so the model says it does not know instead of guessing."]
      }
    },
    {
      q: "What is the phone number of Lotus Bay Dental Clinic in Pune?",
      prefix: "The phone number of Lotus Bay Dental Clinic in Pune is",
      steps: [
        [" +91", [["+91", 0.58], ["020", 0.24], ["not", 0.06]]],
        [" 20", [["20", 0.44], ["98", 0.15], ["22", 0.07]]],
        [" 5550", [["5550", 0.02], ["2567", 0.02], ["6601", 0.02]]],
        [" 1234.", [["1234", 0.02], ["4410", 0.02], ["7788", 0.02]]]
      ],
      plain: ["bad", "Made up", "The format is right (+91 20 is the code for Pune), so it looks real. But the last 8 digits each had about a 2% chance: they are random. A rare fact like this was barely in the training data."],
      search: {
        query: "Lotus Bay Dental Clinic Pune phone",
        results: [["Lotus Bay Dental Clinic - Contact", "Koregaon Park, Pune. Phone: +91 20 5550 7788. Open Mon-Sat.", "clinic website (example)"]],
        answer: "You can call Lotus Bay Dental Clinic at +91 20 5550 7788 [1].",
        verdict: ["good", "Correct and cited", "The number comes from the clinic's own page, not from the model's memory."]
      },
      rag: {
        found: ["partner-clinics.pdf", "Partner clinics (Pune): Lotus Bay Dental Clinic, Koregaon Park. Phone +91 20 5550 7788.", 0.81],
        answer: "Lotus Bay Dental Clinic's phone number is +91 20 5550 7788 [1].",
        verdict: ["good", "Correct and cited", "This company keeps a list of partner clinics, so RAG found the exact passage."]
      }
    },
    {
      q: "Summarize the 2019 paper \"Neural Gardens for Quantum Cats\".",
      prefix: "The 2019 paper \"Neural Gardens for Quantum Cats\" shows that",
      steps: [
        [" neural", [["neural", 0.21], ["quantum", 0.19], ["cats", 0.08]]],
        [" networks", [["networks", 0.54], ["gardens", 0.2], ["models", 0.1]]],
        [" can", [["can", 0.4], ["learn", 0.2], ["grow", 0.1]]],
        [" simulate", [["simulate", 0.15], ["predict", 0.14], ["model", 0.12]]],
        [" quantum states.", [["quantum states", 0.3], ["cat behavior", 0.1], ["plant growth", 0.08]]]
      ],
      plain: ["bad", "Made up", "This paper does not exist. The model built a summary out of the words in the title. It never checks whether the paper is real."],
      search: {
        query: "\"Neural Gardens for Quantum Cats\" 2019 paper",
        results: [],
        answer: "I could not find a paper called \"Neural Gardens for Quantum Cats\". It may not exist, or the title may be different.",
        verdict: ["good", "Honest", "No results, so no invented summary."]
      },
      rag: {
        found: null,
        answer: "I can't find this in the company documents I was given.",
        verdict: ["good", "Honest", "Not in the documents, so the model says so."]
      }
    }
  ];

  let hIndex = 1;
  let hMode = "plain";
  let hShown = 0;

  function confidenceClass(p) {
    if (p >= 0.6) return "conf-high";
    if (p >= 0.2) return "conf-mid";
    return "conf-low";
  }

  function verdictBox(verdict) {
    const box = el("div", "answer " + (verdict[0] === "good" ? "good" : "bad"));
    box.appendChild(el("span", "pill " + verdict[0], verdict[1]));
    box.appendChild(document.createTextNode(" " + verdict[2]));
    return box;
  }

  function renderHallucination() {
    const item = HQ[hIndex];
    const out = clear($("#hal-out"));
    $("#hal-controls").hidden = hMode !== "plain";

    if (hMode === "plain") {
      const line = el("p", "big-sentence gen-line");
      line.appendChild(el("span", "given", item.prefix));
      item.steps.slice(0, hShown).forEach(([token, candidates]) => {
        const span = el("span", "gen-tok " + confidenceClass(candidates[0][1]), token);
        span.title = "chance " + pct(candidates[0][1]);
        line.appendChild(span);
      });
      if (hShown < item.steps.length) line.appendChild(el("span", "blank", " ..."));
      out.appendChild(line);

      const current = item.steps[Math.min(hShown, item.steps.length) - 1];
      const box = el("div", "box");
      if (current) {
        box.appendChild(el("span", "box-label", "Top choices for word " + hShown + " (chances are illustrative)"));
        const bars = el("div", "bars");
        current[1].forEach(([word, p], i) => bars.appendChild(barRow(word, p, pct(p), i === 0 ? "top" : null)));
        box.appendChild(bars);
      } else {
        box.appendChild(el("p", "note", "Press \"Next word\" to watch the model pick each word."));
      }
      out.appendChild(box);

      const legend = el("div", "legend");
      legend.appendChild(rich("span", [["high chance", "gen-tok conf-high"]]));
      legend.appendChild(rich("span", [["medium", "gen-tok conf-mid"]]));
      legend.appendChild(rich("span", [["low chance, still written", "gen-tok conf-low"]]));
      out.appendChild(legend);

      if (hShown >= item.steps.length) {
        const avg = item.steps.reduce((s, st) => s + st[1][0][1], 0) / item.steps.length;
        const stats = el("div", "kpis");
        [[pct(avg), "average chance of the picked words"], ["Yes", "does it SOUND confident?"], ["No", "was anything checked?"]].forEach(([v, l]) => {
          const k = el("div", "kpi");
          k.appendChild(el("b", null, v));
          k.appendChild(el("span", null, l));
          stats.appendChild(k);
        });
        out.appendChild(stats);
        out.appendChild(verdictBox(item.plain));
      }
      $("#hal-next").disabled = hShown >= item.steps.length;
      $("#hal-all").disabled = hShown >= item.steps.length;
      return;
    }

    if (hMode === "search") {
      const s = item.search;
      out.appendChild(rich("p", [["1. App searches the web for: ", null, "b"], "\"" + s.query + "\""]));
      const list = el("ol", "sources");
      if (!s.results.length) list.appendChild(el("li", "note", "No relevant results found."));
      s.results.forEach(([title, snippet, source]) => {
        const li = el("li");
        li.appendChild(el("strong", null, title));
        li.appendChild(el("span", null, snippet));
        li.appendChild(el("span", "note", source));
        list.appendChild(li);
      });
      out.appendChild(el("p", null, "2. Results are pasted into the prompt with the rule: \"Answer only from these results. Cite them. If they don't answer the question, say so.\""));
      out.appendChild(list);
      out.appendChild(el("p", null, "3. The model answers:"));
      out.appendChild(el("p", "big-sentence", s.answer));
      out.appendChild(verdictBox(s.verdict));
      return;
    }

    const r = item.rag;
    out.appendChild(rich("p", [["1. App searches the company's own documents ", null, "b"], "(HR policies, product manuals, partner clinic list)."]));
    const box = el("div", "box");
    if (r.found) {
      box.appendChild(el("span", "box-label", "Best passage [1] from " + r.found[0] + ", match " + r.found[2].toFixed(2)));
      box.appendChild(el("p", null, r.found[1]));
    } else {
      box.appendChild(el("span", "box-label", "Best passage"));
      box.appendChild(el("p", "note", "Nothing relevant. Best match score 0.12, below the 0.30 minimum, so no passage is used."));
    }
    out.appendChild(box);
    out.appendChild(el("p", null, "2. The model answers only from that passage:"));
    out.appendChild(el("p", "big-sentence", r.answer));
    out.appendChild(verdictBox(r.verdict));
  }

  picks($("#hal-questions"), HQ.map((h) => h.q), hIndex, (i) => {
    hIndex = i;
    hShown = 0;
    renderHallucination();
  });

  seg($("#hal-modes"), [
    { value: "plain", label: "LLM alone" },
    { value: "search", label: "LLM + web search" },
    { value: "rag", label: "LLM + your documents (RAG)" }
  ], hMode, (v) => {
    hMode = v;
    hShown = HQ[hIndex].steps.length;
    renderHallucination();
  });

  $("#hal-next").addEventListener("click", () => {
    hShown = Math.min(HQ[hIndex].steps.length, hShown + 1);
    renderHallucination();
  });
  $("#hal-all").addEventListener("click", () => {
    hShown = HQ[hIndex].steps.length;
    renderHallucination();
  });
  $("#hal-reset").addEventListener("click", () => {
    hShown = 0;
    renderHallucination();
  });

  hShown = HQ[hIndex].steps.length;
  renderHallucination();

  /* ====================================================== Prompting lab */
  const BLOCKS = [
    { key: "role", label: "Role", cls: "p-role", why: "Voice and expertise: it writes like the person you asked for." },
    { key: "context", label: "Context", cls: "p-ctx", why: "Real facts instead of filler. Without context, the AI must guess or invent details." },
    { key: "constraints", label: "Constraints", cls: "p-con", why: "Length, tone and rules: removes fluff and claims you cannot prove." },
    { key: "examples", label: "Examples", cls: "p-ex", why: "Shows exactly what \"good\" looks like, so the style matches." },
    { key: "format", label: "Output format", cls: "p-fmt", why: "Structure you can use directly: headings, bullets, steps or JSON." }
  ];

  const LAB_TASKS = [
    {
      label: "Product description",
      task: "Write about our new water bottle.",
      text: {
        role: "You are a copywriter for an outdoor gear shop.",
        context: "Product: TrailMate bottle, 750 ml, double-wall steel, keeps drinks cold for 24 hours, price Rs 1,299. Buyers: hikers and daily commuters.",
        constraints: "Maximum 50 words. Friendly tone. No claims we cannot prove, like \"best\" or \"perfect\".",
        examples: "Match the style of this line from our shop: \"Pack light. Go far. The CloudStep jacket weighs less than an apple.\"",
        format: "Format: a headline, then 3 bullet points, then one call-to-action line."
      },
      build(f) {
        const ctx = f.context;
        const voice = f.examples ? "punchy" : f.role ? "warm" : "plain";
        const headline = {
          plain: ctx ? "The TrailMate Water Bottle" : "Our New Water Bottle",
          warm: ctx ? "Meet TrailMate, Your New Trail Buddy" : "Meet Your New Favorite Bottle",
          punchy: ctx ? "Cold for 24 hours. Tough as steel." : "Sip more. Carry less."
        }[voice];
        const points = (ctx
          ? {
              plain: ["It holds 750 ml of water.", "It keeps drinks cold for 24 hours.", "It is made of double-wall steel."],
              warm: ["Carry 750 ml, enough for a long hike or a full workday.", "Your water stays ice-cold for 24 hours.", "Tough double-wall steel, made for hikers and commuters."],
              punchy: ["750 ml. One fill, whole hike.", "Ice-cold for 24 hours.", "Double-wall steel. Drop it. Keep going."]
            }
          : {
              plain: ["It holds water.", "It keeps drinks fresh.", "It is made of good materials."],
              warm: ["It is big enough for your whole day.", "Your drinks stay fresh and tasty.", "It is made to last."],
              punchy: ["Big enough. Light enough.", "Fresh drinks. All day.", "Built to last."]
            })[voice].slice();
        const hype = f.constraints ? "" : voice === "punchy" ? "Simply the best bottle ever made." : "It is the best and most perfect bottle for everyone in the world.";
        const fluff = f.constraints || voice !== "plain"
          ? []
          : ["Water is very important for our health, and everyone should drink enough water every single day.", "There are many kinds of bottles on the market today, made from plastic, glass and metal, in many colors and sizes."];
        const cta = ctx
          ? (voice === "plain" ? "It costs Rs 1,299." : "Grab yours today for Rs 1,299.")
          : (voice === "plain" ? "You can buy it now." : "Grab yours today.");

        if (f.format) {
          if (hype) points[2] += " " + hype;
          return headline + "\n\n" + points.map((p) => "- " + p).join("\n") + "\n\n" + cta;
        }
        const opener = voice === "plain" ? (ctx ? "This is the TrailMate water bottle." : "This is our new water bottle.") : headline + (/[.!?]$/.test(headline) ? "" : "!");
        return fluff.concat([opener], points, hype ? [hype] : [], [cta]).join(" ");
      }
    },
    {
      label: "Explain a concept",
      task: "Explain recursion.",
      text: {
        role: "You are a patient programming teacher for beginners.",
        context: "I know JavaScript loops and functions, but I have never used recursion. I have a job interview next week.",
        constraints: "Keep the explanation under 90 words, not counting code. No math formulas. Mention the most common beginner mistake.",
        examples: "Use an everyday picture, like this example for loops: \"A loop is like running laps until the coach says stop.\"",
        format: "Format: 1) a one-sentence definition, 2) a short code example, 3) the common mistake."
      },
      build(f) {
        const voice = f.examples ? "picture" : f.role ? "teacher" : "plain";
        const definition = {
          plain: "Recursion is a programming technique in which a function calls itself in order to solve a problem by breaking it down into smaller subproblems of the same type.",
          teacher: "Recursion simply means a function that calls itself, each time with a smaller piece of the problem.",
          picture: "Recursion is like opening nesting dolls: open a doll, find a smaller doll inside, and repeat until you reach the smallest one. That smallest doll is where you stop."
        }[voice];
        const code = f.context
          ? "function countdown(n) {\n  if (n === 0) return;   // base case: stop here\n  console.log(n);\n  countdown(n - 1);      // call itself with a smaller n\n}"
          : "def factorial(n):\n    if n <= 1:\n        return 1\n    return n * factorial(n - 1)";
        const codeIntro = f.context ? "In JavaScript:" : "For example, in Python:";
        const mistake = "Common mistake: forgetting the base case (the stop condition). The function then calls itself forever and crashes with a \"stack overflow\" error.";
        const mathy = f.constraints ? [] : ["Formally, recursion is closely related to mathematical induction, and its running time is often described by a recurrence relation such as T(n) = T(n - 1) + O(1)."];
        const extra = f.constraints ? [] : ["Recursion appears in tree traversal, divide-and-conquer algorithms, dynamic programming and backtracking. Some languages optimize tail calls, and recursion can be less efficient than iteration because every call uses stack memory."];
        const interview = f.context ? ["Interview tip: say the base case out loud first. Interviewers look for that."] : [];

        if (f.format) {
          return ["1) " + definition]
            .concat(mathy, ["2) " + codeIntro + "\n" + code], extra, ["3) " + mistake], interview)
            .join("\n\n");
        }
        return [definition].concat(mathy, [codeIntro + "\n" + code], extra, f.constraints ? [mistake] : [], interview).join("\n\n");
      }
    }
  ];

  let labTask = 0;
  const labFlags = { role: false, context: false, constraints: false, examples: false, format: false };

  function wordCount(text) {
    return (text.match(/[A-Za-z0-9][A-Za-z0-9'.,+-]*/g) || []).length;
  }

  function renderLab() {
    const task = LAB_TASKS[labTask];
    const prompt = clear($("#lab-prompt"));
    const order = ["role", "context", "task", "constraints", "examples", "format"];
    const parts = [];

    order.forEach((key) => {
      if (key === "task") {
        parts.push(el("span", "p-task", task.task));
      } else if (labFlags[key]) {
        parts.push(el("span", BLOCKS.find((b) => b.key === key).cls, task.text[key]));
      }
    });
    parts.forEach((part, i) => {
      prompt.appendChild(part);
      if (i < parts.length - 1) prompt.appendChild(document.createTextNode("\n"));
    });

    const output = task.build(labFlags);
    $("#lab-output").textContent = output;

    const used = BLOCKS.filter((b) => labFlags[b.key]).length;
    $("#lab-score-label").textContent = used + " of 5 building blocks";
    const fill = $("#lab-score-fill");
    fill.style.width = (used / 5) * 100 + "%";
    fill.classList.toggle("full", used < 3);

    const promptWords = wordCount(prompt.textContent);
    const outputWords = wordCount(output);
    const stats = clear($("#lab-stats"));
    [[promptWords, "words in prompt"], [outputWords, "words in answer"]].forEach(([v, l]) => {
      const k = el("div", "mini-stat");
      k.appendChild(el("b", null, String(v)));
      k.appendChild(el("span", null, l));
      stats.appendChild(k);
    });

    const list = clear($("#lab-checklist"));
    BLOCKS.forEach((b) => {
      const li = el("li", labFlags[b.key] ? "good" : "warn");
      li.appendChild(rich("span", [[b.label + ": ", null, "b"], labFlags[b.key] ? b.why : "Missing. " + b.why]));
      list.appendChild(li);
    });
  }

  function buildLabToggles() {
    const box = clear($("#lab-blocks"));
    BLOCKS.forEach((b) => {
      const label = el("label", "block-toggle " + b.cls);
      const input = el("input");
      input.type = "checkbox";
      input.id = "lab-" + b.key;
      input.checked = labFlags[b.key];
      label.htmlFor = input.id;
      input.addEventListener("change", () => {
        labFlags[b.key] = input.checked;
        renderLab();
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode(" + " + b.label));
      box.appendChild(label);
    });
  }

  function setAllBlocks(value) {
    BLOCKS.forEach((b) => { labFlags[b.key] = value; });
    buildLabToggles();
    renderLab();
  }

  seg($("#lab-tasks"), LAB_TASKS.map((t, i) => ({ value: i, label: t.label })), labTask, (v) => {
    labTask = Number(v);
    renderLab();
  });
  $("#lab-none").addEventListener("click", () => setAllBlocks(false));
  $("#lab-all").addEventListener("click", () => setAllBlocks(true));
  buildLabToggles();
  renderLab();

  /* ---------- Check your own prompt ---------- */
  const DETECT = [
    ["role", /\b(you are|act as|pretend to be|your role|as an? (expert|teacher|writer|copywriter|developer|engineer|doctor|lawyer|analyst))\b/i, "Add who the AI should be: \"You are a ...\""],
    ["context", /\b(my|our|we|i am|i'm|i have|audience|readers|customers|product|background|because|for (a|an|my|our))\b/i, "Add the situation and facts: who it is for, what you already know, details."],
    ["constraints", /\b(under|maximum|max|at most|no more than|\d+ words|avoid|don't|do not|must|only|limit|tone)\b/i, "Add limits: length, tone, what to avoid."],
    ["examples", /\b(example|for instance|e\.g\.|like this|such as|sample)\b/i, "Show one example of a good answer or style."],
    ["format", /\b(format|bullet|bullets|table|json|list|headline|steps|numbered|markdown|sections?|paragraphs?)\b/i, "Say the shape of the answer: bullets, table, steps, JSON."]
  ];

  function checkPrompt() {
    const text = $("#lab-own").value;
    const list = clear($("#lab-own-result"));
    let found = 0;
    DETECT.forEach(([key, regex, tip]) => {
      const ok = regex.test(text);
      if (ok) found++;
      const label = BLOCKS.find((b) => b.key === key).label;
      const li = el("li", ok ? "good" : "warn");
      li.appendChild(rich("span", [[label + ": ", null, "b"], ok ? "found" : tip]));
      list.appendChild(li);
    });
    $("#lab-own-score").textContent = found + " of 5 found";
  }

  $("#lab-own").addEventListener("input", checkPrompt);
  checkPrompt();

  /* ====================================================== RAG in detail */
  const RAG_DOCS = [
    {
      name: "leave-policy.md",
      sentences: [
        "Every full-time employee gets 24 days of paid annual leave per year.",
        "Up to 10 unused annual leave days can be carried forward to the next year.",
        "Any unused days above 10 are lost on 31 December.",
        "Sick leave is separate: 12 days per year.",
        "For sick leave longer than 2 days in a row, a doctor's note is required."
      ]
    },
    {
      name: "expense-policy.md",
      sentences: [
        "Business travel costs are paid back within 30 days of submitting a claim.",
        "During travel, meals are covered up to Rs 1,500 per day.",
        "Hotel bookings must be made through the company travel portal.",
        "Every claim needs a photo of the receipt."
      ]
    },
    {
      name: "it-security.md",
      sentences: [
        "All accounts must use multi-factor authentication (MFA).",
        "Never paste passwords, API keys or customer data into public AI chat tools.",
        "If your laptop is lost or stolen, report it to the IT helpdesk within 24 hours.",
        "IT will lock the laptop remotely and reset your passwords."
      ]
    }
  ];

  const CONCEPTS = {
    leave: ["leave", "holiday", "vacation", "off"],
    carry: ["carry", "carried", "forward", "next", "unused", "rollover", "keep"],
    year: ["year", "yearly", "annual", "december"],
    sick: ["sick", "ill", "doctor", "note", "medical"],
    days: ["day", "days", "daily", "per"],
    travel: ["travel", "trip", "business", "hotel", "hotels", "traveling", "portal"],
    food: ["meal", "meals", "food", "lunch", "dinner", "eat"],
    money: ["rs", "cost", "costs", "paid", "claim", "receipt", "expense", "limit", "covered", "back", "price"],
    device: ["laptop", "computer", "device", "phone"],
    lost: ["lost", "lose", "stolen", "steal", "missing"],
    help: ["report", "helpdesk", "lock", "reset", "do", "should"],
    security: ["password", "passwords", "mfa", "authentication", "account", "accounts", "keys", "wifi", "wi-fi", "secure"],
    ai: ["ai", "chat", "paste", "public", "tools"],
    people: ["employee", "full-time", "staff", "i", "my"]
  };
  const CONCEPT_KEYS = Object.keys(CONCEPTS);

  function embed(text) {
    const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
    return CONCEPT_KEYS.map((key) => words.filter((w) => CONCEPTS[key].includes(w)).length);
  }

  function cosine(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  }

  const RAG_QUESTIONS = [
    {
      q: "How many leave days can I carry to next year?",
      facts: [
        ["carried forward", "You can carry forward up to 10 unused annual leave days"],
        ["lost on 31 December", "Any days above 10 are lost on 31 December"]
      ]
    },
    {
      q: "What is the daily food limit on a business trip?",
      facts: [["Rs 1,500", "Meals are covered up to Rs 1,500 per day while traveling"]]
    },
    {
      q: "What should I do if my laptop gets stolen?",
      facts: [
        ["within 24 hours", "Report it to the IT helpdesk within 24 hours"],
        ["lock the laptop", "IT will then lock it remotely and reset your passwords"]
      ]
    },
    {
      q: "What is the office Wi-Fi password?",
      facts: []
    }
  ];

  const MIN_SCORE = 0.3;
  let ragQuestion = 0;
  let ragSize = "small";
  let ragTopK = 2;

  function makeChunks() {
    const chunks = [];
    RAG_DOCS.forEach((doc) => {
      const groups = [];
      if (ragSize === "small") doc.sentences.forEach((s) => groups.push([s]));
      if (ragSize === "medium") for (let i = 0; i < doc.sentences.length; i += 2) groups.push(doc.sentences.slice(i, i + 2));
      if (ragSize === "large") groups.push(doc.sentences.slice());
      groups.forEach((g) => chunks.push({ id: chunks.length + 1, doc: doc.name, text: g.join(" ") }));
    });
    chunks.forEach((c) => { c.vec = embed(c.text); });
    return chunks;
  }

  function vecCells(vec) {
    const max = Math.max(1, ...vec);
    const cells = el("span", "vec-cells");
    cells.title = "Toy embedding: one cell per meaning group";
    vec.forEach((v) => {
      const cell = el("i");
      cell.style.opacity = v ? (0.25 + 0.75 * (v / max)).toFixed(2) : "0.06";
      cells.appendChild(cell);
    });
    return cells;
  }

  function renderRag() {
    const question = $("#rag-input").value.trim() || RAG_QUESTIONS[ragQuestion].q;
    const preset = RAG_QUESTIONS.find((r) => r.q.toLowerCase() === question.toLowerCase());
    const chunks = makeChunks();
    const qVec = embed(question);

    chunks.forEach((c) => { c.score = cosine(qVec, c.vec); });
    const ranked = chunks.slice().sort((a, b) => b.score - a.score);
    const selected = ranked.filter((c) => c.score >= MIN_SCORE).slice(0, ragTopK);
    const selectedIds = new Set(selected.map((c) => c.id));
    $("#rag-topk-val").textContent = ragTopK;

    // Step 1 + 2: chunks with embeddings
    const chunkList = clear($("#rag-chunks"));
    chunks.forEach((c) => {
      const row = el("div", "chunk-row");
      row.appendChild(el("span", "id", "#" + c.id));
      const body = el("span", "chunk-text");
      body.appendChild(el("span", "note", c.doc + " "));
      body.appendChild(document.createTextNode(c.text));
      row.appendChild(body);
      row.appendChild(vecCells(c.vec));
      chunkList.appendChild(row);
    });
    $("#rag-chunk-count").textContent = chunks.length + " chunks from " + RAG_DOCS.length + " documents";

    // Step 3: search
    const qBox = clear($("#rag-qvec"));
    qBox.appendChild(el("span", null, "\"" + question + "\""));
    qBox.appendChild(vecCells(qVec));

    const results = clear($("#rag-results"));
    ranked.slice(0, 5).forEach((c) => {
      const used = selectedIds.has(c.id);
      const row = el("div", "result-row" + (used ? " used" : ""));
      row.appendChild(el("span", "id", "#" + c.id));
      const text = el("span", "chunk-text", c.text);
      text.title = c.text;
      row.appendChild(text);
      row.appendChild(G.barRow("", c.score, c.score.toFixed(2), used ? "top" : null));
      row.appendChild(el("span", "pill " + (used ? "good" : c.score < MIN_SCORE ? "plain" : "warn"), used ? "used" : c.score < MIN_SCORE ? "too weak" : "not in top-k"));
      results.appendChild(row);
    });

    // Step 4: prompt
    const context = selected.map((c, i) => "[" + (i + 1) + "] (" + c.doc + ") " + c.text).join("\n");
    const promptText =
      "Answer the question using ONLY the sources below.\n" +
      "Cite sources like [1]. If the sources don't contain the answer, say you don't know.\n\n" +
      "Sources:\n" + (context || "(no sources passed the minimum match score)") + "\n\n" +
      "Question: " + question;
    $("#rag-prompt").textContent = promptText;
    const promptTokens = Math.ceil(promptText.length / 4);
    $("#rag-prompt-tokens").textContent = "about " + promptTokens + " tokens";

    // Step 5: answer
    const answer = clear($("#rag-answer"));
    if (preset) {
      const parts = [];
      let missing = 0;
      preset.facts.forEach(([needle, sentence]) => {
        const idx = selected.findIndex((c) => c.text.includes(needle));
        if (idx >= 0) parts.push(sentence + " [" + (idx + 1) + "].");
        else missing++;
      });

      if (!preset.facts.length) {
        answer.appendChild(el("p", "big-sentence", "The documents don't mention the office Wi-Fi password, so I can't answer. Please ask the IT helpdesk."));
        answer.appendChild(el("div", "answer good", selected.length
          ? "Correct behaviour: a passage about passwords was retrieved, but it does not answer the question, so the model says it doesn't know."
          : "Correct behaviour: nothing relevant was found, and the model did not guess."));
      } else if (!parts.length) {
        answer.appendChild(el("p", "big-sentence", "The documents I was given don't say."));
        answer.appendChild(el("div", "answer bad", "Retrieval missed the right chunk, so the answer is unhelpful. Try a bigger top-k or bigger chunks."));
      } else {
        answer.appendChild(el("p", "big-sentence", parts.join(" ")));
        answer.appendChild(el("div", "answer " + (missing ? "" : "good"), missing
          ? "Partly complete: one useful fact was in a chunk that was not retrieved. Bigger chunks or a higher top-k would include it."
          : "Complete and cited. Every fact can be checked in the source chunk."));
      }
    } else if (selected.length) {
      answer.appendChild(el("p", "big-sentence", "Based on the sources: " + selected[0].text + " [1]"));
      answer.appendChild(el("p", "note", "Demo answer built from the top chunk. A real model would write a proper sentence from all the chunks."));
    } else {
      answer.appendChild(el("p", "big-sentence", "I couldn't find this in the documents."));
      answer.appendChild(el("p", "note", "No chunk passed the minimum match score of " + MIN_SCORE + "."));
    }
  }

  picks($("#rag-questions"), RAG_QUESTIONS.map((r) => r.q), ragQuestion, (i) => {
    ragQuestion = i;
    $("#rag-input").value = RAG_QUESTIONS[i].q;
    renderRag();
  });

  seg($("#rag-size"), [
    { value: "small", label: "Small (1 sentence)" },
    { value: "medium", label: "Medium (2 sentences)" },
    { value: "large", label: "Large (whole document)" }
  ], ragSize, (v) => {
    ragSize = v;
    renderRag();
  });

  $("#rag-topk").addEventListener("input", () => {
    ragTopK = Number($("#rag-topk").value);
    renderRag();
  });
  $("#rag-ask").addEventListener("click", renderRag);
  $("#rag-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") renderRag();
  });

  $("#rag-input").value = RAG_QUESTIONS[ragQuestion].q;
  renderRag();
})();
