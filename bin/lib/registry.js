// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Multi-sandbox registry at ~/.nemoclaw/sandboxes.json

const fs = require("fs");
const path = require("path");

const REGISTRY_FILE = path.join(process.env.HOME || "/tmp", ".nemoclaw", "sandboxes.json");
const DEFAULT_RUNTIME = "openclaw";
const DEFAULT_SURFACES = {
  openclaw: "openclaw-ui",
  nullclaw: "nullhub",
};
const DEFAULT_FORWARD_PORTS = {
  "openclaw-ui": 18789,
  nullhub: 19800,
  none: 3000,
};

function defaultSurface(runtime) {
  return DEFAULT_SURFACES[runtime] || DEFAULT_SURFACES[DEFAULT_RUNTIME];
}

function inferSurface(entry, runtime) {
  if (entry.surface) return entry.surface;
  if (runtime === "nullclaw") {
    if (entry.forwardPort === DEFAULT_FORWARD_PORTS.nullhub) {
      return "nullhub";
    }
    return "none";
  }
  return "openclaw-ui";
}

function defaultForwardPort(runtime, surface = defaultSurface(runtime)) {
  return DEFAULT_FORWARD_PORTS[surface] || DEFAULT_FORWARD_PORTS[defaultSurface(DEFAULT_RUNTIME)];
}

function normalizeSandbox(entry) {
  const runtime = entry.runtime || DEFAULT_RUNTIME;
  const surface = inferSurface(entry, runtime);
  return {
    ...entry,
    name: entry.name,
    createdAt: entry.createdAt || new Date().toISOString(),
    model: entry.model || null,
    nimContainer: entry.nimContainer || null,
    provider: entry.provider || null,
    gpuEnabled: entry.gpuEnabled || false,
    policies: entry.policies || [],
    runtime,
    surface,
    forwardPort: entry.forwardPort || defaultForwardPort(runtime, surface),
  };
}

function load() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
      const sandboxes = Object.fromEntries(
        Object.entries(data.sandboxes || {}).map(([name, entry]) => [name, normalizeSandbox({ name, ...entry })])
      );
      return {
        sandboxes,
        defaultSandbox: data.defaultSandbox || null,
      };
    }
  } catch {}
  return { sandboxes: {}, defaultSandbox: null };
}

function save(data) {
  const dir = path.dirname(REGISTRY_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function getSandbox(name) {
  const data = load();
  return data.sandboxes[name] || null;
}

function getDefault() {
  const data = load();
  if (data.defaultSandbox && data.sandboxes[data.defaultSandbox]) {
    return data.defaultSandbox;
  }
  // Fall back to first sandbox if default is missing
  const names = Object.keys(data.sandboxes);
  return names.length > 0 ? names[0] : null;
}

function registerSandbox(entry) {
  const data = load();
  data.sandboxes[entry.name] = normalizeSandbox(entry);
  if (!data.defaultSandbox) {
    data.defaultSandbox = entry.name;
  }
  save(data);
}

function updateSandbox(name, updates) {
  const data = load();
  if (!data.sandboxes[name]) return false;
  Object.assign(data.sandboxes[name], updates);
  save(data);
  return true;
}

function removeSandbox(name) {
  const data = load();
  if (!data.sandboxes[name]) return false;
  delete data.sandboxes[name];
  if (data.defaultSandbox === name) {
    const remaining = Object.keys(data.sandboxes);
    data.defaultSandbox = remaining.length > 0 ? remaining[0] : null;
  }
  save(data);
  return true;
}

function listSandboxes() {
  const data = load();
  return {
    sandboxes: Object.values(data.sandboxes),
    defaultSandbox: data.defaultSandbox,
  };
}

function setDefault(name) {
  const data = load();
  if (!data.sandboxes[name]) return false;
  data.defaultSandbox = name;
  save(data);
  return true;
}

module.exports = {
  DEFAULT_RUNTIME,
  defaultSurface,
  defaultForwardPort,
  load,
  save,
  getSandbox,
  getDefault,
  registerSandbox,
  updateSandbox,
  removeSandbox,
  listSandboxes,
  setDefault,
};
