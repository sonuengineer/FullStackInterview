/* Shared helpers for all parts of the guide. Exposed as window.G */
(function () {
  const SVGNS = "http://www.w3.org/2000/svg";

  const G = {};

  G.$ = (selector, root) => (root || document).querySelector(selector);
  G.$$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));

  G.el = function (tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  G.svg = function (tag, attrs) {
    const node = document.createElementNS(SVGNS, tag);
    for (const key in attrs || {}) node.setAttribute(key, attrs[key]);
    return node;
  };

  G.clear = function (node) {
    node.textContent = "";
    return node;
  };

  /** Build a paragraph from parts: strings, or [text, className] for a highlighted span. */
  G.rich = function (tag, parts, cls) {
    const node = G.el(tag, cls);
    parts.forEach((part) => {
      if (typeof part === "string") node.appendChild(document.createTextNode(part));
      else node.appendChild(G.el(part[2] || "span", part[1], part[0]));
    });
    return node;
  };

  /** Click and Enter/Space for SVG groups or other non-button elements. */
  G.onActivate = function (node, handler) {
    node.addEventListener("click", handler);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handler(event);
      }
    });
  };

  /** Segmented control. options: [{ value, label }] */
  G.seg = function (container, options, initial, onChange) {
    G.clear(container);
    container.classList.add("seg");
    container.setAttribute("role", "group");
    let current = String(initial);

    const buttons = options.map((option) => {
      const button = G.el("button", null, option.label);
      button.type = "button";
      button.dataset.value = String(option.value);
      button.addEventListener("click", () => set(option.value, true));
      container.appendChild(button);
      return button;
    });

    function set(value, fire) {
      current = String(value);
      buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === current)));
      if (fire && onChange) onChange(current);
    }

    set(initial, false);
    return { set: (value) => set(value, true), get: () => current };
  };

  /** Row of pick buttons (examples). labels: string[] */
  G.picks = function (container, labels, initialIndex, onPick) {
    G.clear(container);
    const buttons = labels.map((label, index) => {
      const button = G.el("button", "pick", label);
      button.type = "button";
      button.addEventListener("click", () => set(index, true));
      container.appendChild(button);
      return button;
    });

    function set(index, fire) {
      buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(i === index)));
      if (fire && onPick) onPick(index);
    }

    if (initialIndex != null && initialIndex >= 0) set(initialIndex, false);
    return { set: (index) => set(index, true), clearActive: () => set(-1, false) };
  };

  /** Tabs. tabs: [{ label, build(panel) }] */
  G.tabs = function (list, panel, tabs, initialIndex) {
    G.clear(list);
    const buttons = tabs.map((tab, index) => {
      const button = G.el("button", "tab", tab.label);
      button.type = "button";
      button.setAttribute("role", "tab");
      button.addEventListener("click", () => select(index));
      list.appendChild(button);
      return button;
    });

    function select(index) {
      buttons.forEach((b, i) => b.setAttribute("aria-selected", String(i === index)));
      G.clear(panel);
      tabs[index].build(panel);
    }

    select(initialIndex || 0);
    return { select };
  };

  G.softmax = function (scores) {
    const max = Math.max(...scores);
    const exps = scores.map((s) => Math.exp(s - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map((e) => e / sum);
  };

  G.pct = function (p) {
    const value = p * 100;
    if (value > 0 && value < 1) return "<1%";
    return value.toFixed(0) + "%";
  };

  /** Bar row used by several demos. */
  G.barRow = function (label, share, text, extraClass) {
    const row = G.el("div", "bar-row" + (extraClass ? " " + extraClass : ""));
    row.appendChild(G.el("span", "word", label));
    const track = G.el("div", "bar-track");
    const fill = G.el("div", "bar-fill");
    fill.style.width = Math.max(0, Math.min(1, share)) * 100 + "%";
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(G.el("span", "pct", text));
    return row;
  };

  G.reducedMotion = function () {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  };

  window.G = G;
})();
