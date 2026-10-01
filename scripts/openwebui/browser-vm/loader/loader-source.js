// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// chad-shim — open-webui loader.js injection (v3, for open-webui v0.11.3).
//
// Loaded by /app/build/index.html on every page via
// <script src="/static/loader.js" defer>. Served from
// /app/backend/open_webui/static/loader.js (STATIC_DIR). Redeploy after any
// container recreate with:
//   docker cp scripts/openwebui/static/loader.js \
//     nemoclaw-openwebui:/app/backend/open_webui/static/loader.js
//
// Three features:
//
// 1. Auth-redirect fix — open-webui's /auth route does new URL(redirectPath)
//    which throws "Invalid URL" when the param is "//" (protocol-relative
//    without host), leaving a blank page after Cloudflare-Access SSO. Normalized
//    here before the SPA mounts.
//
// 2. Model-dropdown tooltips — stock v0.11.3 doesn't surface
//    model.info.meta.description in the composer's model picker. We annotate
//    each [role=option] row with a title= tooltip (plus tippy instance
//    re-patching, since the listbox is windowed and recycles DOM nodes).
//    Descriptions come from /api/models meta, with a baked-in fallback map.
//
// 3. Top-nav "Switch Model" search — in v0.11.3 the model selector lives in
//    the BOTTOM composer; picking by category means a long scroll. This adds a
//    prominent trigger to the top navbar that opens a panel with a search box,
//    a category tag cloud, and a filtered model list. Picking a model drives
//    the NATIVE selector (click trigger → type into native search → click the
//    matching option) so all Svelte state (selected model, default model,
//    compare, history) updates exactly as if the user did it by hand.
//
// Everything is idempotent: singletons are keyed on element ids, document
// listeners register once, and re-injection self-heals after SPA re-renders.

