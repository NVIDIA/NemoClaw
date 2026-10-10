// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  customAttachmentFromPrepared,
  prepareNativeCustomProfile,
  type NativeCustomProviderAttachment,
} from "../../inference/native-custom";
import { prepareInitialSandboxCreatePolicy } from "../initial-policy";
import { buildNativeCustomSandboxPolicy } from "../../inference/native-custom/network-policy";
import {
  beginRecreateDeleteAfterPolicyPreflight,
  selectRebuildCreatePolicy,
} from "./orchestration";
import { readValidatedRebuildPolicySource } from "./rebuild-policy-handoff";

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
  nativeCustomProviderAttachment?: NativeCustomProviderAttachment,
  customPolicy?: unknown,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-rebuild-policy-test-"));
  roots.push(root);
  const livePath = path.join(root, "live.yaml");
  const source = YAML.stringify({
    version: 1,
    network_policies: {
      host_rule: hostPolicy,
      ...(nativePolicy === undefined ? {} : { native_nvidia_inference: nativePolicy }),
      ...(customPolicy === undefined ? {} : { native_custom_inference: customPolicy }),
    },
  });
  fs.writeFileSync(livePath, source, { mode: 0o600 });
  const replacement = prepareInitialSandboxCreatePolicy(
    path.resolve(
      import.meta.dirname,
      "../../../../nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
    ),
    [],
    { agentName: "openclaw", inferenceProvider, nativeCustomProviderAttachment },
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
    nativeCustomProviderAttachment,
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

async function customAttachment(endpointUrl = "https://api.example.com/v1") {
  const prepared = await prepareNativeCustomProfile({
    sandboxName: "dp",
    provider: "compatible-endpoint",
    api: "openai-completions",
    endpointUrl,
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  });
  return customAttachmentFromPrepared(prepared, {
    schemaVersion: 1,
    profileId: prepared.profile.id,
    providerName: prepared.providerName,
    providerId: "rebuild-custom-provider-id",
  });
}

describe("native custom rebuild policy", () => {
  it("reconciles an owned endpoint change before deletion and preserves the source policy (#12636)", async () => {
    const previous = await customAttachment();
    const next = await customAttachment("https://next.example.com/v1");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-rebuild-preflight-"));
    roots.push(root);
    const livePath = path.join(root, "live.yaml");
    const source = buildNativeCustomSandboxPolicy(
      YAML.stringify({ version: 1, network_policies: { host_rule: hostPolicy } }),
      previous,
    );
    fs.writeFileSync(livePath, source);
    let captured: ReturnType<typeof readValidatedRebuildPolicySource> | undefined;
    const beginDelete = vi.fn(() => {
      expect(captured?.document).toContain("next.example.com");
      expect(captured?.document).not.toContain("api.example.com");
      return "source";
    });
    beginRecreateDeleteAfterPolicyPreflight({
      capturePolicySource: () => {
        captured = readValidatedRebuildPolicySource(livePath, {
          sandboxName: "dp",
          previous,
          next,
        });
      },
      beginDelete,
    });
    const replacement = prepareInitialSandboxCreatePolicy(
      path.resolve(
        import.meta.dirname,
        "../../../../nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
      ),
      [],
      {
        agentName: "openclaw",
        inferenceProvider: next.providerName,
        nativeCustomProviderAttachment: next,
      },
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
      [],
      captured!.document,
      next.providerName,
      next,
    );
    cleanups.push(() => selected.cleanup?.());
    expect(beginDelete).toHaveBeenCalledOnce();
    expect(
      YAML.parse(fs.readFileSync(selected.policyPath, "utf8")).network_policies.host_rule,
    ).toEqual(hostPolicy);
    expect(fs.readFileSync(livePath, "utf8")).toBe(source);
  });

  it.each(["unowned", "malformed", "foreign"] as const)(
    "rejects %s authority before deletion (#12636)",
    async (kind) => {
      const previous = await customAttachment();
      const next = await customAttachment("https://next.example.com/v1");
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-rebuild-denial-"));
      roots.push(root);
      const livePath = path.join(root, "live.yaml");
      const ownedSource = buildNativeCustomSandboxPolicy(
        "version: 1\nnetwork_policies: {}\n",
        previous,
      );
      const scenario =
        kind === "unowned"
          ? {
              source: YAML.stringify({
                version: 1,
                network_policies: { native_custom_inference: hostPolicy },
              }),
              previous,
            }
          : {
              source: ownedSource,
              previous: kind === "malformed" ? {} : { ...previous, sandboxName: "foreign" },
            };
      fs.writeFileSync(livePath, scenario.source);
      const beginDelete = vi.fn();
      expect(() =>
        beginRecreateDeleteAfterPolicyPreflight({
          capturePolicySource: () =>
            readValidatedRebuildPolicySource(livePath, {
              sandboxName: "dp",
              previous: scenario.previous,
              next,
            }),
          beginDelete,
        }),
      ).toThrow(/ownership could not be verified|invalid native custom provider authority/);
      expect(beginDelete).not.toHaveBeenCalled();
      expect(fs.readFileSync(livePath, "utf8")).toBe(scenario.source);
    },
  );

  it("adds the selected endpoint rule without replacing host rules (#12636)", async () => {
    const attachment = await customAttachment();
    const result = rebuild(attachment.providerName, undefined, attachment);
    expect(result.selected.network_policies).toEqual({
      host_rule: hostPolicy,
      native_custom_inference: result.replacement.network_policies.native_custom_inference,
    });
    expect(fs.readFileSync(result.livePath, "utf8")).toBe(result.source);
  });

  it("refuses a conflicting custom rule before replacing the sandbox (#12636)", async () => {
    const attachment = await customAttachment();
    expect(() => rebuild(attachment.providerName, undefined, attachment, hostPolicy)).toThrow(
      "live network policy 'native_custom_inference' does not match the selected runtime requirement",
    );
  });

  it("removes custom access when another inference provider is selected (#12636)", async () => {
    const attachment = await customAttachment();
    const custom = rebuild(attachment.providerName, undefined, attachment).replacement
      .network_policies.native_custom_inference;
    const result = rebuild("openai", undefined, undefined, custom);
    expect(result.selected.network_policies).toEqual({ host_rule: hostPolicy });
    expect(fs.readFileSync(result.livePath, "utf8")).toBe(result.source);
  });

  it("preserves custom access when no replacement provider is selected (#12636)", async () => {
    const attachment = await customAttachment();
    const custom = rebuild(attachment.providerName, undefined, attachment).replacement
      .network_policies.native_custom_inference;
    expect(rebuild(null, undefined, undefined, custom).selected.network_policies).toEqual({
      host_rule: hostPolicy,
      native_custom_inference: custom,
    });
  });
});
