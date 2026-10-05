/* Part 3: Inside the model */
(function () {
  const { $, $$, el, svg, clear, onActivate, seg, softmax, pct, barRow } = G;

  /* ====================================================== Journey */
  const STEPS = [
    {
      short: "You write a message",
      title: "1. You write a message",
      text: "You type your question and press Send. The app also adds earlier chat messages and a hidden \"system prompt\" (rules like \"be helpful\").",
      ex: "\"Explain React in one line\""
    },
    {
      short: "Text is cut into tokens",
      title: "2. Text is cut into tokens",
      text: "The tokenizer cuts the text into small pieces. Common words are one piece. Rare or long words become several pieces.",
      ex: "[\"Explain\"] [\" React\"] [\" in\"] [\" one\"] [\" line\"]"
    },
    {
      short: "Tokens become numbers",
      title: "3. Tokens become numbers",
      text: "Each token has an ID. The ID is turned into a long list of numbers (an embedding) that holds its meaning. Position numbers are added so the model knows word order.",
      ex: "\" React\"  ->  ID 23177  ->  [0.12, -0.83, 0.41, ...]"
    },
    {
      short: "The model reads everything",
      title: "4. The transformer reads everything together",
      text: "All tokens pass through many layers. In each layer, attention lets every token look at every other token (using Q, K and V) and pull in useful information.",
      ex: "\"React\" pays attention to \"Explain\" and \"one line\""
    },
    {
      short: "It scores the next token",
      title: "5. It scores every possible next token",
      text: "The last layer gives a chance (probability) to every token in the vocabulary, often more than 100,000 of them. Then one token is picked with greedy or sampling.",
      ex: "\"React\" 41%   \"It\" 22%   \"A\" 18%   ..."
    },
    {
      short: "Repeat, word by word",
      title: "6. Add it and repeat",
      text: "The picked token is added to the text, and the whole process runs again for the next token. Sending each token to you right away is called \"streaming\".",
      ex: "React -> React is -> React is a -> React is a library ..."
    },
    {
      short: "Stop and show the answer",
      title: "7. Stop and show the answer",
      text: "It stops when it picks a special \"end\" token or reaches the length limit. The tokens are turned back into normal text.",
      ex: "\"React is a JavaScript library for building user interfaces.\""
    }
  ];

  let currentStep = 0;
  let playTimer = null;
  const stepList = $("#journey-steps");

  STEPS.forEach((s, i) => {
    const li = el("li");
    const b = el("button", "step-btn");
    b.type = "button";
    b.appendChild(el("span", "num", String(i + 1)));
    b.appendChild(el("span", null, s.short));
    b.addEventListener("click", () => {
      stopPlay();
      setStep(i);
    });
    li.appendChild(b);
    stepList.appendChild(li);
  });

  function setStep(i) {
    currentStep = i;
    $$(".step-btn", stepList).forEach((b, j) => {
      b.classList.toggle("active", j === i);
      b.classList.toggle("done", j < i);
    });
    const s = STEPS[i];
    const box = clear($("#journey-detail"));
    box.appendChild(el("h4", null, s.title));
    box.appendChild(el("p", null, s.text));
    box.appendChild(el("div", "example", s.ex));
  }

  function stopPlay() {
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    $("#journey-play").textContent = "Play all steps";
  }

  $("#journey-play").addEventListener("click", function () {
    if (playTimer) {
      stopPlay();
      return;
    }
    setStep(0);
    this.textContent = "Stop";
    playTimer = setInterval(() => {
      if (currentStep >= STEPS.length - 1) {
        stopPlay();
        return;
      }
      setStep(currentStep + 1);
    }, 2600);
  });

  setStep(0);

  /* ====================================================== Tokens */
  function tokenize(text) {
    const parts = text.match(/\s*[A-Za-z]+|\s*\d{1,3}|\s*[^\sA-Za-z\d]|\s+/g) || [];
    const out = [];
    parts.forEach((p) => {
      const m = p.match(/^(\s*)([A-Za-z]+)$/);
      if (m && m[2].length > 7) {
        const core = m[2];
        let i = 0;
        let first = true;
        while (i < core.length) {
          const left = core.length - i;
          const size = left <= 6 ? left : 4;
          out.push((first ? m[1] : "") + core.slice(i, i + size));
          first = false;
          i += size;
        }
      } else {
        out.push(p);
      }
    });
    return out;
  }

  function fakeId(t) {
    let h = 7;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 99991;
    return h + 100;
  }

  function renderTokens() {
    const text = $("#token-input").value;
    const showNums = $("#token-numbers").checked;
    const toks = tokenize(text);
    const box = clear($("#token-box"));

    toks.forEach((t, i) => {
      const chip = el("span", "token c" + (i % 5));
      if (showNums) {
        chip.textContent = String(fakeId(t));
      } else {
        const lead = t.match(/^\s*/)[0];
        if (lead.length) chip.appendChild(el("span", "sp", lead.replace(/\n/g, "\\n").replace(/ /g, "_")));
        chip.appendChild(document.createTextNode(t.slice(lead.length)));
      }
      chip.title = "Token " + (i + 1) + ": \"" + t + "\"";
      box.appendChild(chip);
    });

    if (!toks.length) box.appendChild(el("span", "note", "Type something above to see its tokens."));
    $("#stat-chars").textContent = text.length;
    $("#stat-words").textContent = (text.trim().match(/\S+/g) || []).length;
    $("#stat-tokens").textContent = toks.length;
  }

  $("#token-input").addEventListener("input", renderTokens);
  $("#token-numbers").addEventListener("change", renderTokens);
  renderTokens();

  /* ====================================================== BPE */
  const CORPUS = [["low", 5], ["lower", 2], ["newest", 6], ["widest", 3]];
  let bpe;

  function bpeReset() {
    bpe = {
      words: CORPUS.map(([w, c]) => ({ word: w, count: c, symbols: w.split("") })),
      merges: []
    };
    renderBpe();
  }

  function pairCounts() {
    const counts = new Map();
    bpe.words.forEach((w) => {
      for (let i = 0; i < w.symbols.length - 1; i++) {
        const key = w.symbols[i] + "\u0000" + w.symbols[i + 1];
        counts.set(key, (counts.get(key) || 0) + w.count);
      }
    });
    return Array.from(counts.entries())
      .map(([key, count]) => {
        const [a, b] = key.split("\u0000");
        return { a, b, count };
      })
      .sort((x, y) => y.count - x.count);
  }

  function bpeMerge() {
    const pairs = pairCounts();
    if (!pairs.length) return;
    const { a, b, count } = pairs[0];

    bpe.words.forEach((w) => {
      const out = [];
      for (let i = 0; i < w.symbols.length; i++) {
        if (i < w.symbols.length - 1 && w.symbols[i] === a && w.symbols[i + 1] === b) {
          out.push(a + b);
          i++;
        } else {
          out.push(w.symbols[i]);
        }
      }
      w.symbols = out;
    });

    bpe.merges.push({ a, b, count, token: a + b });
    renderBpe();
  }

  function renderBpe() {
    const learned = new Set(bpe.merges.map((m) => m.token));
    const newest = bpe.merges.length ? bpe.merges[bpe.merges.length - 1].token : null;

    const words = clear($("#bpe-words"));
    bpe.words.forEach((w) => {
      const row = el("div", "bpe-word");
      row.appendChild(el("span", "src", w.word + " x" + w.count));
      const pieces = el("div", "chips");
      w.symbols.forEach((s) => pieces.appendChild(el("span", "sym" + (s === newest ? " new" : ""), s)));
      row.appendChild(pieces);
      words.appendChild(row);
    });

    const pairs = pairCounts();
    const pairBox = clear($("#bpe-pairs"));
    const maxCount = pairs.length ? pairs[0].count : 1;
    pairs.slice(0, 5).forEach((p, i) => {
      pairBox.appendChild(barRow(p.a + " + " + p.b, p.count / maxCount, p.count + " times", i === 0 ? "top" : null));
    });
    if (!pairs.length) pairBox.appendChild(el("p", "note", "Every word is now a single token. Nothing left to glue."));

    const vocab = clear($("#bpe-vocab"));
    if (!learned.size) vocab.appendChild(el("span", "note", "None yet. Only single letters."));
    bpe.merges.forEach((m) => vocab.appendChild(el("span", "sym" + (m.token === newest ? " new" : ""), m.token)));

    $("#bpe-count").textContent = "Merges done: " + bpe.merges.length;
    $("#bpe-merge").disabled = !pairs.length;
  }

  $("#bpe-merge").addEventListener("click", bpeMerge);
  $("#bpe-reset").addEventListener("click", bpeReset);
  bpeReset();

  /* ====================================================== Embeddings */
  const POINTS = [
    ["dog", 70, 72], ["puppy", 104, 56], ["cat", 56, 106], ["kitten", 92, 118],
    ["apple", 300, 60], ["banana", 336, 92], ["mango", 290, 106],
    ["car", 78, 222], ["bus", 118, 246], ["bike", 58, 262],
    ["React", 292, 214], ["JavaScript", 318, 246], ["Python", 278, 270],
    ["king", 196, 146], ["queen", 222, 170]
  ];

  const CLUSTERS = [["animals", 44, 30], ["fruit", 282, 30], ["transport", 44, 196], ["coding", 268, 190], ["royalty", 176, 122]];

  const mSvg = $("#meaning-svg");
  let linkLayer;

  function buildMeaning() {
    for (let x = 40; x < 440; x += 40) mSvg.appendChild(svg("line", { x1: x, y1: 0, x2: x, y2: 300, class: "gridline" }));
    for (let y = 40; y < 300; y += 40) mSvg.appendChild(svg("line", { x1: 0, y1: y, x2: 440, y2: y, class: "gridline" }));

    CLUSTERS.forEach(([name, x, y]) => {
      const t = svg("text", { x, y, class: "cluster" });
      t.textContent = name;
      mSvg.appendChild(t);
    });

    linkLayer = svg("g", {});
    mSvg.appendChild(linkLayer);

    POINTS.forEach(([word, x, y], i) => {
      const g = svg("g", { class: "pt", tabindex: "0", role: "button", "aria-label": word, "data-i": i });
      g.appendChild(svg("circle", { cx: x, cy: y, r: 6 }));
      const t = svg("text", { x: x + 10, y: y + 4 });
      t.textContent = word;
      g.appendChild(t);
      onActivate(g, () => selectWord(i));
      mSvg.appendChild(g);
    });
  }

  function selectWord(i) {
    const p = POINTS[i];
    const dists = POINTS.map((q, j) => ({ j, d: Math.hypot(q[1] - p[1], q[2] - p[2]) }))
      .filter((o) => o.j !== i)
      .sort((a, b) => a.d - b.d);
    const near = dists.slice(0, 3);
    const far = dists[dists.length - 1];

    clear(linkLayer);
    near.forEach((o) => {
      const q = POINTS[o.j];
      linkLayer.appendChild(svg("line", { x1: p[1], y1: p[2], x2: q[1], y2: q[2], class: "link" }));
    });

    $$(".pt", mSvg).forEach((g) => {
      const j = Number(g.getAttribute("data-i"));
      g.classList.toggle("sel", j === i);
      g.classList.toggle("near", near.some((o) => o.j === j));
    });

    const info = clear($("#meaning-info"));
    info.appendChild(document.createTextNode("Closest to "));
    info.appendChild(el("b", null, "\"" + p[0] + "\""));
    info.appendChild(document.createTextNode(": " + near.map((o) => POINTS[o.j][0]).join(", ") + ". Farthest: " + POINTS[far.j][0] + "."));
  }

  buildMeaning();
  selectWord(0);

  /* ====================================================== RNN */
  const RNN_WORDS = ["The", "keys", "that", "I", "left", "on", "the", "kitchen", "table", "next", "to", "the", "old", "book"];
  const KEY_INDEX = 1;
  const DECAY = 0.75;
  let rnnPos = 1;

  function wordVector(word) {
    const v = [];
    let h = 17;
    for (let i = 0; i < 8; i++) {
      for (let c = 0; c < word.length; c++) h = (h * 31 + word.charCodeAt(c) + i) % 1009;
      v.push((h % 100) / 100);
    }
    return v;
  }

  function hiddenState(pos) {
    let h = new Array(8).fill(0);
    for (let i = 0; i <= pos; i++) {
      const x = wordVector(RNN_WORDS[i]);
      h = h.map((value, k) => DECAY * value + (1 - DECAY) * x[k] * 3);
    }
    return h;
  }

  function renderRnn() {
    const compare = $("#rnn-compare").checked;
    const finished = rnnPos >= RNN_WORDS.length - 1;
    const words = clear($("#rnn-words"));

    RNN_WORDS.forEach((w, i) => {
      let cls = "rnn-w";
      if (i > rnnPos) cls += " unread";
      if (i === rnnPos && !compare) cls += " current";
      if (i === KEY_INDEX) cls += " key";
      const chip = el("span", cls, w);
      if (i <= rnnPos) chip.style.opacity = compare ? 1 : Math.max(0.15, Math.pow(DECAY, rnnPos - i)).toFixed(2);
      words.appendChild(chip);
    });
    words.appendChild(el("span", "rnn-w blank", finished ? "is / are ?" : "..."));
    words.appendChild(el("span", "rnn-w unread", "missing."));

    const h = hiddenState(rnnPos);
    const max = Math.max(...h, 0.01);
    const cells = clear($("#rnn-cells"));
    h.forEach((value) => {
      const cell = el("span", "cell");
      cell.style.opacity = (0.12 + 0.88 * (value / max)).toFixed(2);
      cells.appendChild(cell);
    });

    const keyStrength = compare ? 1 : Math.pow(DECAY, rnnPos - KEY_INDEX);
    $("#rnn-keys-label").textContent = compare ? "Transformer: direct look at \"keys\"" : "How much the memory still holds \"keys\"";
    $("#rnn-keys-pct").textContent = Math.round(keyStrength * 100) + "%";
    const fill = $("#rnn-keys-fill");
    fill.style.width = keyStrength * 100 + "%";
    fill.classList.toggle("full", keyStrength < 0.3);

    const result = $("#rnn-result");
    result.className = "answer";
    if (!finished) {
      result.textContent = "Reading word " + (rnnPos + 1) + " of " + RNN_WORDS.length + ": \"" + RNN_WORDS[rnnPos] + "\". The memory is rewritten after every word.";
    } else if (compare) {
      result.classList.add("good");
      result.textContent = "Transformer guesses \"are\" (correct). Attention jumps straight back to \"keys\", which is plural, no matter how far away it is.";
    } else {
      result.classList.add("bad");
      result.textContent = "RNN guesses \"is\" (wrong). \"keys\" has faded to " + Math.round(keyStrength * 100) + "% of memory, and the last noun it clearly remembers is \"book\", which is singular.";
    }

    $("#rnn-next").disabled = finished;
    $("#rnn-all").disabled = finished;
  }

  $("#rnn-next").addEventListener("click", () => {
    if (rnnPos < RNN_WORDS.length - 1) rnnPos++;
    renderRnn();
  });
  $("#rnn-all").addEventListener("click", () => {
    rnnPos = RNN_WORDS.length - 1;
    renderRnn();
  });
  $("#rnn-reset").addEventListener("click", () => {
    rnnPos = 1;
    renderRnn();
  });
  $("#rnn-compare").addEventListener("change", renderRnn);
  renderRnn();

  /* ====================================================== Transformer */
  const TF_BASE = ["The", "animal", "didn't", "cross", "the", "street", "because", "it", "was", "too"];
  let tfVariant = "tired";
  let tfSelected = 7;

  function tfWords() {
    return TF_BASE.concat([tfVariant]);
  }

  function attentionFor(i) {
    const n = TF_BASE.length + 1;
    const tired = tfVariant === "tired";
    const w = new Array(n).fill(0.02);
    w[i] += 0.25;
    if (i > 0) w[i - 1] += 0.1;
    if (i < n - 1) w[i + 1] += 0.1;

    const special = {
      0: { 1: 0.4 },
      1: { 0: 0.2, 3: 0.2 },
      2: { 3: 0.35, 1: 0.15 },
      3: { 1: 0.3, 5: 0.3 },
      4: { 5: 0.4 },
      5: { 3: 0.3, 4: 0.15 },
      6: { 2: 0.2, 10: 0.2 },
      7: tired ? { 1: 0.9, 10: 0.2 } : { 5: 0.9, 10: 0.2 },
      8: { 7: 0.3, 10: 0.2 },
      9: { 10: 0.4 },
      10: tired ? { 1: 0.5, 7: 0.2 } : { 5: 0.5, 7: 0.2 }
    };

    Object.entries(special[i] || {}).forEach(([j, v]) => {
      w[Number(j)] += v;
    });

    const sum = w.reduce((a, b) => a + b, 0);
    return w.map((v) => v / sum);
  }

  const tfSvg = $("#tf-svg");
  const CHAR_W = 9.2;
  const PAD = 6;
  const GAP = 6;
  const BOX_Y = 122;
  const BOX_H = 32;

  function renderTransformer() {
    const words = tfWords();
    const weights = attentionFor(tfSelected);

    const layout = [];
    let x = 10;
    words.forEach((w) => {
      const width = w.length * CHAR_W + PAD * 2;
      layout.push({ x, width, cx: x + width / 2 });
      x += width + GAP;
    });
    const totalW = Math.ceil(x);
    const totalH = BOX_Y + BOX_H + 10;

    clear(tfSvg);
    tfSvg.setAttribute("viewBox", "0 0 " + totalW + " " + totalH);
    tfSvg.setAttribute("width", totalW);
    tfSvg.setAttribute("height", totalH);

    const from = layout[tfSelected];
    words.forEach((_, j) => {
      if (j === tfSelected) return;
      const to = layout[j];
      const dist = Math.abs(to.cx - from.cx);
      const lift = Math.min(BOX_Y - 12, 24 + dist * 0.28);
      const path = svg("path", {
        d: "M " + from.cx + " " + (BOX_Y - 2) + " Q " + (from.cx + to.cx) / 2 + " " + (BOX_Y - 2 - lift * 2) + " " + to.cx + " " + (BOX_Y - 2),
        class: "arc",
        "stroke-width": (0.6 + weights[j] * 16).toFixed(2),
        opacity: Math.min(1, 0.15 + weights[j] * 2.2).toFixed(2)
      });
      tfSvg.appendChild(path);
    });

    words.forEach((w, j) => {
      const g = svg("g", { class: "attn-word" + (j === tfSelected ? " sel" : ""), tabindex: "0", role: "button", "aria-label": w });
      g.appendChild(svg("rect", { x: layout[j].x, y: BOX_Y, width: layout[j].width, height: BOX_H, rx: 6 }));
      const t = svg("text", { x: layout[j].cx, y: BOX_Y + 21, "text-anchor": "middle" });
      t.textContent = w;
      g.appendChild(t);
      onActivate(g, () => {
        tfSelected = j;
        renderTransformer();
      });
      tfSvg.appendChild(g);
    });

    $("#tf-focus-label").textContent = "Where \"" + words[tfSelected] + "\" looks (top 4)";
    const bars = clear($("#tf-bars"));
    weights
      .map((v, j) => ({ v, j }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 4)
      .forEach((o, k) => bars.appendChild(barRow(words[o.j] + (o.j === tfSelected ? " (self)" : ""), o.v / weights.reduce((m, v) => Math.max(m, v), 0), pct(o.v), k === 0 ? "top" : null)));
  }

  seg($("#tf-variant"), [{ value: "tired", label: "tired" }, { value: "wide", label: "wide" }], tfVariant, (v) => {
    tfVariant = v;
    renderTransformer();
  });

  renderTransformer();

  const TF_STACK = [
    { key: "output", label: "Output: chance for every next token", text: "The final numbers are turned into a probability for every token in the vocabulary. Then greedy or sampling picks one (see below)." },
    { key: "ff", label: "Feed-forward network", text: "A small neural network works on each token on its own. It is where a lot of the knowledge learned in training is stored.", layer: true },
    { key: "attn", label: "Attention (Q, K, V)", text: "Every token looks at every other token and pulls in useful information. This is the part shown on the left.", layer: true },
    { key: "pos", label: "Add word positions", text: "Attention by itself does not know word order, so numbers for each position are added. Now \"dog bites man\" and \"man bites dog\" look different." },
    { key: "emb", label: "Embeddings", text: "Each token ID becomes a list of numbers that holds its meaning (see the meaning map)." },
    { key: "tok", label: "Tokens", text: "The text is cut into tokens by the tokenizer." }
  ];

  function renderStack(activeKey) {
    const stack = clear($("#tf-stack"));
    let group = null;

    TF_STACK.forEach((item) => {
      const button = el("button", item.key === activeKey ? "active" : null, item.label);
      button.type = "button";
      button.addEventListener("click", () => renderStack(item.key));

      if (item.layer) {
        if (!group) {
          group = el("div", "tf-layers");
          group.appendChild(el("span", "box-label", "One layer. Repeated many times (big models: dozens of layers)"));
          stack.appendChild(group);
        }
        group.appendChild(button);
      } else {
        stack.appendChild(button);
      }
    });

    const item = TF_STACK.find((s) => s.key === activeKey);
    const detail = clear($("#tf-stack-detail"));
    detail.appendChild(el("h4", null, item.label));
    detail.appendChild(el("p", null, item.text));
  }

  renderStack("attn");

  /* ====================================================== Q K V */
  const QKV = [
    { w: "I", q: [1.5, 0], k: [0, 0], v: [0, 0] },
    { w: "ate", q: [3, 0], k: [2.4, 0], v: [0, 0.5] },
    { w: "a", q: [0, 1], k: [0, 0.6], v: [0, 0] },
    { w: "sweet", q: [3, 0.5], k: [1.8, 2.7], v: [0, 2] },
    { w: "red", q: [3, 0.5], k: [0.3, 3], v: [2, 0] },
    { w: "apple", q: [0.6, 3], k: [3, 0.3], v: [0.5, 0.5] }
  ];

  let qkvIndex = 5;
  const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, ".0");
  const vec = (v) => "[" + v.map((n) => fmt(n)).join(", ") + "]";

  function renderQkv() {
    const q = [Number($("#qkv-q1").value), Number($("#qkv-q2").value)];
    $("#qkv-q1-val").textContent = q[0].toFixed(1);
    $("#qkv-q2-val").textContent = q[1].toFixed(1);

    const scale = Math.sqrt(2);
    const scores = QKV.map((item) => (q[0] * item.k[0] + q[1] * item.k[1]) / scale);
    const weights = softmax(scores);
    const maxW = Math.max(...weights);

    const body = clear($("#qkv-table"));
    QKV.forEach((item, i) => {
      const tr = el("tr", i === qkvIndex ? "sel" : null);
      tr.appendChild(el("td", null, item.w + (i === qkvIndex ? " (asking)" : "")));
      tr.appendChild(el("td", "vec", vec(item.k)));
      tr.appendChild(el("td", "vec", fmt(scores[i] * scale) + " / 1.41 = " + fmt(scores[i])));
      const wTd = el("td", "num");
      const bar = el("span", "wbar");
      const fill = el("i");
      fill.style.width = (weights[i] / maxW) * 100 + "%";
      bar.appendChild(fill);
      wTd.appendChild(bar);
      wTd.appendChild(document.createTextNode(pct(weights[i])));
      tr.appendChild(wTd);
      tr.appendChild(el("td", "vec", vec(item.v)));
      body.appendChild(tr);
    });

    const out = [0, 1].map((d) => QKV.reduce((sum, item, i) => sum + weights[i] * item.v[d], 0));
    const ranked = QKV.map((item, i) => ({ w: item.w, p: weights[i] })).sort((a, b) => b.p - a.p);

    const output = clear($("#qkv-output"));
    output.appendChild(el("b", null, "Most attention: "));
    output.appendChild(document.createTextNode(ranked.slice(0, 2).map((r) => r.w + " (" + pct(r.p) + ")").join(", ") + "."));
    output.appendChild(document.createTextNode("\nNew meaning of \"" + QKV[qkvIndex].w + "\" = " + vec(out) + "  ->  color info " + fmt(out[0]) + ", taste info " + fmt(out[1]) + "."));
    if (qkvIndex === 5 && Math.abs(q[0] - 0.6) < 0.01 && Math.abs(q[1] - 3) < 0.01) {
      output.appendChild(document.createTextNode("\n\"apple\" now carries the ideas of red and sweet. Try moving the sliders."));
    }
  }

  function selectQkvWord(i) {
    qkvIndex = i;
    $("#qkv-q1").value = QKV[i].q[0];
    $("#qkv-q2").value = QKV[i].q[1];
    renderQkv();
  }

  seg($("#qkv-words"), QKV.map((item, i) => ({ value: i, label: item.w })), qkvIndex, (v) => selectQkvWord(Number(v)));
  $("#qkv-q1").addEventListener("input", renderQkv);
  $("#qkv-q2").addEventListener("input", renderQkv);
  selectQkvWord(qkvIndex);

  /* ====================================================== Decoding */
  const PROMPTS = [
    { text: "The cat sat on the", words: [["mat", 3.2], ["floor", 2.5], ["sofa", 2.1], ["bed", 1.8], ["roof", 0.9], ["moon", -0.6]] },
    { text: "To make tea, first boil the", words: [["water", 4.2], ["kettle", 2.6], ["milk", 1.8], ["leaves", 0.6], ["pasta", -1.0], ["ocean", -2.4]] },
    { text: "My favorite programming language is", words: [["Python", 2.6], ["JavaScript", 2.4], ["Java", 1.6], ["C++", 1.3], ["Rust", 1.2], ["French", -1.8]] }
  ];

  let promptIdx = 0;
  let decMode = "sampling";
  let lastPick = null;
  let tally = {};

  PROMPTS.forEach((p, i) => {
    const o = el("option", null, p.text + " ...");
    o.value = i;
    $("#prompt-select").appendChild(o);
  });

  function settings() {
    return {
      greedy: decMode === "greedy",
      temp: Number($("#temp").value),
      topk: Number($("#topk").value),
      topp: Number($("#topp").value)
    };
  }

  /**
   * Returns [{ word, base, p, cut }] where base = chance at temperature 1,
   * p = final chance after temperature, top-k and top-p (0 if cut).
   */
  function distribution(words, s) {
    const logits = words.map((w) => w[1]);
    const base = softmax(logits);

    if (s.greedy) {
      const best = base.indexOf(Math.max(...base));
      return words.map((w, i) => ({ word: w[0], base: base[i], p: i === best ? 1 : 0, cut: i === best ? null : "greedy" }));
    }

    const heated = softmax(logits.map((l) => l / s.temp));
    const order = heated.map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p);
    const cut = new Array(words.length).fill(null);

    order.forEach((o, rank) => {
      if (rank >= s.topk) cut[o.i] = "top-k";
    });

    let cumulative = 0;
    order.forEach((o) => {
      if (cut[o.i]) return;
      if (cumulative >= s.topp - 1e-9) cut[o.i] = "top-p";
      cumulative += o.p;
    });

    const kept = heated.map((p, i) => (cut[i] ? 0 : p));
    const sum = kept.reduce((a, b) => a + b, 0) || 1;
    return words.map((w, i) => ({ word: w[0], base: base[i], p: kept[i] / sum, cut: cut[i] }));
  }

  function sample(dist) {
    const r = Math.random();
    let acc = 0;
    for (const d of dist) {
      acc += d.p;
      if (d.p > 0 && r <= acc) return d.word;
    }
    return dist.filter((d) => d.p > 0).pop().word;
  }

  function renderSentence() {
    const s = clear($("#sentence"));
    s.appendChild(document.createTextNode(PROMPTS[promptIdx].text + " "));
    s.appendChild(el("span", "blank", lastPick || "?"));
  }

  function renderBars() {
    const s = settings();
    const dist = distribution(PROMPTS[promptIdx].words, s);
    const bars = clear($("#bars"));
    const maxP = Math.max(...dist.map((d) => d.p));

    dist.forEach((d) => {
      let label = pct(d.p);
      if (d.cut === "top-k" || d.cut === "top-p") label = "cut";
      if (d.cut === "greedy") label = "never";
      bars.appendChild(barRow(d.word, d.p / (maxP || 1), label, d.cut ? "cut" : d.p === maxP ? "top" : null));
    });

    $("#temp-value").textContent = s.temp.toFixed(1);
    $("#topk-value").textContent = s.topk;
    $("#topp-value").textContent = s.topp.toFixed(2);

    ["row-temp", "row-topk", "row-topp"].forEach((id) => $("#" + id).classList.toggle("off", s.greedy));
    ["temp", "topk", "topp"].forEach((id) => { $("#" + id).disabled = s.greedy; });

    let hint;
    if (s.greedy) {
      hint = "Greedy: always takes the word with the highest chance. Same answer every time. Good for facts and code, but long texts can become boring or repetitive.";
    } else {
      const kept = dist.filter((d) => !d.cut).length;
      let tempText;
      if (s.temp <= 0.4) tempText = "Low temperature: the top word gets almost all the chance.";
      else if (s.temp <= 1.2) tempText = "Medium temperature: likely words, with some variety.";
      else tempText = "High temperature: chances are flattened, so strange words show up more.";
      hint = "Sampling: " + tempText + " Top-k and top-p leave " + kept + " of " + dist.length + " words in the dice.";
    }
    $("#dec-hint").textContent = hint;
  }

  function renderTally() {
    const box = clear($("#tally"));
    const keys = Object.keys(tally).sort((a, b) => tally[b] - tally[a]);
    if (!keys.length) {
      box.appendChild(el("span", "note", "Your picks will be counted here."));
      return;
    }
    keys.forEach((k) => {
      const c = el("span", "chip", k);
      c.appendChild(el("b", null, "x" + tally[k]));
      box.appendChild(c);
    });
  }

  function generate(n) {
    const dist = distribution(PROMPTS[promptIdx].words, settings());
    for (let i = 0; i < n; i++) {
      lastPick = sample(dist);
      tally[lastPick] = (tally[lastPick] || 0) + 1;
    }
    renderSentence();
    renderTally();
  }

  function clearPicks() {
    lastPick = null;
    tally = {};
    renderSentence();
    renderTally();
  }

  function onSettingsChange() {
    clearPicks();
    renderBars();
  }

  seg($("#dec-mode"), [{ value: "greedy", label: "Greedy" }, { value: "sampling", label: "Sampling" }], decMode, (v) => {
    decMode = v;
    onSettingsChange();
  });

  $("#prompt-select").addEventListener("change", function () {
    promptIdx = Number(this.value);
    onSettingsChange();
  });
  ["temp", "topk", "topp"].forEach((id) => $("#" + id).addEventListener("input", onSettingsChange));
  $("#gen-one").addEventListener("click", () => generate(1));
  $("#gen-twenty").addEventListener("click", () => generate(20));
  $("#gen-clear").addEventListener("click", clearPicks);

  renderBars();
  generate(1);

  // Mini language model: next-word table for whole sentences
  const LM = {
    "<start>": [["The", 2.5], ["A", 1.8], ["My", 1.2]],
    The: [["cat", 2.2], ["dog", 2.0], ["robot", 1.2]],
    A: [["cat", 1.8], ["dog", 1.9], ["robot", 1.5]],
    My: [["cat", 2.0], ["dog", 2.1], ["robot", 0.8]],
    cat: [["sat", 2.4], ["ran", 1.6], ["sang", 0.3]],
    dog: [["ran", 2.3], ["sat", 1.5], ["sang", 0.2]],
    robot: [["sang", 1.5], ["ran", 1.4], ["sat", 1.0]],
    sat: [["on", 2.6], ["quietly", 1.2], ["<end>", 0.8]],
    ran: [["away", 2.2], ["home", 1.9], ["<end>", 0.9]],
    sang: [["loudly", 2.0], ["softly", 1.6], ["<end>", 1.0]],
    on: [["the", 3.0], ["a", 1.0]],
    the: [["mat", 2.4], ["sofa", 1.7], ["moon", 0.4]],
    a: [["mat", 2.0], ["sofa", 1.8], ["moon", 0.6]]
  };

  function writeSentence() {
    const s = settings();
    const words = [];
    let current = "<start>";
    for (let i = 0; i < 8; i++) {
      const options = LM[current];
      if (!options) break;
      const next = sample(distribution(options, s));
      if (next === "<end>") break;
      words.push(next);
      current = next;
    }
    return words.join(" ") + ".";
  }

  $("#lm-write").addEventListener("click", () => {
    const list = $("#lm-out");
    for (let i = 0; i < 3; i++) list.appendChild(el("li", "appear", writeSentence()));
    while (list.children.length > 9) list.removeChild(list.firstChild);
  });
  $("#lm-clear").addEventListener("click", () => clear($("#lm-out")));
  $("#lm-write").click();
})();
