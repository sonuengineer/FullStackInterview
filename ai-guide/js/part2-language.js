/* Part 2: Human language */
(function () {
  const { $, el, clear, rich, seg, picks, tabs } = G;

  /* ====================================================== NLP pipeline */
  const NLP = [
    {
      text: "Sam booked a flight to Paris on Friday.",
      tokens: [["Sam", "name"], ["booked", "verb"], ["a", "article"], ["flight", "noun"], ["to", "preposition"], ["Paris", "name"], ["on", "preposition"], ["Friday", "name"], [".", "punctuation"]],
      entities: { 0: "person", 5: "place", 7: "date" },
      sentiment: { score: 0, label: "Neutral", why: "Only facts. No happy or unhappy words." },
      intent: { label: "Sharing information: a travel plan", slots: [["Who", "Sam"], ["Did what", "booked a flight"], ["Where to", "Paris"], ["When", "Friday"]] }
    },
    {
      text: "I love this phone but the battery is terrible.",
      tokens: [["I", "pronoun"], ["love", "verb"], ["this", "determiner"], ["phone", "noun"], ["but", "conjunction"], ["the", "article"], ["battery", "noun"], ["is", "verb"], ["terrible", "adjective"], [".", "punctuation"]],
      entities: {},
      sentiment: { score: -0.2, label: "Mixed, a bit negative", why: "\"love\" is positive (the phone). \"terrible\" is negative (the battery). The word \"but\" tells us the second part matters more." },
      intent: { label: "Product review with a complaint", slots: [["Likes", "the phone"], ["Problem", "the battery"]] }
    },
    {
      text: "Can you remind me to call Mom at 6?",
      tokens: [["Can", "helper verb"], ["you", "pronoun"], ["remind", "verb"], ["me", "pronoun"], ["to", "particle"], ["call", "verb"], ["Mom", "name"], ["at", "preposition"], ["6", "number"], ["?", "punctuation"]],
      entities: { 6: "person", 8: "time" },
      sentiment: { score: 0, label: "Neutral", why: "A polite request with no feeling words." },
      intent: { label: "Create a reminder", slots: [["Task", "call Mom"], ["Time", "6 o'clock, but am or pm? A good assistant asks."]] }
    }
  ];

  const NLP_STEPS = [
    { value: "tokens", label: "1. Tokens" },
    { value: "pos", label: "2. Word types" },
    { value: "entities", label: "3. Names, places, dates" },
    { value: "feeling", label: "4. Feeling" },
    { value: "intent", label: "5. Goal (intent)" }
  ];

  const STEP_TEXT = {
    tokens: "Cut the sentence into tokens (words and punctuation).",
    pos: "Label each word with its grammar type. This is called part-of-speech tagging.",
    entities: "Find names of people, places, dates and times. This is called named entity recognition.",
    feeling: "Decide if the text is positive, negative or neutral. This is called sentiment analysis.",
    intent: "Work out what the person wants, and pull out the details needed to act."
  };

  let nlpIndex = 0;
  let nlpStep = "tokens";

  function renderNlp() {
    const data = NLP[nlpIndex];
    const out = clear($("#nlp-output"));
    out.appendChild(el("p", "note", STEP_TEXT[nlpStep]));

    if (nlpStep === "tokens" || nlpStep === "pos" || nlpStep === "entities") {
      const row = el("div", "nlp-tokens");
      data.tokens.forEach(([word, pos], i) => {
        const tok = el("div", "nlp-tok");
        const entity = nlpStep === "entities" ? data.entities[i] : null;
        tok.appendChild(el("span", "w" + (entity ? " " + entity : ""), word));
        let tag = "";
        if (nlpStep === "tokens") tag = "#" + (i + 1);
        if (nlpStep === "pos") tag = pos;
        if (nlpStep === "entities") tag = entity || "";
        tok.appendChild(el("span", "tag", tag || " "));
        row.appendChild(tok);
      });
      out.appendChild(row);

      if (nlpStep === "entities" && Object.keys(data.entities).length === 0) {
        out.appendChild(el("p", null, "No names, places or dates in this sentence. (\"phone\" is a thing, but not a named one like \"Pixel 9\".)"));
      }
    }

    if (nlpStep === "feeling") {
      out.appendChild(el("p", "big-sentence", data.text));
      const senti = el("div", "senti");
      const track = el("div", "senti-track");
      track.appendChild(el("span"));
      track.appendChild(el("span"));
      track.appendChild(el("span"));
      const marker = el("i", "senti-marker");
      marker.style.left = ((data.sentiment.score + 1) / 2) * 100 + "%";
      track.appendChild(marker);
      senti.appendChild(track);
      const labels = el("div", "senti-labels");
      ["negative", "neutral", "positive"].forEach((l) => labels.appendChild(el("span", null, l)));
      senti.appendChild(labels);
      out.appendChild(senti);
      out.appendChild(rich("p", [["Result: ", null, "b"], data.sentiment.label + ". " + data.sentiment.why]));
    }

    if (nlpStep === "intent") {
      out.appendChild(el("p", "big-sentence", data.text));
      const card = el("div", "meaning-card");
      card.appendChild(el("span", "label", "Intent"));
      card.appendChild(el("strong", null, data.intent.label));
      out.appendChild(card);
      const table = el("table", "data-table");
      const body = el("tbody");
      data.intent.slots.forEach(([k, v]) => {
        const tr = el("tr");
        tr.appendChild(el("td", null, k));
        tr.appendChild(el("td", null, v));
        body.appendChild(tr);
      });
      table.appendChild(body);
      out.appendChild(table);
    }
  }

  picks($("#nlp-sentences"), NLP.map((n) => n.text), 0, (i) => {
    nlpIndex = i;
    renderNlp();
  });

  seg($("#nlp-steps"), NLP_STEPS, nlpStep, (value) => {
    nlpStep = value;
    renderNlp();
  });

  renderNlp();

  /* ====================================================== Why language is hard */

  function meaningCard(label, text) {
    const card = el("div", "meaning-card");
    card.appendChild(el("span", "label", label));
    card.appendChild(el("strong", null, text));
    return card;
  }

  // 1. Same word, many meanings
  const MEANINGS = {
    bank: [
      ["We sat on the river bank.", "the land next to a river"],
      ["I need to go to the bank to get cash.", "a place that keeps money"],
      ["You can bank on me.", "to trust or rely on someone"]
    ],
    light: [
      ["This bag is very light.", "not heavy"],
      ["Please turn on the light.", "a lamp"],
      ["She painted the room light blue.", "a pale color"]
    ],
    run: [
      ["I run every morning.", "to move fast on your feet"],
      ["Can you run this program?", "to start software"],
      ["She will run the company.", "to manage or lead"]
    ]
  };

  function buildMeanings(panel) {
    let word = "bank";
    const top = el("div", "row");
    top.appendChild(el("span", "note", "Word:"));
    const wordSeg = el("div");
    top.appendChild(wordSeg);
    panel.appendChild(top);

    const sentences = el("div", "picks");
    panel.appendChild(sentences);
    const result = el("div", "stack-v");
    panel.appendChild(result);
    panel.appendChild(el("p", "note", "An LLM picks the right meaning by looking at the nearby words (attention). \"river\" pulls \"bank\" toward land; \"cash\" pulls it toward money."));

    function show(i) {
      const [sentence, meaning] = MEANINGS[word][i];
      clear(result);
      const parts = sentence.split(new RegExp("\\b(" + word + ")\\b", "i"));
      const p = el("p", "big-sentence");
      parts.forEach((part) => {
        if (part.toLowerCase() === word) p.appendChild(el("span", "hl", part));
        else p.appendChild(document.createTextNode(part));
      });
      result.appendChild(p);
      result.appendChild(meaningCard("Here \"" + word + "\" means", meaning));
    }

    function setWord(w) {
      word = w;
      picks(sentences, MEANINGS[word].map((m) => m[0]), 0, show);
      show(0);
    }

    seg(wordSeg, Object.keys(MEANINGS).map((w) => ({ value: w, label: w })), word, setWord);
    setWord(word);
  }

  // 2. Word order
  const ONLY_POSITIONS = [
    [["Only", true], ["I"], ["told"], ["him"], ["the"], ["truth."]],
    [["I"], ["only", true], ["told"], ["him"], ["the"], ["truth."]],
    [["I"], ["told"], ["only", true], ["him"], ["the"], ["truth."]],
    [["I"], ["told"], ["him"], ["only", true], ["the"], ["truth."]]
  ];
  const ONLY_MEANINGS = [
    "Nobody else told him. Just me.",
    "I told him, but did nothing more (like helping).",
    "He is the one person I told.",
    "I told him nothing except the truth. No lies."
  ];

  function buildWordOrder(panel) {
    // Swap example
    const swapBox = el("div", "stack-v");
    let swapped = false;
    const tiles = el("div", "word-tiles");
    const swapMeaning = el("div");
    const swapBtn = el("button", "btn", "Swap the two nouns");
    swapBtn.type = "button";

    function renderSwap() {
      clear(tiles);
      const words = swapped ? ["The", "man", "bit", "the", "dog."] : ["The", "dog", "bit", "the", "man."];
      words.forEach((w, i) => tiles.appendChild(el("span", "word-tile" + (i === 1 || i === 4 ? " moving" : ""), w)));
      clear(swapMeaning).appendChild(meaningCard("Meaning", swapped ? "Very strange news! A man attacked a dog." : "Normal news. A dog attacked a man."));
    }

    swapBtn.addEventListener("click", () => {
      swapped = !swapped;
      renderSwap();
    });

    swapBox.appendChild(el("p", "note", "Same words, different order:"));
    swapBox.appendChild(tiles);
    swapBox.appendChild(swapBtn);
    swapBox.appendChild(swapMeaning);
    renderSwap();
    panel.appendChild(swapBox);

    // Moving "only"
    const onlyBox = el("div", "stack-v");
    let pos = 1;
    const onlyTiles = el("div", "word-tiles");
    const onlyMeaning = el("div");
    const controls = el("div", "row");
    const left = el("button", "btn", "< Move \"only\" left");
    const right = el("button", "btn", "Move \"only\" right >");
    left.type = "button";
    right.type = "button";
    controls.appendChild(left);
    controls.appendChild(right);

    function renderOnly() {
      clear(onlyTiles);
      ONLY_POSITIONS[pos].forEach(([w, moving]) => onlyTiles.appendChild(el("span", "word-tile" + (moving ? " moving" : ""), w)));
      clear(onlyMeaning).appendChild(meaningCard("Meaning", ONLY_MEANINGS[pos]));
      left.disabled = pos === 0;
      right.disabled = pos === ONLY_POSITIONS.length - 1;
    }

    left.addEventListener("click", () => { pos--; renderOnly(); });
    right.addEventListener("click", () => { pos++; renderOnly(); });

    onlyBox.appendChild(el("p", "note", "Move one small word and the meaning changes:"));
    onlyBox.appendChild(onlyTiles);
    onlyBox.appendChild(controls);
    onlyBox.appendChild(onlyMeaning);
    renderOnly();
    panel.appendChild(onlyBox);
  }

  // 3. Grammar and punctuation
  const COMMAS = [
    { without: "Let's eat grandma.", with: "Let's eat, grandma.", meaningWithout: "We are going to eat grandma! (Scary.)", meaningWith: "We are inviting grandma to come and eat." },
    { without: "I'm sorry I love you.", with: "I'm sorry, I love you.", meaningWithout: "I feel bad that I love you.", meaningWith: "I apologize, and I love you." },
    { without: "Woman without her man is nothing.", with: "Woman: without her, man is nothing.", meaningWithout: "A woman is nothing without a man.", meaningWith: "A man is nothing without a woman." }
  ];

  function buildGrammar(panel) {
    let index = 0;
    const examples = el("div", "picks");
    const toggleLabel = el("label", "toggle");
    const checkbox = el("input");
    checkbox.type = "checkbox";
    checkbox.id = "hard-comma";
    toggleLabel.htmlFor = "hard-comma";
    toggleLabel.appendChild(checkbox);
    toggleLabel.appendChild(document.createTextNode(" Add the punctuation"));
    const result = el("div", "stack-v");

    function render() {
      const ex = COMMAS[index];
      clear(result);
      result.appendChild(el("p", "big-sentence", checkbox.checked ? ex.with : ex.without));
      result.appendChild(meaningCard("Meaning", checkbox.checked ? ex.meaningWith : ex.meaningWithout));
    }

    picks(examples, COMMAS.map((c, i) => "Example " + (i + 1)), 0, (i) => {
      index = i;
      render();
    });
    checkbox.addEventListener("change", render);

    panel.appendChild(examples);
    panel.appendChild(toggleLabel);
    panel.appendChild(result);
    panel.appendChild(el("p", "note", "One comma or colon changes who does what. People often skip punctuation in chat, so the AI has to guess."));
    render();
  }

  // 4. Context (Winograd schema)
  function buildContext(panel) {
    let last = "big";
    const segBox = el("div");
    const result = el("div", "stack-v");

    function render() {
      clear(result);
      const p = el("p", "big-sentence");
      p.appendChild(document.createTextNode("The trophy did not fit in the suitcase because "));
      p.appendChild(el("span", "hl", "it"));
      p.appendChild(document.createTextNode(" was too "));
      p.appendChild(el("span", "hl", last));
      p.appendChild(document.createTextNode("."));
      result.appendChild(p);
      result.appendChild(meaningCard("\"it\" means", last === "big" ? "the trophy (a big trophy does not fit)" : "the suitcase (a small suitcase cannot hold it)"));
    }

    const row = el("div", "row");
    row.appendChild(el("span", "note", "Change one word:"));
    row.appendChild(segBox);
    panel.appendChild(row);
    panel.appendChild(result);
    panel.appendChild(el("p", "note", "The grammar is identical. Only knowledge about the world (big things do not fit into small things) tells you what \"it\" is. This kind of puzzle is used to test AI understanding."));

    seg(segBox, [{ value: "big", label: "too big" }, { value: "small", label: "too small" }], last, (v) => {
      last = v;
      render();
    });
    render();
  }

  // 5. Real intention
  const INTENTS = [
    ["Can you pass the salt?", "A question about your ability. The answer is yes or no.", "Please give me the salt."],
    ["Do you know what time it is?", "Asks whether you know the time. Answer: yes.", "Please tell me the time. (From an angry parent: you are late!)"],
    ["It's cold in here.", "A fact about the temperature.", "Please close the window or turn on the heater."],
    ["I have nothing to wear.", "The closet is empty.", "I do not like my clothes. I want to go shopping."]
  ];

  function buildIntent(panel) {
    let index = 0;
    let view = "literal";
    const examples = el("div", "picks");
    const segBox = el("div");
    const result = el("div", "stack-v");

    function render() {
      const [text, literal, real] = INTENTS[index];
      clear(result);
      result.appendChild(el("p", "big-sentence", "\"" + text + "\""));
      result.appendChild(meaningCard(view === "literal" ? "Word-for-word meaning" : "What the person really wants", view === "literal" ? literal : real));
    }

    picks(examples, INTENTS.map((x) => x[0]), 0, (i) => { index = i; render(); });
    panel.appendChild(examples);
    panel.appendChild(segBox);
    panel.appendChild(result);
    panel.appendChild(el("p", "note", "Answering \"Yes\" to \"Can you pass the salt?\" is correct word for word, but wrong as a human. Chat models are trained on examples so they respond to the real intention."));
    seg(segBox, [{ value: "literal", label: "Word for word" }, { value: "real", label: "Real intention" }], view, (v) => { view = v; render(); });
    render();
  }

  // 6. Culture
  const REGIONS = [
    { value: "us", label: "United States" },
    { value: "uk", label: "United Kingdom" },
    { value: "in", label: "India" }
  ];

  const CULTURE = [
    { phrase: "Please revert by Monday.", us: "Please change it back to the old version by Monday.", uk: "Please change it back to the old version by Monday.", in: "Please reply to me by Monday." },
    { phrase: "Can we prepone the meeting?", us: "Not a common word here. People may not understand.", uk: "Not a common word here. People may not understand.", in: "Can we move the meeting to an earlier time?" },
    { phrase: "Let's table this topic.", us: "Stop talking about it now. Discuss it later.", uk: "Put it on the agenda. Discuss it now.", in: "Can mean either, so ask to be sure." },
    { phrase: "I spilled coffee on my pants.", us: "Coffee on my trousers.", uk: "Coffee on my underwear!", in: "Coffee on my trousers." },
    { phrase: "Kindly do the needful.", us: "Sounds unusual. Not clear what exactly to do.", uk: "Sounds old-fashioned. Not clear what exactly to do.", in: "Please do what is necessary." }
  ];

  function buildCulture(panel) {
    let region = "in";
    const segBox = el("div");
    const table = el("table", "data-table");
    const head = el("thead");
    const headRow = el("tr");
    headRow.appendChild(el("th", null, "Phrase"));
    const meaningHead = el("th");
    headRow.appendChild(meaningHead);
    head.appendChild(headRow);
    table.appendChild(head);
    const body = el("tbody");
    table.appendChild(body);

    function render() {
      meaningHead.textContent = "What people in " + REGIONS.find((r) => r.value === region).label + " understand";
      clear(body);
      CULTURE.forEach((c) => {
        const tr = el("tr");
        tr.appendChild(el("td", null, c.phrase));
        tr.appendChild(el("td", null, c[region]));
        body.appendChild(tr);
      });
    }

    const row = el("div", "row");
    row.appendChild(el("span", "note", "Reader is from:"));
    row.appendChild(segBox);
    panel.appendChild(row);
    const scroll = el("div", "scroll-x");
    scroll.appendChild(table);
    panel.appendChild(scroll);
    panel.appendChild(el("p", "note", "The same English sentence can mean different things in different countries. If you tell the AI where you are or who the text is for, it can pick the right meaning."));
    seg(segBox, REGIONS, region, (v) => { region = v; render(); });
    render();
  }

  // 7. Tone
  const TONES = [
    { before: "I got the job!", reply: "Great. Just great.", tone: "Happy", tone_class: "good", why: "Good news came before, so \"great\" is sincere." },
    { before: "My phone just fell in the water.", reply: "Great. Just great.", tone: "Sarcastic, annoyed", tone_class: "bad", why: "Bad news came before, so \"great\" means the opposite." },
    { before: "You broke the printer again?", reply: "Nice job.", tone: "Sarcastic", tone_class: "bad", why: "Breaking a printer is not a good thing, so the praise is fake." },
    { before: "You finished the whole project in one day?", reply: "Nice job.", tone: "Real praise", tone_class: "good", why: "Finishing fast is impressive, so the praise is real." }
  ];

  function buildTone(panel) {
    let index = 1;
    const examples = el("div", "picks");
    const result = el("div", "stack-v");

    function render() {
      const t = TONES[index];
      clear(result);
      result.appendChild(rich("p", [["Before: ", "note"], "\"" + t.before + "\""]));
      result.appendChild(el("p", "big-sentence", "\"" + t.reply + "\""));
      const card = el("div", "meaning-card");
      card.appendChild(el("span", "label", "Tone"));
      card.appendChild(el("span", "pill " + t.tone_class, t.tone));
      card.appendChild(el("p", null, t.why));
      result.appendChild(card);
    }

    picks(examples, TONES.map((t) => t.before + " -> " + t.reply), index, (i) => { index = i; render(); });
    panel.appendChild(el("p", "note", "Writing has no voice or face. The same words can be happy or sarcastic. Pick what was said before:"));
    panel.appendChild(examples);
    panel.appendChild(result);
    render();
  }

  // 8. Earlier conversation
  const EARLIER = [
    { before: "I want to watch the movie Dune tonight.", it: "the movie Dune", good: true },
    { before: "I am thinking of buying a Pixel 9 phone.", it: "the Pixel 9 phone", good: true },
    { before: "(nothing, this is the first message)", it: "Unknown. A good AI should ask: \"What do you mean by 'it'?\"", good: false }
  ];

  function buildEarlier(panel) {
    let index = 0;
    const examples = el("div", "picks");
    const result = el("div", "stack-v");

    function render() {
      const e = EARLIER[index];
      clear(result);
      const log = el("div", "window");
      const m1 = el("div", "msg in");
      m1.appendChild(el("span", "who", "you"));
      m1.appendChild(el("span", "text", e.before));
      m1.appendChild(el("span", "tk", "earlier"));
      const m2 = el("div", "msg in");
      m2.appendChild(el("span", "who", "you"));
      m2.appendChild(el("span", "text", "Is it good?"));
      m2.appendChild(el("span", "tk", "now"));
      log.appendChild(m1);
      log.appendChild(m2);
      result.appendChild(log);
      const card = el("div", "meaning-card");
      card.appendChild(el("span", "label", "\"it\" means"));
      card.appendChild(el("strong", null, e.it));
      result.appendChild(card);
    }

    picks(examples, EARLIER.map((e) => e.before), 0, (i) => { index = i; render(); });
    panel.appendChild(el("p", "note", "\"Is it good?\" means nothing alone. Pick what was said earlier:"));
    panel.appendChild(examples);
    panel.appendChild(result);
    panel.appendChild(el("p", "note", "This is why chat apps send earlier messages again with every request (see Memory in Part 4)."));
    render();
  }

  tabs($("#hard-tabs"), $("#hard-panel"), [
    { label: "Many meanings", build: buildMeanings },
    { label: "Word order", build: buildWordOrder },
    { label: "Grammar", build: buildGrammar },
    { label: "Context", build: buildContext },
    { label: "Real intention", build: buildIntent },
    { label: "Culture", build: buildCulture },
    { label: "Tone", build: buildTone },
    { label: "Earlier chat", build: buildEarlier }
  ], 0);
})();
