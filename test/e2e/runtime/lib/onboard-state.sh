#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Assertions for onboard registry/session provider, model, and policy state.

e2e_onboard_state_assert_registry() {
  local registry_file="$1"
  local sandbox_name="$2"
  local expected_provider="$3"
  local expected_model="$4"
  local expected_presets_csv="$5"
  node - "${registry_file}" "${sandbox_name}" "${expected_provider}" "${expected_model}" "${expected_presets_csv}" <<'NODE'
const fs = require("node:fs");
const [registryPath, sandboxName, expectedProvider, expectedModel, csv] = process.argv.slice(2);
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const sandbox = registry.sandboxes && registry.sandboxes[sandboxName];
if (!sandbox) throw new Error(`missing sandbox registry entry: ${sandboxName}`);
if (sandbox.provider !== expectedProvider) throw new Error(`expected provider ${expectedProvider}, got ${sandbox.provider}`);
if (sandbox.model !== expectedModel) throw new Error(`expected model ${expectedModel}, got ${sandbox.model}`);
const policies = Array.isArray(sandbox.policies) ? sandbox.policies : [];
for (const preset of csv.split(",").filter(Boolean)) {
  if (!policies.includes(preset)) throw new Error(`missing policy preset ${preset}; policies=${JSON.stringify(policies)}`);
}
NODE
}

e2e_onboard_state_assert_session() {
  local session_file="$1"
  local sandbox_name="$2"
  local expected_provider="$3"
  local expected_model="$4"
  local expected_presets_csv="$5"
  node - "${session_file}" "${sandbox_name}" "${expected_provider}" "${expected_model}" "${expected_presets_csv}" <<'NODE'
const fs = require("node:fs");
const [sessionPath, sandboxName, expectedProvider, expectedModel, csv] = process.argv.slice(2);
const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
if (session.status !== "complete") throw new Error(`session status ${session.status}`);
if (session.sandboxName !== sandboxName) throw new Error(`session sandbox ${session.sandboxName}`);
if (session.provider !== expectedProvider) throw new Error(`session provider ${session.provider}`);
if (session.model !== expectedModel) throw new Error(`session model ${session.model}`);
const presets = Array.isArray(session.policyPresets) ? session.policyPresets : [];
for (const preset of csv.split(",").filter(Boolean)) {
  if (!presets.includes(preset)) throw new Error(`missing session policy preset ${preset}; presets=${JSON.stringify(presets)}`);
}
NODE
}
