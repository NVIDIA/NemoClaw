// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const NATIVE_RESTART_PROVIDER = "nemoclaw-e2e-native";

// Keep provider credentials inside the sandbox. Only the selected model ID is
// returned to the host; native OpenClaw owns validation and the config write.
export function buildNativeModelRestartCommand(): string[] {
  return [
    "/usr/bin/env",
    "HOME=/sandbox",
    "/usr/local/bin/node",
    "-e",
    `const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const JSON5 = require("/usr/local/lib/node_modules/openclaw/node_modules/json5");
try {
  const config = JSON5.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));
  const original = config.agents?.defaults?.model?.primary;
  const separator = typeof original === "string" ? original.indexOf("/") : -1;
  if (separator < 1 || separator === original.length - 1) throw new Error("model selection");
  const provider = config.models?.providers?.[original.slice(0, separator)];
  const model = original.slice(separator + 1);
  const name = ${JSON.stringify(NATIVE_RESTART_PROVIDER)};
  const primary = name + "/" + model;
  if (!provider || !Array.isArray(provider.models) || !provider.models.some(item => item.id === model)) {
    throw new Error("configured model");
  }
  if (Object.hasOwn(config.models.providers, name) || Object.hasOwn(config.agents.defaults.models ?? {}, primary)) {
    throw new Error("test provider already exists");
  }
  const modelSettings = { ...(config.agents.defaults.models?.[original] ?? {}) };
  delete modelSettings.alias;
  const patch = {
    models: { providers: { [name]: provider } },
    agents: { defaults: { model: { primary }, models: { [primary]: modelSettings } } }
  };
  execFileSync("/usr/local/bin/openclaw", ["config", "patch", "--stdin"], {
    input: JSON.stringify(patch), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 90000, killSignal: "SIGKILL"
  });
  process.stdout.write(JSON.stringify({ original, primary, model }));
} catch {
  // A child error can contain credential-bearing config. Do not print it.
  process.stderr.write("Could not prepare the native restart model.\\n");
  process.exitCode = 1;
}`,
  ];
}
