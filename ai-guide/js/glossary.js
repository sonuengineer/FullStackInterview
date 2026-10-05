/* Part 5: Words to know */
(function () {
  const { $, el, clear, seg } = G;

  const CATEGORIES = [
    { value: "all", label: "All" },
    { value: "kinds", label: "Kinds of AI" },
    { value: "language", label: "Language" },
    { value: "model", label: "Inside the model" },
    { value: "apps", label: "Real apps" },
    { value: "trust", label: "Trust and safety" }
  ];

  const LABEL = { kinds: "Kinds of AI", language: "Language", model: "Inside the model", apps: "Real apps", trust: "Trust and safety" };

  const TERMS = [
    // Kinds of AI
    ["AI", "kinds", "Artificial Intelligence. Computer programs that do things that look smart."],
    ["Rule-based chatbot", "kinds", "A bot that replies using if-then keyword rules written by people. It does not learn or understand."],
    ["Machine learning (ML)", "kinds", "AI that learns patterns from examples instead of following written rules."],
    ["Algorithm", "kinds", "A step-by-step method. In ML, the method used to learn from data, like a decision tree."],
    ["Supervised learning", "kinds", "Learning from examples that include the right answer."],
    ["Unsupervised learning", "kinds", "Finding groups or patterns in data without any answers given."],
    ["Reinforcement learning", "kinds", "Learning by trying actions and getting rewards or penalties."],
    ["Deep learning", "kinds", "Machine learning with big neural networks that have many layers."],
    ["Neural network", "kinds", "Layers of simple math units connected together, loosely inspired by brain cells."],
    ["Narrow AI", "kinds", "AI built for one specific task, like a spam filter or chess engine."],
    ["General-purpose AI", "kinds", "One model that can do many different tasks, like an LLM."],
    ["AGI", "kinds", "Artificial General Intelligence. AI as capable as a human at any thinking task. Not reached yet."],
    ["Generative AI", "kinds", "AI that creates new content: text, images, audio, video or code."],
    ["LLM", "kinds", "Large Language Model. A huge model trained on text to predict the next token."],
    ["Base model / raw LLM", "kinds", "An LLM straight after pre-training. It continues text but does not follow instructions well."],
    ["Chat model", "kinds", "A base model with extra training so it follows instructions and answers helpfully."],
    ["Instruction tuning (SFT)", "kinds", "Training a base model on example conversations so it learns to answer."],
    ["RLHF", "kinds", "Reinforcement Learning from Human Feedback. People rank answers and the model learns to prefer the better ones."],
    ["AI agent", "kinds", "An LLM that works in a loop: think, use a tool, check the result, repeat until the task is done."],
    ["Agentic AI", "kinds", "AI systems that plan and act on their own toward goals, often with several agents working together."],
    ["Multimodal", "kinds", "A model that understands more than text: images, audio, video or files."],
    ["Open-weight model", "kinds", "A model whose numbers you can download and run yourself, like Llama or Gemma."],

    // Language
    ["NLP", "language", "Natural Language Processing. The part of AI that works with human language."],
    ["Part-of-speech tagging", "language", "Labeling each word as noun, verb, adjective and so on."],
    ["Named entity recognition", "language", "Finding names of people, places, dates and organizations in text."],
    ["Sentiment analysis", "language", "Deciding if text is positive, negative or neutral."],
    ["Intent", "language", "What the person really wants, like \"create a reminder\" or \"book a table\"."],
    ["Ambiguity", "language", "When words or sentences can mean more than one thing."],
    ["Context", "language", "Everything around a sentence that helps explain its meaning: nearby words, earlier messages, the situation."],

    // Inside the model
    ["Token", "model", "A small piece of text, about 4 letters of English. AI reads, writes and charges in tokens."],
    ["Tokenizer", "model", "The tool that cuts text into tokens and turns them into ID numbers."],
    ["Vocabulary", "model", "The full list of tokens a model knows, often 30,000 to over 250,000."],
    ["BPE", "model", "Byte Pair Encoding. Builds a tokenizer by gluing the most common pair of pieces again and again."],
    ["Embedding", "model", "A list of numbers that holds the meaning of a token or text. Similar meaning = similar numbers."],
    ["Parameters (weights)", "model", "The billions of numbers inside a model, set during training."],
    ["RNN", "model", "Recurrent Neural Network. Reads words one at a time with a small memory. Older design."],
    ["LSTM", "model", "Long Short-Term Memory. An improved RNN with better memory, still one word at a time."],
    ["Transformer", "model", "The model design used by today's LLMs. Reads all tokens at once using attention."],
    ["Attention", "model", "How each token decides which other tokens matter, and takes information from them."],
    ["Query, Key, Value", "model", "The three number lists each token makes for attention: what I look for, what I contain, what I give."],
    ["Attention head", "model", "One attention calculation. Models run many heads side by side, each noticing different things."],
    ["Softmax", "model", "Math that turns a list of scores into chances that add up to 100%."],
    ["Layer", "model", "One block of attention plus a feed-forward network. Big models stack dozens."],
    ["Training", "model", "The expensive learning phase where the model's numbers are adjusted using huge amounts of data."],
    ["Inference", "model", "Using a trained model to get an answer. Happens every time you send a message."],
    ["Greedy decoding", "model", "Always picking the most likely next token. Same output every time."],
    ["Sampling", "model", "Picking the next token randomly, weighted by the chances."],
    ["Temperature", "model", "A setting that makes chances sharper (low) or flatter (high). Low = safe, high = creative. Some newer models do not accept it and manage sampling themselves."],
    ["Top-k", "model", "Only the k most likely tokens can be picked."],
    ["Top-p", "model", "Only the most likely tokens whose chances add up to p (like 90%) can be picked."],
    ["Streaming", "model", "Sending the answer token by token as it is created, so you see it being typed."],
    ["Weights", "model", "The numbers inside a model that training adjusts. Another word for parameters."],
    ["Loss", "model", "A number that says how wrong the model's guesses are. Training tries to make it smaller."],
    ["Backpropagation", "model", "Working backwards from the error to find how much each weight caused it."],
    ["Gradient descent", "model", "Nudging every weight a small step in the direction that lowers the loss."],
    ["Learning rate", "model", "How big each training nudge is. Too small is slow; too big makes training blow up."],
    ["Epoch", "model", "One full pass through all the training data."],
    ["Overfitting", "model", "When a model memorizes its training examples and does badly on new ones."],
    ["Test data", "model", "Examples kept aside and never trained on, used to check what the model really learned."],
    ["GPU", "model", "A chip that does thousands of calculations at the same time. Used to train and run AI models."],
    ["Encoder", "model", "The part that turns an input (text, image, audio) into vectors the model can read."],
    ["Image patches", "model", "Small squares an image is cut into. Each patch becomes one image token."],
    ["Spectrogram", "model", "A picture of sound: which pitches are loud at each moment."],
    ["OCR", "model", "Optical Character Recognition. Reading text from a picture, like a scanned page."],

    // Real apps
    ["Prompt", "apps", "The text you send to the AI: your question plus any instructions."],
    ["System prompt", "apps", "Hidden instructions from the app, sent before your message, like \"You are a helpful teacher\"."],
    ["Context window", "apps", "The maximum number of tokens a model can read at once."],
    ["Conversation summary", "apps", "A short version of older messages, sent instead of the full text to save tokens."],
    ["Token budget", "apps", "Your own limit on how many tokens one request may use, to control cost and speed."],
    ["Compaction", "apps", "Shrinking the context (folding old messages into the summary) when it goes over the budget."],
    ["Tool / function calling", "apps", "The AI asks your code to run a function, like get_weather, and uses the result."],
    ["Fine-tuning", "apps", "Extra training on your own examples to change a model's style or skills."],
    ["Knowledge cutoff", "apps", "The date the training data ends. The model does not know what happened after."],
    ["Frontend / backend", "apps", "Frontend is what runs in the user's browser (React). Backend is your server (Express) that holds keys and calls the AI."],
    ["Fallback", "apps", "A backup plan when something fails, like a smaller model or a clear error message."],
    ["Small vs large model", "apps", "Small models are fast and cheap; large models are smarter but slower and cost more."],
    ["Local model", "apps", "A model that runs on your own computer or servers, so data stays with you."],
    ["Closed model", "apps", "A model you can only use through the company's API, like Gemini or Claude."],
    ["Quantization", "apps", "Storing a model's numbers with fewer bits so it needs less memory."],
    ["API", "apps", "A way for your code to talk to another service, like an AI model, over the internet."],
    ["API key", "apps", "A secret password that lets your app use an AI service. Keep it on the server only."],
    ["Rate limit", "apps", "A cap on how many requests can be sent per minute."],
    ["Library", "apps", "Ready-made code you call when you need it."],
    ["Framework", "apps", "A ready-made app structure that calls your code. Examples: Next.js, Express, LangChain."],
    ["Deploy", "apps", "Putting your app on a server so real users can reach it on the internet."],
    ["Localhost", "apps", "Your own computer acting as a server. Only you can open it."],
    ["FDE", "apps", "Forward Deployed Engineer. An engineer who works with a customer's team to make the AI product solve their real problem."],

    // Trust and safety
    ["Hallucination", "trust", "When the AI confidently says something false or made up."],
    ["Grounding", "trust", "Making the AI answer from real sources (search results or your documents) instead of memory."],
    ["Citation", "trust", "A marker like [1] showing which source a fact came from, so people can check it."],
    ["RAG", "trust", "Retrieval-Augmented Generation. Search your documents first and give the found parts to the AI."],
    ["Chunking", "trust", "Splitting documents into small pieces so the best pieces can be found and sent to the AI."],
    ["Vector search", "trust", "Finding the chunks whose embeddings are closest to the question's embedding."],
    ["Vector database", "trust", "A database that stores embeddings and finds text by meaning."],
    ["Top-k (retrieval)", "trust", "How many of the best-matching chunks are put into the prompt."],
    ["Prompt building blocks", "trust", "Role, context, constraints, examples and output format: the parts of a clear prompt."],
    ["Guardrails", "trust", "Limits and checks around an AI: step limits, budgets, approvals, allowed tools."],
    ["Workflow", "trust", "Fixed steps written in code, where AI does small parts. More predictable than an agent."],
    ["Idempotency key", "trust", "A unique label that stops the same action (like a refund) from running twice."],
    ["Backoff", "trust", "Waiting longer between retries instead of retrying instantly, so you don't overload a service."],
    ["Human in the loop", "trust", "A person approves important AI actions before they happen."],
    ["Prompt injection", "trust", "Hidden instructions inside content the AI reads, trying to make it misbehave."],
    ["Data leakage", "trust", "Private information shown to someone who should not see it."],
    ["Least privilege", "trust", "Giving an AI or app only the permissions it really needs, nothing more."],
    ["Test set (eval set)", "trust", "Real questions with known good answers, used to measure an AI app."],
    ["Accuracy", "trust", "The share of answers that are correct."],
    ["Hallucination rate", "trust", "The share of answers that state something false as fact."],
    ["Latency", "trust", "How long the user waits for an answer."],
    ["Cost per request", "trust", "What one answer costs in model tokens, search and tools."],
    ["LLM as a judge", "trust", "Using another AI to score answers. Fast, but should be checked against human scores."]
  ];

  let category = "all";

  function render() {
    const query = $("#glossary-search").value.trim().toLowerCase();
    const list = clear($("#glossary"));

    const shown = TERMS.filter(([name, cat, text]) => {
      if (category !== "all" && cat !== category) return false;
      return !query || name.toLowerCase().includes(query) || text.toLowerCase().includes(query);
    });

    shown.forEach(([name, cat, text]) => {
      const item = el("div", "term");
      const dt = el("dt", null, name);
      if (category === "all") dt.appendChild(el("span", "pill plain", LABEL[cat]));
      item.appendChild(dt);
      item.appendChild(el("dd", null, text));
      list.appendChild(item);
    });

    if (!shown.length) {
      list.appendChild(el("p", "empty", "No word matches \"" + query + "\". Try a shorter search or pick \"All\"."));
    }

    $("#glossary-count").textContent = shown.length + " of " + TERMS.length + " words";
  }

  const filter = seg($("#glossary-filter"), CATEGORIES, category, (value) => {
    category = value;
    render();
  });

  // Searching always looks in every part, so no match is hidden by the filter
  $("#glossary-search").addEventListener("input", () => {
    if ($("#glossary-search").value.trim() && category !== "all") filter.set("all");
    else render();
  });
  render();
})();
