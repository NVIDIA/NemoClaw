#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// refresh-models.js — daily refresh of the available model roster. NVIDIA hosts
// the newest open models on integrate.api.nvidia.com, so this fetches the live
// catalog, filters to general chat/agentic models, and writes state/models.json
// (with a `new` list of models that appeared since the last run). The fusion
// workflow + experiments read this so newly launched models are picked up
// automatically — no manual edits.
//
// Run daily via dev.nemoclaw.chad-models-refresh.plist. Manual: node refresh-models.js
// Env: CHAD_HOST_CREDS, CHAD_MODELS_FILE, CHAD_MODELS_FEATURED_MAX (default 8).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CREDS = process.env.CHAD_HOST_CREDS || "/Users/r/.nemoclaw/credentials.json";
const OUT = process.env.CHAD_MODELS_FILE || join(HERE, "state/models.json");
// 0 = no cap: every chat-capable model is featured (ranked by PRIORITY then
// FLAGSHIP padding). Any positive number restricts featured to that many.
const FEATURED_MAX = Number(process.env.CHAD_MODELS_FEATURED_MAX || 0);

// Drop narrow-purpose models — keep general chat/agentic ones.
const EXCLUDE = /embed|safety|guard|pii|translate|rerank|calibrat|ocr|parse|reward|gliner|riva|ising|moderation|vision-?only|nv-rerank/i;
// Flagship families for fusion, in PRIORITY order (best first) — featured is
// picked from these against the live catalog so new flagships auto-feature when
// their pattern is here. Add a line when a new top model lands. FLAGSHIP is the
// fallback to pad with any other large/general model.
const PRIORITY = [
  /nemotron-3-ultra/i, /gpt-oss/i, /deepseek-v\d/i, /kimi-k\d/i, /qwen3\.5/i,
  /glm-5/i, /minimax-m\d/i, /mistral-large/i, /mistral-nemotron/i,
  /nemotron-3\.5-lightning/i, /nemotron-3-nano-omni/i, /step-/i,
  /llama-4/i, /diffusiongemma/i, /muse-glimmer/i, /nemotron-3-super/i,
];
const FLAGSHIP = /ultra|gpt-oss|deepseek-v\d|kimi-k\d|qwen3\.5|glm-5|minimax-m\d|mistral|nemotron|step|llama-4|diffusiongemma|muse|gemma-4/i;

const key = (() => {
  try { return JSON.parse(readFileSync(CREDS, "utf8")).NVIDIA_API_KEY || ""; } catch { return ""; }
})() || process.env.NVIDIA_API_KEY || "";
if (!key) { console.error("refresh-models: no NVIDIA_API_KEY"); process.exit(1); }

const r = await fetch("https://integrate.api.nvidia.com/v1/models", {
  headers: { Authorization: "Bearer " + key },
});
if (!r.ok) { console.error("refresh-models: catalog HTTP " + r.status); process.exit(1); }
const data = await r.json();
const ids = (data.data || []).map((m) => m.id).filter(Boolean).sort();
const chat = ids.filter((id) => !EXCLUDE.test(id));
// Priority-ordered featured: best flagships first, then pad with any other
// large/general model, capped at FEATURED_MAX.
const featured = [];
for (const re of PRIORITY) { const hit = chat.find((id) => re.test(id) && !featured.includes(id)); if (hit) featured.push(hit); }
const padLimit = () => FEATURED_MAX > 0 && featured.length >= FEATURED_MAX;
for (const id of chat) { if (padLimit()) break; if (FLAGSHIP.test(id) && !featured.includes(id)) featured.push(id); }
// Append anything still not featured so EVERY chat-capable model is in the list
// (ordered: priority flagships first, then the rest). FEATURED_MAX=0 => uncapped.
for (const id of chat) { if (padLimit()) break; if (!featured.includes(id)) featured.push(id); }
if (FEATURED_MAX > 0) featured.length = Math.min(featured.length, FEATURED_MAX);

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { chat: [] };
const added = chat.filter((id) => !(prev.chat || []).includes(id));
const removed = (prev.chat || []).filter((id) => !chat.includes(id));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  total: ids.length, chatCount: chat.length,
  featured, chat, new: added, removed,
}, null, 2) + "\n");

console.log(`refresh-models: ${ids.length} total · ${chat.length} chat · ${featured.length} featured · ${added.length} new · ${removed.length} gone`);
if (added.length) console.log("  NEW:", added.join(", "));
if (removed.length) console.log("  GONE:", removed.join(", "));
