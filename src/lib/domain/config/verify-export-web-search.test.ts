// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { exportWebSearchBinding } from "./export-evidence";
import {
  canonicalPolicy,
  entry,
  hermesSnapshot,
  managedWorkload,
  snapshot,
  tavilySnapshot,
  verify,
} from "./export-source-test-fixture";

function findings(result: ReturnType<typeof verify>) {
  return result.kind === "verified" ? [] : result.findings;
}
function verifiedSource(result: ReturnType<typeof verify>) {
  expect(result.kind).toBe("verified");
  return (result as Extract<typeof result, { kind: "verified" }>).source;
}

describe("Tavily export source verification", () => {
  it.each(["openclaw", "hermes"] as const)(
    "exports verified Tavily intent and policy for %s (#12138)",
    (agent) => {
      const value = tavilySnapshot(agent);
      expect(exportWebSearchBinding(value.registry)).toEqual({
        provider: "tavily",
        name: "alpha-tavily-search",
        profileId: agent === "hermes" ? "tavily-hermes-v1" : "tavily",
        credentialEnv: "TAVILY_API_KEY",
      });
      const source = verifiedSource(verify(value));
      expect(source.agent).toBe(agent);
      expect(source.webSearch).toEqual({
        provider: "tavily",
        agentRefs: ["primary"],
        credential: { env: "TAVILY_API_KEY" },
      });
      expect(source.policy).toEqual(canonicalPolicy);
      expect(source.inference).toMatchObject({ model: value.inference.model });
    },
  );

  describe.each(["openclaw", "hermes"] as const)("%s Tavily evidence", (agent) => {
    const value = tavilySnapshot(agent);
    it("requires a live provider (#12138)", () => {
      expect(findings(verify({ ...value, webSearchProvider: undefined }))).toContainEqual(
        expect.objectContaining({ field: "source.webSearch", category: "missing-provenance" }),
      );
    });
    it.each([
      ["a foreign gateway", { gatewayName: "foreign" }],
      ["a foreign workspace", { workspace: "foreign" }],
      ["a different registration name", { name: "foreign-tavily-search" }],
      ["a missing provider identity", { id: "" }],
      ["an unversioned provider", { resourceVersion: "0" }],
      ["the Brave provider type", { type: "brave" }],
      ["the Brave credential reference", { credentialKeys: ["BRAVE_API_KEY"] }],
      ["extra credential references", { credentialKeys: ["TAVILY_API_KEY", "OTHER_KEY"] }],
      ["custom provider configuration", { configKeys: ["BASE_URL"] }],
      ["a foreign profile workspace", { profileWorkspace: "foreign" }],
      ["missing profile evidence", { profile: undefined }],
      [
        "another agent's profile",
        {
          profile: {
            ...value.webSearchProvider!.profile!,
            id: agent === "hermes" ? "tavily" : "tavily-hermes-v1",
          },
        },
      ],
    ] as const)("rejects %s (#12138)", (_label, change) => {
      expect(
        findings(
          verify({ ...value, webSearchProvider: { ...value.webSearchProvider!, ...change } }),
        ),
      ).toContainEqual(expect.objectContaining({ field: "source.webSearch", category: "drifted" }));
    });
    it.each([
      ["a missing attachment", []],
      ["a Brave attachment", ["alpha-brave-search"]],
      ["an extra attachment", ["alpha-tavily-search", "other"]],
      ["a duplicate attachment", ["alpha-tavily-search", "alpha-tavily-search"]],
    ] as const)("rejects %s (#12138)", (_label, providerNames) => {
      expect(
        findings(verify({ ...value, sandbox: { ...value.sandbox, providerNames } })),
      ).toContainEqual(
        expect.objectContaining({ field: "source.sandbox.providers", category: "unsupported" }),
      );
    });
    it("rejects startup intent without Tavily (#12138)", () => {
      expect(
        findings(
          verify({
            ...value,
            registry: {
              ...value.registry,
              workload: agent === "hermes" ? hermesSnapshot().registry.workload : managedWorkload(),
            },
          }),
        ),
      ).toContainEqual(
        expect.objectContaining({
          field: "source.workload.startupProfile",
          category: "unsupported",
        }),
      );
    });
  });

  it.each(["openclaw", "hermes"] as const)(
    "keeps disabled search ungranted for %s and rejects leftover Tavily evidence (#12138)",
    (agent) => {
      const value = agent === "hermes" ? hermesSnapshot() : snapshot();
      const disabled = {
        ...value,
        registry: { ...value.registry, webSearchEnabled: false, webSearchProvider: null },
      };
      expect(exportWebSearchBinding(disabled.registry)).toBeUndefined();
      expect(verifiedSource(verify(disabled))).not.toHaveProperty("webSearch");
      expect(
        findings(
          verify({ ...disabled, webSearchProvider: tavilySnapshot(agent).webSearchProvider }),
        ),
      ).toContainEqual(
        expect.objectContaining({ field: "source.webSearch", category: "ambiguous" }),
      );
    },
  );

  it.each([
    ["Hermes Brave", hermesSnapshot({ webSearchEnabled: true, webSearchProvider: "brave" })],
    [
      "enabled search without a provider",
      snapshot({ registry: entry({ webSearchEnabled: true, webSearchProvider: undefined }) }),
    ],
  ] as const)("rejects %s (#12138)", (_label, value) => {
    expect(exportWebSearchBinding(value.registry)).toBeUndefined();
    expect(findings(verify(value))).toContainEqual(
      expect.objectContaining({
        field: "spec.sandboxes[].integrations.webSearch",
        category: "unsupported",
      }),
    );
  });
});
