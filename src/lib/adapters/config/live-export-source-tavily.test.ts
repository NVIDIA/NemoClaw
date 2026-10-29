// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { exportLiveSource, raw } from "../../../../test/support/config-export-harness";
import { mockSearchLiveSource, tavilyProfile } from "./live-export-search-source-test-fixture";
import { asExportedConfig } from "../../../../test/support/config-export-document";
import {
  imageRef,
  inventory,
  provider,
  readFailureCanary,
} from "./live-export-source-test-fixture";

describe("live Tavily export", () => {
  it.each(["openclaw", "hermes"] as const)(
    "exports %s Tavily from verified SDK reads without reading credential values (#12138)",
    async (agent) => {
      const search = mockSearchLiveSource("tavily", agent);
      const { result, writeStdout, publish } = await exportLiveSource();
      expect(result).toEqual({ ok: true, completion: { kind: "stdout" } });
      const yaml = writeStdout.mock.calls[0]![0];
      const document = asExportedConfig(YAML.parse(yaml));
      const sandbox = document.spec.sandboxes[0]!;
      expect(sandbox.harness.kind).toBe(agent);
      expect(sandbox.integrations).toEqual({
        "tavily-search": {
          kind: "webSearch",
          provider: "tavily",
          credential: { env: "TAVILY_API_KEY" },
        },
      });
      expect(sandbox.agent.integrationRefs).toEqual(["tavily-search"]);
      expect(raw.getProvider.mock.calls.map(([request]) => request.name)).toEqual([
        "nvidia-prod",
        "alpha-tavily-search",
        "nvidia-prod",
        "alpha-tavily-search",
      ]);
      expect(raw.getProviderProfile).toHaveBeenCalledWith(
        {
          id: agent === "hermes" ? "tavily-hermes-v1" : "tavily-policy-binding-v1",
          workspace: "default",
        },
        { signal: expect.any(AbortSignal) },
      );
      expect(search.readCredential).not.toHaveBeenCalled();
      expect(yaml).not.toContain(readFailureCanary);
      expect(publish).not.toHaveBeenCalled();
    },
  );

  describe.each(["openclaw", "hermes"] as const)("%s Tavily export refusal", (agent) => {
    it.each([
      [
        "provider evidence is missing",
        () =>
          raw.getProvider.mockImplementation(async ({ name }: { name: string }) =>
            name === "alpha-tavily-search"
              ? Promise.reject(Object.assign(new Error(readFailureCanary), { code: 5 }))
              : provider(),
          ),
      ],
      [
        "the sandbox attaches a different provider",
        () =>
          raw.getSandbox.mockResolvedValue({
            sandbox: {
              ...inventory().sandbox,
              spec: {
                template: {
                  image:
                    agent === "hermes"
                      ? imageRef.replace("openclaw-sandbox", "hermes-sandbox")
                      : imageRef,
                },
                providers: ["other-tavily-search"],
              },
            },
          }),
      ],
      [
        "the profile executable differs",
        () =>
          raw.getProviderProfile.mockResolvedValue({
            profile: { ...tavilyProfile(agent), binaries: [{ path: "/usr/bin/python" }] },
          }),
      ],
      [
        "the profile adds a read-write access preset",
        () => {
          const profile = tavilyProfile(agent);
          raw.getProviderProfile.mockResolvedValue({
            profile:
              agent === "hermes"
                ? { ...profile, endpoints: [{ ...profile.endpoints[0], access: "read-write" }] }
                : { ...profile, endpoints: [{ host: "foreign.example" }] },
          });
        },
      ],
      [
        "the profile allows uninspected credentials",
        () => {
          const profile = tavilyProfile(agent);
          raw.getProviderProfile.mockResolvedValue({
            profile:
              agent === "hermes"
                ? {
                    ...profile,
                    endpoints: [{ ...profile.endpoints[0], allowUninspectedCredentials: true }],
                  }
                : { ...profile, binaries: [{ path: "/usr/bin/python" }] },
          });
        },
      ],
      [
        "the profile never stabilizes",
        () => {
          let version = 4n;
          raw.getProviderProfile.mockImplementation(async () => ({
            profile: {
              ...tavilyProfile(agent),
              resourceVersion: version++,
            },
          }));
        },
      ],
    ] as const)("does not publish when %s (#12138)", async (_label, arrange) => {
      const search = mockSearchLiveSource("tavily", agent);
      arrange();
      const exported = await exportLiveSource();
      expect(exported.result).toMatchObject({ ok: false, failure: { kind: "observation" } });
      expect(exported.writeStdout).not.toHaveBeenCalled();
      expect(exported.publish).not.toHaveBeenCalled();
      expect(search.readCredential).not.toHaveBeenCalled();
      expect(JSON.stringify(exported.result)).not.toContain(readFailureCanary);
    });
  });
});
