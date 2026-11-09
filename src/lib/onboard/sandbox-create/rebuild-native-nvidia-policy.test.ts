// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { prepareInitialSandboxCreatePolicy } from "../initial-policy";
import { selectRebuildCreatePolicy } from "./orchestration";
import { materializeRebuildPolicyHandoff } from "./rebuild-policy-handoff";
import {
  customNativeProvider,
  boundCustomNativeProfile,
} from "../../inference/native-provider/custom";
import { nativeProviderLifecycle } from "../../inference/native-provider";
import type { NativeProviderAttachment } from "../../inference/native-provider/contract";

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

function rebuild(
  inferenceProvider: string | null,
  nativePolicy?: unknown,
  hostedPolicy?: unknown,
  receipt?: NativeProviderAttachment,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-rebuild-policy-test-"));
  roots.push(root);
  const livePath = path.join(root, "live.yaml");
  const source = YAML.stringify({
    version: 1,
    network_policies: {
      host_rule: hostPolicy,
      ...(nativePolicy === undefined ? {} : { native_nvidia_inference: nativePolicy }),
      ...(hostedPolicy === undefined ? {} : { native_hosted_inference: hostedPolicy }),
    },
  });
  fs.writeFileSync(livePath, source, { mode: 0o600 });
  const replacement = prepareInitialSandboxCreatePolicy(
    path.resolve(
      import.meta.dirname,
      "../../../../nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
    ),
    [],
    { agentName: "openclaw", inferenceProvider, nativeHostedProviderAttachment: receipt },
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
    [nativeProvider, "nemoclaw-openai-api-v1"],
    source,
    inferenceProvider,
    receipt,
  );
  cleanups.push(() => selected.cleanup?.());
  return {
    selected: YAML.parse(fs.readFileSync(selected.policyPath, "utf8")),
    replacement: YAML.parse(fs.readFileSync(replacement.policyPath, "utf8")),
    livePath,
    source,
    replacementPolicy: replacement,
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

describe("native hosted rebuild policy", () => {
  const hostedProvider = "nemoclaw-openai-api-v1";

  it.each(["nvidia-router", nativeProvider])(
    "removes the old hosted grant when switching to %s",
    (selected) => {
      const hosted = rebuild(hostedProvider).replacement.network_policies.native_hosted_inference;
      const result = rebuild(selected, undefined, hosted);
      expect(result.selected.network_policies).not.toHaveProperty("native_hosted_inference");
      expect(result.selected.network_policies.host_rule).toEqual(hostPolicy);
      expect(fs.readFileSync(result.livePath, "utf8")).toBe(result.source);
    },
  );

  it("replaces the NVIDIA grant with the selected hosted grant", () => {
    const native = rebuild(nativeProvider).replacement.network_policies.native_nvidia_inference;
    const result = rebuild(hostedProvider, native);
    expect(result.selected.network_policies).toEqual({
      host_rule: hostPolicy,
      native_hosted_inference: result.replacement.network_policies.native_hosted_inference,
    });
  });

  it("retains a hosted grant when no replacement inference was selected", () => {
    const hosted = rebuild(hostedProvider).replacement.network_policies.native_hosted_inference;
    expect(rebuild(null, undefined, hosted).selected.network_policies).toEqual({
      host_rule: hostPolicy,
      native_hosted_inference: hosted,
    });
  });
});

it("keeps custom NVIDIA pins owned by the attached provider through rebuild (#14013)", () => {
  const custom = customNativeProvider({
    provider: "compatible-endpoint",
    endpointUrl: "https://integrate.api.nvidia.com/v1",
    api: "openai-completions",
    credentialEnv: "COMPATIBLE_API_KEY",
    allowedIps: ["8.8.8.8"],
  });
  const receipt: NativeProviderAttachment = {
    schemaVersion: 1,
    providerName: custom.providerName,
    profileId: custom.profileId,
    providerId: "owned-custom",
    endpointUrl: custom.endpointUrl,
    allowedIps: custom.allowedIps,
    custom: custom.custom,
  };
  const result = rebuild(custom.providerName, undefined, undefined, receipt);
  expect(result.selected.network_policies).toEqual({ host_rule: hostPolicy });
  expect(result.replacement.network_policies).not.toHaveProperty("native_hosted_inference");
  expect(fs.readFileSync(result.livePath, "utf8")).toBe(result.source);
});

describe("retained custom NVIDIA base access", () => {
  function fixture(api: "openai-completions" | "openai-responses" = "openai-completions") {
    const custom = customNativeProvider({
      provider: "compatible-endpoint",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      api,
      credentialEnv: "COMPATIBLE_API_KEY",
      allowedIps: ["8.8.8.8"],
    });
    const receipt: NativeProviderAttachment = {
      schemaVersion: 1,
      providerName: custom.providerName,
      profileId: custom.profileId,
      providerId: "owned-custom",
      endpointUrl: custom.endpointUrl,
      allowedIps: custom.allowedIps,
      custom: custom.custom,
    };
    const profile = YAML.parse(
      boundCustomNativeProfile(custom, nativeProviderLifecycle(custom).nativeProviderProfilePath()),
    );
    const legacy = {
      name: "native_hosted_inference",
      endpoints: profile.endpoints,
      binaries: profile.binaries.map((binary: string) => ({ path: binary })),
    };
    return { custom, receipt, legacy };
  }

  it.each(["openai-completions", "openai-responses"] as const)(
    "removes only the generated %s base grant during rebuild (#14013)",
    (api) => {
      const { custom, receipt, legacy } = fixture(api);
      const result = rebuild(custom.providerName, undefined, legacy, receipt);
      expect(result.selected.network_policies).toEqual({ host_rule: hostPolicy });
      expect(fs.readFileSync(result.livePath, "utf8")).toBe(result.source);
      expect(YAML.parse(result.source).network_policies.native_hosted_inference).toEqual(legacy);
    },
  );

  it.each([
    { label: "captured", source: (source: string) => source },
    { label: "disk", source: (_source: string) => undefined },
    {
      label: "captured without a base grant",
      source: (source: string) => {
        const policy = YAML.parse(source);
        delete policy.network_policies.native_hosted_inference;
        return YAML.stringify(policy);
      },
    },
  ])("preserves Hermes NVIDIA grants during $label policy rebuild (#14013)", ({ source }) => {
    const { custom, receipt, legacy } = fixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-rebuild-policy-test-"));
    roots.push(root);
    const policy = {
      version: 1,
      network_policies: {
        nvidia: {
          name: "nvidia",
          endpoints: [{ host: "integrate.api.nvidia.com", port: 443 }],
          binaries: [{ path: "/opt/hermes/.venv/bin/python" }],
        },
        native_hosted_inference: legacy,
        host_rule: hostPolicy,
      },
    };
    const document = YAML.stringify(policy);
    const livePath = path.join(root, "live.yaml");
    const replacementPath = path.join(root, "replacement.yaml");
    fs.writeFileSync(livePath, document, { mode: 0o600 });
    fs.writeFileSync(replacementPath, document, { mode: 0o600 });
    const handoff = selectRebuildCreatePolicy(
      livePath,
      { policyPath: replacementPath, appliedPresets: [] },
      [],
      [],
      [],
      "hermes",
      null,
      "hermes-custom",
      [],
      source(document),
      custom.providerName,
      receipt,
    );
    cleanups.push(() => handoff.cleanup?.());
    expect(YAML.parse(fs.readFileSync(handoff.policyPath, "utf8")).network_policies).toEqual(
      policy.network_policies,
    );
    expect(fs.readFileSync(livePath, "utf8")).toBe(document);
  });

  it("materializes cleanup when reading the retained policy directly from disk (#14013)", () => {
    const { custom, receipt, legacy } = fixture();
    const result = rebuild(custom.providerName, undefined, legacy, receipt);
    const handoff = materializeRebuildPolicyHandoff({
      livePolicyPath: result.livePath,
      replacementPolicy: result.replacementPolicy,
      inferenceProvider: custom.providerName,
      nativeHostedProviderAttachment: receipt,
    });
    cleanups.push(() => handoff.cleanup?.());
    expect(handoff.policyPath).not.toBe(result.livePath);
    expect(YAML.parse(fs.readFileSync(handoff.policyPath, "utf8")).network_policies).toEqual({
      host_rule: hostPolicy,
    });
    expect(fs.readFileSync(result.livePath, "utf8")).toBe(result.source);
  });

  it.each([
    ["rules", { rules: [{ allow: { method: "GET", path: "/v1/models" } }] }],
    ["pins", { allowed_ips: ["1.1.1.1"] }],
  ])("refuses rebuild without deleting an operator's changed %s (#14013)", (_name, changes) => {
    const { custom, receipt, legacy } = fixture();
    Object.assign(legacy.endpoints[0], changes);
    expect(() => rebuild(custom.providerName, undefined, legacy, receipt)).toThrow(/conflict/u);
    const saved = YAML.parse(fs.readFileSync(path.join(roots.at(-1)!, "live.yaml"), "utf8"));
    expect(saved.network_policies).toEqual({
      host_rule: hostPolicy,
      native_hosted_inference: legacy,
    });
  });

  it("refuses rebuild without deleting an operator's changed binaries (#14013)", () => {
    const { custom, receipt, legacy } = fixture();
    legacy.binaries = [{ path: "/usr/bin/operator-client" }];
    expect(() => rebuild(custom.providerName, undefined, legacy, receipt)).toThrow(/conflict/u);
    const saved = YAML.parse(fs.readFileSync(path.join(roots.at(-1)!, "live.yaml"), "utf8"));
    expect(saved.network_policies).toEqual({
      host_rule: hostPolicy,
      native_hosted_inference: legacy,
    });
  });
});
