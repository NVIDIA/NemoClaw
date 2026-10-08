// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { prepareInitialSandboxCreatePolicy } from "../initial-policy";
import { selectRebuildCreatePolicy } from "./orchestration";

const roots: string[] = [];
const cleanups: Array<() => boolean | undefined> = [];
const nativeProvider = "nemoclaw-nvidia-prod-v1";
const hostPolicy = {
  name: "host_rule",
  endpoints: [{ host: "host.example.com", port: 443 }],
  binaries: [{ path: "/usr/bin/curl" }],
};

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function rebuild(inferenceProvider: string | null, nativePolicy?: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-rebuild-policy-test-"));
  roots.push(root);
  const livePath = path.join(root, "live.yaml");
  const source = YAML.stringify({
    version: 1,
    network_policies: {
      host_rule: hostPolicy,
      ...(nativePolicy === undefined ? {} : { native_nvidia_inference: nativePolicy }),
    },
  });
  fs.writeFileSync(livePath, source, { mode: 0o600 });
  const replacement = prepareInitialSandboxCreatePolicy(
    path.resolve(
      import.meta.dirname,
      "../../../../nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
    ),
    [],
    { agentName: "openclaw", inferenceProvider },
  );
  cleanups.push(() => replacement.cleanup?.());
  const selected = selectRebuildCreatePolicy(
    livePath,
    replacement,
    [],
    [],
    [],
    "openclaw",
    null,
    "dp",
    [nativeProvider],
    source,
    inferenceProvider,
  );
  cleanups.push(() => selected.cleanup?.());
  return {
    selected: YAML.parse(fs.readFileSync(selected.policyPath, "utf8")),
    replacement: YAML.parse(fs.readFileSync(replacement.policyPath, "utf8")),
    livePath,
    source,
  };
}

describe("native NVIDIA rebuild policy", () => {
  it("adds the required native route without replacing host network rules (#12822)", () => {
    const result = rebuild(nativeProvider);
    expect(result.selected.network_policies).toEqual({
      host_rule: hostPolicy,
      native_nvidia_inference: result.replacement.network_policies.native_nvidia_inference,
    });
    expect(fs.readFileSync(result.livePath, "utf8")).toBe(result.source);
  });

  it("preserves a removed native route when another inference provider is selected (#12822)", () => {
    expect(rebuild("openai").selected.network_policies).toEqual({ host_rule: hostPolicy });
  });

  it("removes the generated native grant when rebuilding with OpenAI (#12822)", () => {
    const native = rebuild(nativeProvider).replacement.network_policies.native_nvidia_inference;
    const result = rebuild("openai", native);
    expect(result.selected.network_policies).toEqual({ host_rule: hostPolicy });
    expect(fs.readFileSync(result.livePath, "utf8")).toBe(result.source);
  });

  it("preserves native access when no replacement provider is selected (#12822)", () => {
    const native = rebuild(nativeProvider).replacement.network_policies.native_nvidia_inference;
    expect(rebuild(null, native).selected.network_policies).toEqual({
      host_rule: hostPolicy,
      native_nvidia_inference: native,
    });
  });

  it("refuses a conflicting host native rule before replacing the sandbox (#12822)", () => {
    expect(() => rebuild(nativeProvider, hostPolicy)).toThrow(
      "live network policy 'native_nvidia_inference' does not match the selected runtime requirement",
    );
  });
});
