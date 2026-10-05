/* Part 3 additions: How models learn, Multimodal AI */
(function () {
  const { $, el, svg, clear, rich, seg, picks } = G;

  /* ====================================================== Number helpers */
  function big(n) {
    if (n >= 1e12) return (n / 1e12).toFixed(1) + " trillion";
    if (n >= 1e9) return (n / 1e9).toFixed(1) + " billion";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + " million";
    if (n >= 1e4) return Math.round(n / 1e3) + " thousand";
    return Math.round(n).toLocaleString("en-US");
  }

  function sci(n) {
    const e = Math.floor(Math.log10(n));
    return (n / Math.pow(10, e)).toFixed(1) + " x 10^" + e;
  }

  /* ====================================================== How models learn */
  // [hours studied, test score]
  const DATA = [[1, 52], [2, 55], [3, 61], [4, 64], [5, 70], [6, 72], [7, 79], [8, 83]];
  const ORDER = [4, 0, 7, 2, 5, 1, 6, 3];
  const RATES = { slow: 0.03, good: 0.3, big: 1.6 };
  const START = { w: -0.4, b: 0.2 };

  let model;
  let history;
  let lastStep;
  let cursor;
  let seen;
  let exploded;
  let rateKey = "good";

  const guessScore = (x) => (model.w * (x / 8) + model.b) * 100;

  function avgError() {
    const sum = DATA.reduce((s, [x, y]) => s + Math.pow(guessScore(x) - y, 2), 0);
    return Math.sqrt(sum / DATA.length);
  }

  function resetTraining() {
    model = { ...START };
    history = [avgError()];
    lastStep = null;
    cursor = 0;
    seen = 0;
    exploded = false;
    renderLearn();
  }

  function trainOne() {
    if (exploded) return;
    const [x, y] = DATA[ORDER[cursor]];
    const xs = x / 8;
    const guess = model.w * xs + model.b;
    const error = guess - y / 100;
    const gradW = 2 * error * xs;
    const gradB = 2 * error;
    const rate = RATES[rateKey];
    const before = { ...model };

    model.w -= rate * gradW;
    model.b -= rate * gradB;

    lastStep = { x, y, guess: guess * 100, error: error * 100, before, after: { ...model }, gradW, gradB, rate };
    cursor = (cursor + 1) % DATA.length;
    seen++;

    const err = avgError();
    history.push(err);
    if (!isFinite(err) || err > 5000) exploded = true;
  }

  function train(n) {
    for (let i = 0; i < n && !exploded; i++) trainOne();
    renderLearn();
  }

  const FX = (x) => 44 + x * 36;
  const FY = (s) => 220 - s * 2;

  function drawFit() {
    const chart = clear($("#learn-fit"));
    const defs = svg("defs");
    const clip = svg("clipPath", { id: "learn-clip" });
    clip.appendChild(svg("rect", { x: FX(0), y: FY(100), width: FX(9) - FX(0), height: FY(0) - FY(100) }));
    defs.appendChild(clip);
    chart.appendChild(defs);

    [0, 25, 50, 75, 100].forEach((s) => {
      chart.appendChild(svg("line", { x1: FX(0), y1: FY(s), x2: FX(9), y2: FY(s), class: "gridline" }));
      const t = svg("text", { x: FX(0) - 6, y: FY(s) + 4, "text-anchor": "end", class: "axis-label" });
      t.textContent = s;
      chart.appendChild(t);
    });
    for (let x = 0; x <= 9; x++) {
      const t = svg("text", { x: FX(x), y: FY(0) + 16, "text-anchor": "middle", class: "axis-label" });
      t.textContent = x;
      chart.appendChild(t);
    }
    const xl = svg("text", { x: FX(4.5), y: 248, "text-anchor": "middle", class: "axis-label" });
    xl.textContent = "hours studied";
    chart.appendChild(xl);
    const yl = svg("text", { x: 12, y: FY(50), "text-anchor": "middle", class: "axis-label", transform: "rotate(-90 12 " + FY(50) + ")" });
    yl.textContent = "test score";
    chart.appendChild(yl);

    const lineGroup = svg("g", { "clip-path": "url(#learn-clip)" });
    if (!exploded) {
      lineGroup.appendChild(svg("line", { x1: FX(0), y1: FY(guessScore(0)), x2: FX(9), y2: FY(guessScore(9)), class: "fit-line" }));
      if (lastStep) {
        lineGroup.appendChild(svg("line", { x1: FX(lastStep.x), y1: FY(lastStep.y), x2: FX(lastStep.x), y2: FY(lastStep.guess), class: "err-line" }));
      }
    }
    chart.appendChild(lineGroup);

    DATA.forEach(([x, y]) => {
      const current = lastStep && lastStep.x === x;
      chart.appendChild(svg("circle", { cx: FX(x), cy: FY(y), r: current ? 7 : 5, class: current ? "data-pt current" : "data-pt" }));
    });
  }

  function drawLoss() {
    const chart = clear($("#learn-loss"));
    const cap = Math.max(20, Math.ceil(Math.min(history[0], 120) / 10) * 10);
    const steps = Math.max(8, history.length - 1);
    const LX = (i) => 44 + (i / steps) * 320;
    const LY = (v) => 220 - (Math.min(v, cap) / cap) * 200;

    [0, cap / 2, cap].forEach((v) => {
      chart.appendChild(svg("line", { x1: LX(0), y1: LY(v), x2: LX(steps), y2: LY(v), class: "gridline" }));
      const t = svg("text", { x: LX(0) - 6, y: LY(v) + 4, "text-anchor": "end", class: "axis-label" });
      t.textContent = Math.round(v);
      chart.appendChild(t);
    });

    const endLabel = svg("text", { x: LX(steps), y: LY(0) + 16, "text-anchor": "end", class: "axis-label" });
    endLabel.textContent = steps;
    chart.appendChild(endLabel);
    const startLabel = svg("text", { x: LX(0), y: LY(0) + 16, "text-anchor": "middle", class: "axis-label" });
    startLabel.textContent = "0";
    chart.appendChild(startLabel);
    const xl = svg("text", { x: LX(steps / 2), y: 248, "text-anchor": "middle", class: "axis-label" });
    xl.textContent = "examples seen";
    chart.appendChild(xl);
    const yl = svg("text", { x: 12, y: LY(cap / 2), "text-anchor": "middle", class: "axis-label", transform: "rotate(-90 12 " + LY(cap / 2) + ")" });
    yl.textContent = "average error (points)";
    chart.appendChild(yl);

    const points = history.map((v, i) => LX(i) + "," + LY(isFinite(v) ? v : cap)).join(" ");
    const area = LX(0) + "," + LY(0) + " " + points + " " + LX(history.length - 1) + "," + LY(0);
    chart.appendChild(svg("polygon", { points: area, class: "loss-area" }));
    chart.appendChild(svg("polyline", { points, class: "loss-line" }));
    const last = history[history.length - 1];
    chart.appendChild(svg("circle", { cx: LX(history.length - 1), cy: LY(isFinite(last) ? last : cap), r: 5, class: "loss-end" }));
  }

  function renderLearn() {
    drawFit();
    drawLoss();

    const err = history[history.length - 1];
    const stats = clear($("#learn-stats"));
    [
      [Math.floor(seen / DATA.length), "epochs (full passes)"],
      [seen, "examples seen"],
      [exploded ? "huge" : err.toFixed(1), "average error (points)"],
      [exploded ? "-" : (model.w * 100 / 8).toFixed(2), "learned: points per hour"],
      [exploded ? "-" : (model.b * 100).toFixed(1), "learned: starting score"]
    ].forEach(([value, label]) => {
      const s = el("div", "mini-stat");
      s.appendChild(el("b", null, String(value)));
      s.appendChild(el("span", null, label));
      stats.appendChild(s);
    });

    const steps = clear($("#learn-step"));
    if (!lastStep) {
      steps.appendChild(el("li", null, "Press a Train button. The line starts from random numbers, so its first guesses are very wrong."));
    } else if (exploded) {
      steps.appendChild(el("li", "bad", "The numbers blew up. Each step jumped so far past the right answer that the error grew instead of shrinking."));
    } else {
      const s = lastStep;
      [
        ["Guess (forward pass)", "Example: " + s.x + " hours studied. The model guessed " + s.guess.toFixed(0) + " points; the real score is " + s.y + "."],
        ["Loss (how wrong)", "Error = " + s.error.toFixed(1) + " points. Squared, it counts as " + Math.round(s.error * s.error) + ", so big mistakes matter much more than small ones."],
        ["Backpropagation", "Work out how much each number caused the error: slope " + s.gradW.toFixed(3) + ", start " + s.gradB.toFixed(3) + ". In a real model this is done for billions of numbers at once."],
        ["Update (gradient descent)", "Move each number a small step the other way, using learning rate " + s.rate + ". Points per hour: " + (s.before.w * 12.5).toFixed(2) + " -> " + (s.after.w * 12.5).toFixed(2) + "."]
      ].forEach(([title, text]) => steps.appendChild(rich("li", [[title + ": ", null, "b"], text])));
    }

    const status = $("#learn-status");
    status.className = "answer";
    if (exploded) {
      status.classList.add("bad");
      status.textContent = "Learning rate too big: the model overshoots every time and never learns. Press Reset and pick a smaller rate.";
    } else if (seen === 0) {
      status.textContent = "Not trained yet. Average error: " + err.toFixed(0) + " points.";
    } else if (err < 3) {
      status.classList.add("good");
      status.textContent = "Trained! The line now fits the data with an average error of " + err.toFixed(1) + " points. It learned the pattern from examples, nobody wrote the rule.";
    } else if (rateKey === "slow") {
      status.textContent = "Tiny steps: it is learning, but very slowly. Average error " + err.toFixed(1) + " points.";
    } else {
      status.textContent = "Still learning. Average error " + err.toFixed(1) + " points. Keep training.";
    }
  }

  $("#learn-one").addEventListener("click", () => train(1));
  $("#learn-epoch").addEventListener("click", () => train(DATA.length));
  $("#learn-ten").addEventListener("click", () => train(DATA.length * 10));
  $("#learn-reset").addEventListener("click", resetTraining);
  seg($("#learn-rate"), [
    { value: "slow", label: "Too small (0.03)" },
    { value: "good", label: "Good (0.3)" },
    { value: "big", label: "Too big (1.6)" }
  ], rateKey, (v) => {
    rateKey = v;
    resetTraining();
  });

  resetTraining();

  /* ---------- Training cost calculator ---------- */
  const GPU_STEPS = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 24576];
  const FLOPS_PER_GPU_SECOND = 3.5e14; // useful work of one modern data-center GPU, rough

  const COST_PRESETS = [
    { label: "Small: 2B parameters, 2T tokens", params: 2, tokens: 2, gpus: 3 },
    { label: "Medium: 70B parameters, 15T tokens", params: 70, tokens: 15, gpus: 7 },
    { label: "Very large: 405B parameters, 15T tokens", params: 405, tokens: 15, gpus: 9 }
  ];

  function renderCost() {
    const params = Number($("#cost-params").value);
    const tokens = Number($("#cost-tokens").value);
    const gpus = GPU_STEPS[Number($("#cost-gpus").value)];
    const price = Number($("#cost-price").value);

    $("#cost-params-val").textContent = params + "B";
    $("#cost-tokens-val").textContent = tokens.toFixed(1) + "T";
    $("#cost-gpus-val").textContent = gpus.toLocaleString("en-US");
    $("#cost-price-val").textContent = "$" + price.toFixed(2);

    const flops = 6 * params * 1e9 * tokens * 1e12;
    const gpuHours = flops / FLOPS_PER_GPU_SECOND / 3600;
    const days = gpuHours / gpus / 24;
    const cost = gpuHours * price;

    const out = clear($("#cost-out"));
    [
      [sci(flops), "calculations (6 x parameters x tokens)"],
      [big(gpuHours), "GPU-hours"],
      [days < 1 ? "< 1" : big(days), "days on " + gpus.toLocaleString("en-US") + " GPUs"],
      ["$" + big(cost), "to rent the GPUs, for one training run"]
    ].forEach(([value, label]) => {
      const k = el("div", "kpi");
      k.appendChild(el("b", null, value));
      k.appendChild(el("span", null, label));
      out.appendChild(k);
    });
  }

  function applyPreset(i) {
    const p = COST_PRESETS[i];
    $("#cost-params").value = p.params;
    $("#cost-tokens").value = p.tokens;
    $("#cost-gpus").value = p.gpus;
    renderCost();
  }

  ["cost-params", "cost-tokens", "cost-gpus", "cost-price"].forEach((id) => $("#" + id).addEventListener("input", renderCost));
  picks($("#cost-presets"), COST_PRESETS.map((p) => p.label), 1, applyPreset);
  applyPreset(1);

  /* ====================================================== Multimodal */
  const IMAGE_TOKENS = 258;
  const AUDIO_TOKENS_PER_SECOND = 32;

  function pipeline(steps) {
    const row = el("div", "pipeline");
    steps.forEach(([title, text], i) => {
      const step = el("div", "pipe");
      step.appendChild(el("b", null, (i + 1) + ". " + title));
      step.appendChild(el("span", null, text));
      row.appendChild(step);
    });
    return row;
  }

  function kpiRow(items) {
    const row = el("div", "kpis");
    items.forEach(([value, label, tone]) => {
      const k = el("div", "kpi" + (tone ? " " + tone : ""));
      k.appendChild(el("b", null, value));
      k.appendChild(el("span", null, label));
      row.appendChild(k);
    });
    return row;
  }

  function sliderRow(id, label, min, max, step, value) {
    const row = el("div", "slider-row");
    const lab = el("label", null, label);
    lab.htmlFor = id;
    const input = el("input");
    input.type = "range";
    input.id = id;
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = value;
    const val = el("span", "val");
    row.appendChild(lab);
    row.appendChild(input);
    row.appendChild(val);
    return { row, input, val };
  }

  function examples(rows) {
    const scroll = el("div", "scroll-x");
    const table = el("table", "data-table");
    table.innerHTML = "<thead><tr><th>Use</th><th>Examples</th></tr></thead>";
    const body = el("tbody");
    rows.forEach(([use, ex]) => {
      const tr = el("tr");
      tr.appendChild(el("td", null, use));
      tr.appendChild(el("td", null, ex));
      body.appendChild(tr);
    });
    table.appendChild(body);
    scroll.appendChild(table);
    return scroll;
  }

  function buildText(view) {
    view.appendChild(pipeline([
      ["Text", "your words"],
      ["Tokenizer", "cut into tokens"],
      ["Token IDs", "a number per token"],
      ["Embeddings", "a vector per token"],
      ["Transformer", "reads all vectors"]
    ]));
    const chips = el("div", "token-box");
    ["A", " cat", " sleeping", " on", " a", " red", " sofa"].forEach((t, i) => chips.appendChild(el("span", "token c" + (i % 5), t)));
    view.appendChild(chips);
    view.appendChild(el("p", null, "Text is the starting point: 7 tokens here. Every other type below is converted into the same kind of vectors, so one transformer can read text, pictures and sound together."));
  }

  function drawScene(parent, size, patch) {
    const S = 240;
    const cells = 24;
    const c = S / cells;
    const pic = svg("svg", { viewBox: "0 0 " + S + " " + S, class: "scene", role: "img", "aria-label": "Simple picture of a house under the sun, with patch grid" });

    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        let cls = "px-sky";
        if (y >= 17) cls = "px-grass";
        if (Math.hypot(x - 18, y - 5) < 3) cls = "px-sun";
        if (x >= 5 && x <= 13 && y >= 11 && y <= 16) cls = "px-house";
        if (y >= 7 && y <= 10 && x >= 5 + (10 - y) && x <= 13 - (10 - y)) cls = "px-roof";
        if (x >= 8 && x <= 10 && y >= 13 && y <= 16) cls = "px-door";
        pic.appendChild(svg("rect", { x: x * c, y: y * c, width: c + 0.3, height: c + 0.3, class: cls }));
      }
    }

    const perSide = size / patch;
    const step = S / perSide;
    for (let i = 1; i < perSide; i++) {
      pic.appendChild(svg("line", { x1: i * step, y1: 0, x2: i * step, y2: S, class: "patch-line" }));
      pic.appendChild(svg("line", { x1: 0, y1: i * step, x2: S, y2: i * step, class: "patch-line" }));
    }
    parent.appendChild(pic);
  }

  function buildImage(view) {
    let size = 224;
    let patch = 16;

    view.appendChild(pipeline([
      ["Image", "a grid of pixels"],
      ["Cut into patches", "small squares, like tiles"],
      ["Vision encoder", "each patch becomes a vector"],
      ["Image tokens", "join the text tokens"],
      ["Transformer", "reads image and text together"]
    ]));

    const layout = el("div", "mm-layout");
    const picBox = el("div", "mm-visual");
    const side = el("div", "stack-v");
    layout.appendChild(picBox);
    layout.appendChild(side);
    view.appendChild(layout);

    const sizeRow = el("div", "row");
    sizeRow.appendChild(el("span", "note", "Image size (pixels):"));
    const sizeSeg = el("div");
    sizeRow.appendChild(sizeSeg);
    const patchRow = el("div", "row");
    patchRow.appendChild(el("span", "note", "Patch size:"));
    const patchSeg = el("div");
    patchRow.appendChild(patchSeg);
    const out = el("div", "stack-v");
    side.appendChild(sizeRow);
    side.appendChild(patchRow);
    side.appendChild(out);

    function render() {
      clear(picBox);
      drawScene(picBox, size, patch);
      const perSide = Math.floor(size / patch);
      clear(out);
      out.appendChild(kpiRow([
        [perSide + " x " + perSide, "patches (" + size + " / " + patch + " per side)"],
        [(perSide * perSide).toLocaleString("en-US"), "image tokens"]
      ]));
      out.appendChild(el("p", null, "Bigger images or smaller patches mean more detail, but more tokens, so more cost and slower answers. Many apps shrink or tile big images first."));
    }

    seg(sizeSeg, [224, 448, 896].map((v) => ({ value: v, label: v + " x " + v })), size, (v) => { size = Number(v); render(); });
    seg(patchSeg, [14, 16, 32].map((v) => ({ value: v, label: v + " px" })), patch, (v) => { patch = Number(v); render(); });
    render();

    view.appendChild(examples([
      ["Describe or answer questions about photos", "Gemini, Claude, GPT-4o; open: Gemma 3, Llama 3.2 Vision"],
      ["Read text in images (OCR), charts, screenshots", "Same vision models, or tools like Google Cloud Vision"],
      ["Create images (the reverse direction)", "Imagen, Midjourney, DALL-E"]
    ]));
  }

  function buildAudio(view) {
    view.appendChild(pipeline([
      ["Sound wave", "air pressure over time"],
      ["Spectrogram", "a picture of pitch over time"],
      ["Time slices", "each short slice becomes a vector"],
      ["Audio tokens", "join the text tokens"],
      ["Transformer", "understands words, tone, sounds"]
    ]));

    const layout = el("div", "mm-layout");
    const visual = el("div", "mm-visual stack-v");
    const side = el("div", "stack-v");
    layout.appendChild(visual);
    layout.appendChild(side);
    view.appendChild(layout);

    const wave = svg("svg", { viewBox: "0 0 320 70", class: "chart wave", role: "img", "aria-label": "Sound wave" });
    let d = "M 0 35";
    for (let x = 0; x <= 320; x += 2) {
      const amp = 22 * Math.abs(Math.sin(x / 45)) + 4;
      d += " L " + x + " " + (35 + amp * Math.sin(x / 3.1) * Math.cos(x / 11)).toFixed(1);
    }
    wave.appendChild(svg("path", { d, class: "wave-line" }));
    visual.appendChild(el("span", "box-label", "Sound wave"));
    visual.appendChild(wave);

    const cols = 40;
    const rows = 12;
    const spec = svg("svg", { viewBox: "0 0 320 110", class: "chart", role: "img", "aria-label": "Spectrogram" });
    for (let t = 0; t < cols; t++) {
      for (let f = 0; f < rows; f++) {
        const v = Math.abs(Math.sin(t * 0.7 + f * 1.3) * Math.cos(t * 0.23 - f * 0.5)) * (1 - (f / rows) * 0.6) * (0.3 + 0.7 * Math.abs(Math.sin(t / 7)));
        spec.appendChild(svg("rect", { x: t * 8, y: (rows - 1 - f) * 9, width: 7.4, height: 8.4, class: "spec-cell", opacity: (0.08 + v * 0.92).toFixed(2) }));
      }
    }
    for (let t = 8; t < cols; t += 8) spec.appendChild(svg("line", { x1: t * 8 - 0.4, y1: 0, x2: t * 8 - 0.4, y2: 108, class: "patch-line strong" }));
    visual.appendChild(el("span", "box-label", "Spectrogram (low pitch at the bottom; dashed lines = time slices)"));
    visual.appendChild(spec);

    const slider = sliderRow("mm-audio-sec", "Length", 1, 600, 1, 60);
    const out = el("div", "stack-v");
    side.appendChild(slider.row);
    side.appendChild(out);

    function render() {
      const sec = Number(slider.input.value);
      slider.val.textContent = sec >= 60 ? (sec / 60).toFixed(1) + "m" : sec + "s";
      clear(out);
      out.appendChild(kpiRow([
        [(sec * AUDIO_TOKENS_PER_SECOND).toLocaleString("en-US"), "audio tokens (32 per second)"],
        [(sec / 60 * 150).toFixed(0), "spoken words, if it was speech"]
      ]));
      out.appendChild(el("p", null, "Two ways apps use audio: turn speech into text first (speech-to-text), or give the audio tokens straight to the model so it also hears tone, music and background sounds."));
    }

    slider.input.addEventListener("input", render);
    render();

    view.appendChild(examples([
      ["Speech-to-text (transcripts, subtitles)", "Whisper (open), Google Chirp, Deepgram"],
      ["Text-to-speech (reading aloud)", "Google Text-to-Speech, ElevenLabs"],
      ["Talk with an AI in real time", "Gemini Live, ChatGPT voice mode"]
    ]));
  }

  function buildPdf(view) {
    let kind = "digital";
    let method = "both";

    view.appendChild(pipeline([
      ["PDF", "pages of text, tables, charts"],
      ["Extract text", "the text layer becomes text tokens"],
      ["Page images", "each page as a picture, image tokens"],
      ["Combine", "text + what the page looks like"],
      ["Transformer", "answers questions about the file"]
    ]));

    const layout = el("div", "mm-layout");
    const visual = el("div", "mm-visual");
    const side = el("div", "stack-v");
    layout.appendChild(visual);
    layout.appendChild(side);
    view.appendChild(layout);

    const kindRow = el("div", "row");
    kindRow.appendChild(el("span", "note", "PDF type:"));
    const kindSeg = el("div");
    kindRow.appendChild(kindSeg);
    const methodRow = el("div", "row");
    methodRow.appendChild(el("span", "note", "Method:"));
    const methodSeg = el("div");
    methodRow.appendChild(methodSeg);
    const pages = sliderRow("mm-pdf-pages", "Pages", 1, 300, 1, 20);
    const out = el("div", "stack-v");
    side.appendChild(kindRow);
    side.appendChild(methodRow);
    side.appendChild(pages.row);
    side.appendChild(out);

    function drawPage() {
      clear(visual);
      const page = el("div", "pdf-page" + (method !== "text" ? " as-image" : ""));
      const scanned = kind === "scanned";
      const textRead = method !== "image" && !scanned;
      const layoutRead = method !== "text";

      const title = el("div", "pdf-line title" + (textRead ? " read" : ""));
      page.appendChild(title);
      for (let i = 0; i < 4; i++) page.appendChild(el("div", "pdf-line" + (textRead ? " read" : "")));
      const chart = el("div", "pdf-chart" + (layoutRead ? " read" : " lost"));
      [40, 70, 55, 90].forEach((h) => {
        const bar = el("i");
        bar.style.height = h + "%";
        chart.appendChild(bar);
      });
      page.appendChild(chart);
      for (let i = 0; i < 3; i++) page.appendChild(el("div", "pdf-line" + (textRead ? " read" : "")));
      visual.appendChild(page);

      const legend = el("p", "note");
      legend.textContent = (textRead ? "Green lines = text read. " : scanned && method === "text" ? "No text layer: nothing to extract. " : "") +
        (layoutRead ? "Chart and layout seen as a picture." : "Chart is lost (text extraction cannot see pictures).");
      visual.appendChild(legend);
    }

    function render() {
      const n = Number(pages.input.value);
      pages.val.textContent = n;
      const textTokens = kind === "scanned" ? 0 : 500;
      const imageTokens = 258;
      let perPage = 0;
      if (method === "text") perPage = textTokens;
      if (method === "image") perPage = imageTokens;
      if (method === "both") perPage = textTokens + imageTokens;

      drawPage();
      clear(out);
      out.appendChild(kpiRow([
        [perPage.toLocaleString("en-US"), "tokens per page"],
        [(perPage * n).toLocaleString("en-US"), "tokens for " + n + " pages", perPage * n > 128000 ? "warn" : null]
      ]));

      if (kind === "scanned" && method === "text") {
        out.appendChild(el("div", "answer bad", "0 tokens: a scanned PDF is only pictures of pages. Text extraction finds nothing. Use page images (the model reads them like OCR)."));
      } else if (method === "text") {
        out.appendChild(el("div", "answer", "Cheapest, but tables lose their shape and charts disappear."));
      } else if (method === "image") {
        out.appendChild(el("div", "answer", "Sees layout, tables, charts and handwriting. Exact small text can be misread."));
      } else {
        out.appendChild(el("div", "answer good", "Best quality: exact text plus the look of each page. Most tokens."));
      }
      if (perPage * n > 128000) out.appendChild(el("p", "note", "This is more than a 128,000-token context window. For big files, apps use RAG: split into chunks and send only the relevant parts (see Part 5)."));
    }

    seg(kindSeg, [{ value: "digital", label: "Digital (has text)" }, { value: "scanned", label: "Scanned (pictures)" }], kind, (v) => { kind = v; render(); });
    seg(methodSeg, [{ value: "text", label: "Extract text" }, { value: "image", label: "Page images" }, { value: "both", label: "Both" }], method, (v) => { method = v; render(); });
    pages.input.addEventListener("input", render);
    render();

    view.appendChild(examples([
      ["Chat with a long report or contract", "Gemini, Claude and ChatGPT accept PDF uploads"],
      ["Pull data out of invoices and forms", "Document AI tools, or a vision model with a JSON output format"],
      ["Search thousands of PDFs", "RAG: chunk, embed, search (see RAG in detail)"]
    ]));
  }

  function buildVideo(view) {
    let fps = 1;

    view.appendChild(pipeline([
      ["Video", "many pictures per second + sound"],
      ["Sample frames", "e.g. 1 picture per second"],
      ["Frame tokens", "each frame is an image"],
      ["Audio tokens", "the soundtrack"],
      ["Transformer", "reads them in time order"]
    ]));

    const minutes = sliderRow("mm-video-min", "Length", 1, 120, 1, 10);
    const strip = el("div", "film");
    const out = el("div", "stack-v");
    const fpsRow = el("div", "row");
    fpsRow.appendChild(el("span", "note", "Frames taken per second:"));
    const fpsSeg = el("div");
    fpsRow.appendChild(fpsSeg);

    view.appendChild(fpsRow);
    view.appendChild(minutes.row);
    view.appendChild(strip);
    view.appendChild(out);

    function render() {
      const m = Number(minutes.input.value);
      minutes.val.textContent = m + "m";
      const seconds = m * 60;
      const frames = Math.round(seconds * fps);
      const tokens = frames * IMAGE_TOKENS + seconds * AUDIO_TOKENS_PER_SECOND;

      clear(strip);
      const frameRow = el("div", "film-frames");
      const shown = Math.min(frames, 16);
      for (let i = 0; i < shown; i++) frameRow.appendChild(el("i"));
      if (frames > shown) frameRow.appendChild(el("span", "note", "+ " + (frames - shown).toLocaleString("en-US") + " more frames"));
      strip.appendChild(frameRow);
      strip.appendChild(el("div", "film-audio"));

      clear(out);
      out.appendChild(kpiRow([
        [frames.toLocaleString("en-US"), "frames x 258 tokens"],
        [(seconds * AUDIO_TOKENS_PER_SECOND).toLocaleString("en-US"), "audio tokens"],
        [tokens.toLocaleString("en-US"), "total tokens", tokens > 1e6 ? "bad" : tokens > 128000 ? "warn" : null]
      ]));

      const meter = el("div", "meter");
      const top = el("div", "meter-top");
      top.appendChild(el("span", null, "Share of a 1,000,000-token context window"));
      top.appendChild(el("span", null, Math.round((tokens / 1e6) * 100) + "%"));
      const track = el("div", "meter-track");
      const fill = el("div", "meter-fill" + (tokens > 1e6 ? " full" : ""));
      fill.style.width = Math.min(100, (tokens / 1e6) * 100) + "%";
      track.appendChild(fill);
      meter.appendChild(top);
      meter.appendChild(track);
      out.appendChild(meter);
      out.appendChild(el("p", null, tokens > 1e6
        ? "Too long for one request. Apps cut long videos into parts, or take fewer frames."
        : "Taking fewer frames saves tokens, but fast action between frames can be missed."));
    }

    seg(fpsSeg, [{ value: 1, label: "1" }, { value: 2, label: "2" }], fps, (v) => { fps = Number(v); render(); });
    minutes.input.addEventListener("input", render);
    render();

    view.appendChild(examples([
      ["Summarize meetings or lectures", "Gemini (video input), or speech-to-text + an LLM"],
      ["Find a moment (\"when does the goal happen?\")", "Gemini, video search tools"],
      ["Create video (the reverse direction)", "Veo, Sora"]
    ]));
  }

  const MODES = {
    text: { label: "Text", build: buildText },
    image: { label: "Image", build: buildImage },
    audio: { label: "Audio", build: buildAudio },
    pdf: { label: "PDF", build: buildPdf },
    video: { label: "Video", build: buildVideo }
  };

  function renderMode(key) {
    const view = clear($("#mm-view"));
    MODES[key].build(view);
  }

  seg($("#mm-modes"), Object.keys(MODES).map((k) => ({ value: k, label: MODES[k].label })), "image", renderMode);
  renderMode("image");
})();