(function () {
  "use strict";

  // ── 1. Auth-redirect fix ─────────────────────────────────────────────────
  try {
    if (location.pathname === "/auth") {
      const params = new URLSearchParams(location.search);
      const redirect = params.get("redirect");
      if (redirect && (redirect === "//" || /^\/{2,}/.test(redirect))) {
        params.set("redirect", "/");
        history.replaceState(null, "", location.pathname + "?" + params.toString() + location.hash);
        console.log("[chad-loader] normalized broken auth redirect param: '" + redirect + "' → '/'");
      }
    }
    try {
      const stale = localStorage.getItem("redirectPath");
      if (stale && (stale === "//" || /^\/{2,}/.test(stale))) {
        localStorage.setItem("redirectPath", "/");
        console.log("[chad-loader] normalized stale localStorage redirectPath: '" + stale + "' → '/'");
      }
    } catch (_) {}
  } catch (_) {}

  // ── Shared helpers ───────────────────────────────────────────────────────
  const CSS_ID = "chad-mc";
  const TRIGGER_ID = CSS_ID + "-trigger";
  const PANEL_ID = CSS_ID + "-panel";
  const SEARCH_ID = CSS_ID + "-search";
  const CLOUD_ID = CSS_ID + "-cloud";
  const LIST_ID = CSS_ID + "-list";
  const COUNT_ID = CSS_ID + "-count";
  const CLEAR_ID = CSS_ID + "-clear";
  const WRAP_ID = CSS_ID + "-wrap";
  const STYLE_TRIGGER_ID = "chad-mc-trigger-style";
  const STYLE_PANEL_ID = "chad-mc-style";

  function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // Wait for a predicate to be truthy, polling at 30ms. Never hangs forever.
  function waitFor(pred, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        let v = null;
        try {
          v = pred();
        } catch (_) {}
        if (v) {
          clearInterval(timer);
          resolve(v);
        } else if (Date.now() - started > (timeoutMs || 2500)) {
          clearInterval(timer);
          resolve(null);
        }
      }, 30);
    });
  }

  // ── 2. Model metadata (baked fallback + live /api/models) ────────────────
  const BAKED = {
    "chad":
      "Local OpenClaw agent on the chad sandbox. Use when you want access to private data/context, long-term memory (gbrain), custom skills, agent orchestration, or anything that needs tools (read/edit/exec, web, browser, cron). Slower (~20s/turn) but full agent harness with workspace files baked in.",
    "nvidia/nemotron-3-super-120b-a12b":
      "Frontier general-purpose. 120B MoE / 12B active, NVIDIA's flagship for chat, reasoning, code, summarization. Same model Chad uses internally — pick this when you want raw inference without the agent wrapper.",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning":
      "Small + reasoning. 30B with chain-of-thought traces. Best for math, logic puzzles, step-by-step problem solving on a budget. Fast.",
    "meta/llama-3.3-70b-instruct":
      "Meta's frontier open model. Best general-purpose for writing, summarization, instruction-following, light code review. Reliable workhorse.",
    "meta/llama-3.1-405b-instruct":
      "Largest open Llama. Pick when you need maximum reasoning depth on hard, ambiguous problems. Slow cold start; not for quick chat.",
    "meta/llama-3.1-70b-instruct":
      "Mid-size Llama. Solid generalist when you don't need frontier — chat, drafting, summarization, simple code. Good speed/quality trade-off.",
    "mistralai/mixtral-8x22b-instruct-v0.1":
      "Mixture-of-experts. Strong at multilingual chat, creative writing, French/Spanish/German fluency. Fast for its size.",
    "google/gemma-3-27b-it":
      "Google's mid-size open model. Strong at writing, summarization, structured output. Tight, efficient — good for Q&A and explanation tasks.",
    "openai/gpt-oss-20b":
      "OpenAI's small open model. Fast, low-latency. Best for quick Q&A, casual chat, classification, simple transforms.",
    "openai/gpt-oss-120b":
      "OpenAI's frontier open model. Strong general reasoning + writing. Pick over GPT-OSS 20B when quality matters more than speed.",
    "microsoft/phi-4-multimodal-instruct":
      "Vision-capable. Pick this when you need to analyze images, diagrams, screenshots, or PDFs alongside text. Smaller than the giants but solid for multimodal tasks.",
    "qwen/qwen3-coder-480b-a35b-instruct":
      "Coding-optimized 480B MoE. Best for: writing new code, debugging, multi-file refactors, code review, language migrations. Top choice for technical work that doesn't need agent tools.",
    "z-ai/glm-5.1":
      "ChatGLM frontier. Best for Chinese-language tasks, English-Chinese bilingual chat, translation. Strong reasoning in both languages.",
    "minimaxai/minimax-m2.5":
      "MiniMax frontier. Strong at long-context document processing, creative writing, narrative generation. Pick when you have a lot of context to thread through.",
  };

  // Display-name prefixes for matching trigger labels back to descriptions.
  const NAME_PREFIXES = {
    "Chad": BAKED["chad"],
    "Nemotron 3 Super": BAKED["nvidia/nemotron-3-super-120b-a12b"],
    "Nemotron 3 Nano": BAKED["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"],
    "Llama 3.3 70B": BAKED["meta/llama-3.3-70b-instruct"],
    "Llama 3.1 405B": BAKED["meta/llama-3.1-405b-instruct"],
    "Llama 3.1 70B": BAKED["meta/llama-3.1-70b-instruct"],
    "Mixtral": BAKED["mistralai/mixtral-8x22b-instruct-v0.1"],
    "Gemma": BAKED["google/gemma-3-27b-it"],
    "GPT-OSS 20B": BAKED["openai/gpt-oss-20b"],
    "GPT-OSS 120B": BAKED["openai/gpt-oss-120b"],
    "Phi-4": BAKED["microsoft/phi-4-multimodal-instruct"],
    "Qwen3 Coder": BAKED["qwen/qwen3-coder-480b-a35b-instruct"],
    "GLM-5.1": BAKED["z-ai/glm-5.1"],
    "MiniMax": BAKED["minimaxai/minimax-m2.5"],
  };

  const MODEL_STATE = { models: [], byId: {}, tags: {}, fetchedAt: 0, fetched: false };

  async function fetchModels(force) {
    const now = Date.now();
    if (!force && MODEL_STATE.fetched && now - MODEL_STATE.fetchedAt < 5 * 60 * 1000) {
      return MODEL_STATE;
    }
    try {
      const headers = { "Content-Type": "application/json" };
      const token = localStorage.getItem("token");
      if (token) headers["Authorization"] = "Bearer " + token;
      const res = await fetch("/api/models", { headers, credentials: "include" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const models = [];
      const byId = {};
      for (const m of data.data || []) {
        const meta = (m.info && m.info.meta) || {};
        const tags = Array.isArray(meta.tags)
          ? meta.tags.map((t) => (typeof t === "string" ? t : t && t.name)).filter(Boolean)
          : [];
        const rec = {
          id: m.id,
          name: m.name || m.id,
          tags: tags,
          description: meta.description || "",
        };
        byId[rec.id] = rec;
        models.push(rec);
      }
      const tags = {};
      for (const m of models) for (const t of m.tags) tags[t] = (tags[t] || 0) + 1;
      MODEL_STATE.models = models;
      MODEL_STATE.byId = byId;
      MODEL_STATE.tags = tags;
      MODEL_STATE.fetched = true;
      MODEL_STATE.fetchedAt = now;
    } catch (e) {
      console.warn("[chad-loader] fetch /api/models failed:", e);
    }
    return MODEL_STATE;
  }

  function descriptionForId(id) {
    if (!id) return null;
    const rec = MODEL_STATE.byId[id];
    if (rec && rec.description) return rec.description;
    if (BAKED[id]) return BAKED[id];
    return null;
  }

  function descriptionForLabel(label) {
    if (!label) return null;
    const trimmed = label.trim();
    for (const prefix of Object.keys(NAME_PREFIXES)) {
      if (trimmed.startsWith(prefix)) return NAME_PREFIXES[prefix];
    }
    const rec = MODEL_STATE.models.find(
      (m) => m.name === trimmed || trimmed.startsWith(m.name.split(" — ")[0])
    );
    return rec && rec.description ? rec.description : null;
  }

  // ── 2a. Dropdown tooltip annotation ──────────────────────────────────────
  // open-webui's listbox is windowed: the same DOM nodes get recycled for
  // different models during scroll. Re-patch keyed on the CURRENT data-value.
  function patchTippyContent(el, newContent, modelId) {
    const inst = el && el._tippy;
    if (!inst) return false;
    const key = modelId + "|" + newContent.length;
    if (el.dataset.chadTippy === key) return false;
    try {
      inst.setContent(newContent);
    } catch (_) {
      return false;
    }
    el.dataset.chadTippy = key;
    return true;
  }

  function annotate(item) {
    const modelId = item.getAttribute && item.getAttribute("data-value");
    if (!modelId) return;
    const desc = descriptionForId(modelId);
    if (!desc) return;

    let patched = 0;
    item.querySelectorAll("*").forEach((el) => {
      if (!el._tippy) return;
      const cur = el._tippy.props && el._tippy.props.content;
      if (typeof cur === "string" && cur.length < 400) {
        if (patchTippyContent(el, desc, modelId)) patched++;
      }
    });
    if (item.dataset.chadTitledFor !== modelId) {
      item.title = desc;
      item.style.cursor = "help";
      item.dataset.chadTitledFor = modelId;
    }
    return patched;
  }

  function scan(root) {
    if (!(root instanceof Element)) return;
    const sel = '[role="option"][data-value]';
    root.querySelectorAll(sel).forEach(annotate);
    if (root.matches && root.matches(sel)) annotate(root);
  }

  // ── 3. Top-nav "Switch Model" panel ──────────────────────────────────────
  let panelEl = null;
  let triggerEl = null;
  let panelOpen = false;
  const panelState = { tags: new Set(), query: "" };

  const cloudStyles = `
  #${PANEL_ID} {
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 200;
    width: min(24rem, calc(100vw - 1rem));
    border-radius: 1rem; padding: 0.75rem;
    background: var(--mc-surface);
    border: 1px solid var(--mc-border);
    box-shadow: 0 12px 40px rgba(0,0,0,0.18);
    color: var(--mc-fg);
    font-size: 0.8125rem; line-height: 1.25;
    display: none; flex-direction: column; gap: 0.6rem;
    --mc-surface: #fff; --mc-fg: #1f2937; --mc-border: #e5e7eb; --mc-muted: #6b7280;
    --mc-chip: #f3f4f6; --mc-chip-fg: #374151; --mc-chip-border: #e5e7eb;
    --mc-accent: #4f46e5; --mc-accent-fg: #fff;
    --mc-hover: #eef2ff;
  }
  html.dark #${PANEL_ID} {
    --mc-surface: #18181b; --mc-fg: #e4e4e7; --mc-border: #3f3f46; --mc-muted: #a1a1aa;
    --mc-chip: #27272a; --mc-chip-fg: #e4e4e7; --mc-chip-border: #3f3f46;
    --mc-accent: #6366f1; --mc-accent-fg: #fff; --mc-hover: #1e1b4b;
  }
  #${PANEL_ID}.open { display: flex; }
  #${SEARCH_ID} {
    width: 100%; box-sizing: border-box; padding: 0.5rem 0.65rem;
    border-radius: 0.75rem; border: 1px solid var(--mc-border);
    background: var(--mc-chip); color: var(--mc-fg); outline: none; font-size: 0.8125rem;
  }
  #${SEARCH_ID}:focus { border-color: var(--mc-accent); }
  #${COUNT_ID} { font-size: 0.6875rem; color: var(--mc-muted); }
  #${CLEAR_ID} {
    margin-left: auto; padding: 0.1rem 0.4rem; border-radius: 0.5rem;
    font-size: 0.6875rem; color: var(--mc-accent); cursor: pointer;
    border: 1px solid var(--mc-border); background: transparent;
  }
  #${CLEAR_ID}:hover { background: var(--mc-hover); }
  #${CLOUD_ID} {
    display: flex; flex-wrap: wrap; gap: 0.35rem 0.5rem; align-items: center;
    max-height: 7rem; overflow-y: auto;
  }
  #${CLOUD_ID} .mc-tag {
    display: inline-flex; align-items: center; gap: 0.25rem;
    padding: 0.22rem 0.55rem; border-radius: 999px;
    font-size: 0.75rem; cursor: pointer; user-select: none;
    background: var(--mc-chip); color: var(--mc-chip-fg);
    border: 1px solid var(--mc-chip-border);
    transform: rotate(0deg); transition: transform 120ms ease, background 120ms ease;
  }
  #${CLOUD_ID} .mc-tag:hover { transform: scale(1.06); box-shadow: 0 2px 8px rgba(0,0,0,0.12); }
  #${CLOUD_ID} .mc-tag.on {
    background: var(--mc-accent); color: var(--mc-accent-fg); border-color: var(--mc-accent);
  }
  #${LIST_ID} {
    display: flex; flex-direction: column; gap: 2px;
    max-height: min(18rem, 45vh); overflow-y: auto;
  }
  #${LIST_ID} .mc-row {
    display: flex; align-items: center; gap: 0.5rem; cursor: pointer;
    padding: 0.42rem 0.55rem; border-radius: 0.65rem;
    border: 1px solid transparent;
  }
  #${LIST_ID} .mc-row:hover { background: var(--mc-hover); }
  #${LIST_ID} .mc-row .mc-name { font-size: 0.8125rem; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #${LIST_ID} .mc-row .mc-ctags { display: flex; gap: 0.25rem; flex: none; }
  #${LIST_ID} .mc-row .mc-ctags span {
    font-size: 0.5625rem; padding: 0.05rem 0.35rem; border-radius: 999px;
    background: var(--mc-chip); color: var(--mc-muted); border: 1px solid var(--mc-chip-border);
  }
  #${LIST_ID} .mc-row.selected { background: var(--mc-hover); border-color: var(--mc-accent); }
  #${LIST_ID} .mc-empty { padding: 0.75rem 0.5rem; text-align: center; color: var(--mc-muted); }
  `;

  function ensurePanelStyles() {
    if (!document.getElementById(STYLE_PANEL_ID)) {
      const st = document.createElement("style");
      st.id = STYLE_PANEL_ID;
      st.textContent = cloudStyles;
      (document.head || document.documentElement).appendChild(st);
    }
    if (!document.getElementById(STYLE_TRIGGER_ID)) {
      const st = document.createElement("style");
      st.id = STYLE_TRIGGER_ID;
      st.textContent =
        "#" + TRIGGER_ID + " {" +
        "  display: inline-flex; align-items: center; gap: 0.35rem; height: 1.75rem;" +
        "  padding: 0 0.65rem; margin: 0 0.25rem; border-radius: 0.6rem;" +
        "  font-size: 0.75rem; font-weight: 500; cursor: pointer; white-space: nowrap;" +
        "  color: #4f46e5; background: rgba(79,70,229,0.08); border: 1px solid rgba(79,70,229,0.35);" +
        "}" +
        "#" + TRIGGER_ID + ":hover { background: rgba(79,70,229,0.15); }" +
        "#" + TRIGGER_ID + " .chad-mc-label { max-width: 14rem; overflow: hidden; text-overflow: ellipsis; }" +
        "html.dark #" + TRIGGER_ID + " { color: #818cf8; background: rgba(99,102,241,0.12); border-color: rgba(99,102,241,0.4); }" +
        "html.dark #" + TRIGGER_ID + ":hover { background: rgba(99,102,241,0.2); }";
      (document.head || document.documentElement).appendChild(st);
    }
  }

  // The chat Navbar: <nav> → div.flex.items-center.w-full.max-w-full
  //   children: [title block (flex-1 …), actions cluster (lg:mr-1 flex-none …)]
  // The trigger goes between the title block and the actions cluster.
  function getNavTarget() {
    const nav = document.querySelector("nav");
    if (!nav) return null;
    const row = nav.querySelector("div.flex.items-center.w-full.max-w-full");
    return row || nav.children[0] || null;
  }

  // The native composer selector only exists on chat routes — gate on it so
  // the trigger never renders on a page where picking can't work.
  function nativeSelectorAvailable() {
    return !!document.getElementById("model-selector-model-button");
  }

  function currentModelName() {
    const btn = document.getElementById("model-selector-model-button");
    return btn ? (btn.innerText || "").trim() : "";
  }

  function currentModelId() {
    const label = currentModelName();
    if (!label) return null;
    const rec = MODEL_STATE.models.find(
      (m) => m.name === label || label.startsWith(m.name.split(" — ")[0])
    );
    return rec ? rec.id : null;
  }

  function buildTrigger() {
    const btn = document.createElement("button");
    btn.id = TRIGGER_ID;
    btn.type = "button";
    btn.innerHTML =
      '<span class="chad-mc-label">Switch Model</span>' +
      '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">' +
      '<path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return btn;
  }

  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML =
      '<input id="' + SEARCH_ID + '" type="text" placeholder="Search models…" autocomplete="off">' +
      '<div style="display:flex;align-items:center;gap:0.5rem;">' +
      '<span id="' + COUNT_ID + '"></span>' +
      '<button id="' + CLEAR_ID + '" type="button">Clear</button>' +
      "</div>" +
      '<div id="' + CLOUD_ID + '"></div>' +
      '<div id="' + LIST_ID + '"></div>';
    return panel;
  }

  function renderCloud() {
    const cloudEl = document.getElementById(CLOUD_ID);
    if (!cloudEl) return;
    const selected = panelState.tags;
    const tags = Object.keys(MODEL_STATE.tags).sort();
    cloudEl.innerHTML = "";
    if (!MODEL_STATE.fetched || tags.length === 0) {
      const s = document.createElement("span");
      s.className = "mc-empty";
      s.textContent = MODEL_STATE.fetched ? "No categories" : "Loading…";
      cloudEl.appendChild(s);
      return;
    }
    tags.forEach((tag) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mc-tag" + (selected.has(tag) ? " on" : "");
      const n = MODEL_STATE.tags[tag] || 0;
      b.textContent = tag + " (" + n + ")";
      b.addEventListener("click", () => {
        if (selected.has(tag)) selected.delete(tag);
        else selected.add(tag);
        b.classList.toggle("on", selected.has(tag));
        renderList();
      });
      cloudEl.appendChild(b);
    });
  }

  function renderList() {
    const listEl = document.getElementById(LIST_ID);
    const countEl = document.getElementById(COUNT_ID);
    if (!listEl) return;
    const searchEl = document.getElementById(SEARCH_ID);
    const q = ((searchEl && searchEl.value) || "").trim().toLowerCase();
    const selected = panelState.tags;

    const filtered = MODEL_STATE.models.filter((m) => {
      if (selected.size > 0 && !m.tags.some((t) => selected.has(t))) return false;
      if (q) {
        const hay = (m.name + " " + m.id + " " + m.tags.join(" ")).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const targetId = currentModelId();
    listEl.innerHTML = "";
    if (countEl) {
      countEl.textContent =
        filtered.length + " model" + (filtered.length === 1 ? "" : "s") +
        (selected.size > 0 ? " · " + selected.size + " categor" + (selected.size === 1 ? "y" : "ies") : "");
    }

    if (filtered.length === 0) {
      const e = document.createElement("div");
      e.className = "mc-empty";
      e.textContent = MODEL_STATE.fetched ? "No models match" : "Loading…";
      listEl.appendChild(e);
      return;
    }

    for (const m of filtered) {
      const row = document.createElement("div");
      row.className = "mc-row" + (m.id === targetId ? " selected" : "");
      row.title = m.description || descriptionForId(m.id) || "";

      const name = document.createElement("span");
      name.className = "mc-name";
      name.textContent = m.name;
      row.appendChild(name);

      const ctags = document.createElement("span");
      ctags.className = "mc-ctags";
      for (const t of m.tags.slice(0, 3)) {
        const s = document.createElement("span");
        s.textContent = t;
        ctags.appendChild(s);
      }
      row.appendChild(ctags);

      row.addEventListener("click", () => selectModel(m));
      listEl.appendChild(row);
    }
  }

  async function selectModel(model) {
    const ok = await driveNativeSelector(model.id, model.name);
    if (ok) {
      closePanel();
      syncTriggerLabel();
    }
  }

  // Clicks a native listbox option without leaving a stray popup open when
  // the target can't be found.
  async function driveNativeSelector(modelId, modelName) {
    const trigger = document.getElementById("model-selector-model-button");
    if (!trigger) return false;
    trigger.click(); // toggleOpen() resets native searchValue on open

    const input = await waitFor(() => document.getElementById("model-search-input"), 2500);
    if (!input) {
      // Popup didn't open (disabled? timing?) — toggle back closed if open.
      const listbox = document.querySelector('[role="listbox"]');
      if (listbox) trigger.click();
      return false;
    }

    clearNativeTagFilter();

    const attempts = [];
    if (modelName) attempts.push(modelName);
    attempts.push(modelId);

    for (const attempt of attempts) {
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(input, attempt);
      input.dispatchEvent(new Event("input", { bubbles: true }));

      const opt = await waitFor(() => {
        return document.querySelector(
          '[role="option"][data-value="' + cssEscape(modelId) + '"]'
        );
      }, 1200);
      if (opt) {
        opt.click();
        return true;
      }
    }

    // Not found — close the native popup so the UI isn't left dirty.
    trigger.click();
    console.warn("[chad-loader] model not found in native selector: " + modelId);
    return false;
  }

  // If the native dropdown has a category/connection filter active, its
  // TagSelector shows an XMark button. Scope the hunt to the selector popup
  // (the portal container with z-index: 9999) and click it.
  function clearNativeTagFilter() {
    const input = document.getElementById("model-search-input");
    if (!input) return;
    const popup =
      input.closest('div[style*="z-index"]') || input.closest('[role="dialog"]') || document;
    const xBtn = Array.from(popup.querySelectorAll("button")).find((b) => {
      const path = b.querySelector("svg path");
      return !!(path && (path.getAttribute("d") || "").startsWith("M6.28 5.22"));
    });
    if (xBtn) xBtn.click();
  }

  function openPanel() {
    if (!panelEl) return;
    fetchModels().then(() => {
      if (panelOpen) {
        renderCloud();
        renderList();
      }
    });
    // Fresh slate on every open — stale query + category filters from a
    // previous session of the panel are surprising (query ∧ tag → 0 results).
    panelState.tags.clear();
    const searchEl = document.getElementById(SEARCH_ID);
    if (searchEl) searchEl.value = "";
    renderCloud();
    renderList();
    panelOpen = true;
    panelEl.classList.add("open");
    syncTriggerLabel();
    const search = document.getElementById(SEARCH_ID);
    if (search) setTimeout(() => search.focus(), 30);
  }

  function closePanel() {
    panelOpen = false;
    if (panelEl) panelEl.classList.remove("open");
  }

  function syncTriggerLabel() {
    if (!triggerEl) return;
    const lbl = triggerEl.querySelector(".chad-mc-label");
    if (!lbl) return;
    const name = currentModelName();
    lbl.textContent = name || "Switch Model";
    triggerEl.title = name ? "Current model: " + name + " — click to switch" : "Switch model";
  }

  function setupPicker() {
    ensurePanelStyles();

    if (document.getElementById(TRIGGER_ID)) {
      triggerEl = document.getElementById(TRIGGER_ID);
      syncTriggerLabel();
      return;
    }
    const target = getNavTarget();
    if (!target || !nativeSelectorAvailable()) return;

    triggerEl = buildTrigger();
    panelEl = buildPanel();

    const wrap = document.createElement("div");
    wrap.id = WRAP_ID;
    wrap.style.cssText = "position:relative;display:flex;align-items:center;flex:none;";
    wrap.appendChild(triggerEl);
    wrap.appendChild(panelEl);

    // Insert between the title block and the actions cluster so the trigger
    // sits beside the page title, not past the kebab menu.
    const actions =
      Array.from(target.children).find((c) => (c.className || "").includes("lg:mr-1")) || null;
    if (actions) target.insertBefore(wrap, actions);
    else target.appendChild(wrap);

    triggerEl.addEventListener("click", () => {
      if (panelOpen) closePanel();
      else openPanel();
    });

    const clearBtn = document.getElementById(CLEAR_ID);
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        panelState.tags.clear();
        const searchEl = document.getElementById(SEARCH_ID);
        if (searchEl) searchEl.value = "";
        renderCloud();
        renderList();
      });
    }

    const searchEl = document.getElementById(SEARCH_ID);
    if (searchEl) {
      searchEl.addEventListener("input", () => renderList());
      searchEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const first = document.querySelector("#" + LIST_ID + " .mc-row");
          if (first) first.click();
        } else if (e.key === "Escape") {
          closePanel();
        }
        e.stopPropagation();
      });
    }

    syncTriggerLabel();
    fetchModels().then(() => {
      syncTriggerLabel();
      if (panelOpen) {
        renderCloud();
        renderList();
      }
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function start() {
    scan(document.body);

    // Tooltip annotation: observer + cheap poll while a listbox is open.
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => scan(n));
        if (m.type === "attributes" && m.target instanceof Element) annotate(m.target);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-value", "aria-label", "title", "data-model-id"],
    });

    // One document-level listener pair for the panel's whole lifetime.
    document.addEventListener("click", (e) => {
      if (!panelOpen) return;
      const wrap = document.getElementById(WRAP_ID);
      if (!wrap || wrap.contains(e.target)) return;
      closePanel();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && panelOpen) closePanel();
    });

    // Self-heal + tooltip poller. Single interval, cheap guards.
    setInterval(() => {
      const listboxOpen = !!document.querySelector('[role="listbox"]');
      if (listboxOpen) scan(document.body);

      const trigger = document.getElementById(TRIGGER_ID);
      if (trigger && !nativeSelectorAvailable()) {
        // Route without a composer selector (settings, admin, …) — remove.
        const wrap = document.getElementById(WRAP_ID);
        if (wrap) wrap.remove();
        triggerEl = null;
        panelEl = null;
        panelOpen = false;
      } else if (!trigger && getNavTarget()) {
        setupPicker();
      } else if (trigger) {
        syncTriggerLabel();
      }
    }, 800);

    // Initial setup attempts (SPA may not have rendered the nav yet).
    setupPicker();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  // Diagnostic API (DevTools console).
  window.chadTooltips = {
    refresh: () => scan(document.body),
    descriptions: BAKED,
  };
  window.chadModelCloud = {
    refresh: async () => {
      await fetchModels(true);
      renderCloud();
      renderList();
      syncTriggerLabel();
      return window.chadModelCloud.state();
    },
    open: openPanel,
    close: closePanel,
    state: () => ({
      fetched: MODEL_STATE.fetched,
      models: MODEL_STATE.models.length,
      tags: MODEL_STATE.tags,
      triggerInjected: !!document.getElementById(TRIGGER_ID),
    }),
  };
  console.log(
    "[chad-loader] v3 loaded — tooltips + top-nav 'Switch Model' search. " +
    "Try the Switch Model button in the top bar, or chadModelCloud.refresh()."
  );
})();
