// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { parseConfigExport } from "../fixtures/phases/config-export-validation.ts";
import { writeSecretFreeConfigExportArtifact } from "./config-export-secret-scan.ts";

function currentInput() {
  return {
    apiVersion: "nemoclaw.nvidia.com/v1alpha1",
    kind: "NemoClawConfig",
    metadata: {
      name: "current-export",
      uid: "123e4567-e89b-42d3-a456-426614174000",
    },
    spec: {
      gateway: { management: "managed", endpoint: "http://127.0.0.1:8080" },
      inferenceProviders: [
        {
          name: "hosted-openai",
          provider: "openai",
          api: "openai-responses",
          endpoint: "https://api.openai.com/v1",
          credential: { env: "OPENAI_API_KEY" },
        },
      ],
      sandboxes: [
        {
          name: "assistant",
          runtime: { provider: "docker" },
          network: { policy: { explicit: { version: 1 } } },
          harness: { kind: "openclaw" },
          agent: {
            name: "primary",
            inference: {
              routes: [
                {
                  name: "primary",
                  providerRef: "hosted-openai",
                  overrides: { model: "gpt-5" },
                },
              ],
            },
          },
        },
      ],
    },
  };
}

describe("current config export input", () => {
  it("accepts one singular agent (#12131)", () => {
    expect(parseConfigExport(JSON.stringify(currentInput())).spec.sandboxes[0]?.agent.name).toBe(
      "primary",
    );
  });

  it("rejects an agents list without rewriting it (#12131)", () => {
    const candidate = currentInput();
    const sandbox = candidate.spec.sandboxes[0]! as unknown as Record<string, unknown>;
    const agent = sandbox.agent;
    Reflect.deleteProperty(sandbox, "agent");
    sandbox.agents = [agent];

    expect(() => parseConfigExport(JSON.stringify(candidate))).toThrow(
      "complete v1alpha1 export contract",
    );
  });
});

describe("config export artifact secret boundary", () => {
  const secret = "nvapi-review-secret-123456";
  const encodedCases = [
    ["literal", secret],
    [
      "percent encoded",
      [...Buffer.from(secret)].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""),
    ],
    [
      "YAML escaped",
      [...Buffer.from(secret)].map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`).join(""),
    ],
    ["base64", Buffer.from(secret).toString("base64")],
  ] as const;

  it.each(encodedCases)("rejects a %s credential before writing evidence", async (_name, value) => {
    const writer = { writeText: vi.fn(async () => undefined) };

    await expect(
      writeSecretFreeConfigExportArtifact(writer, "config-export-live.yaml", `value: ${value}`, [
        secret,
      ]),
    ).rejects.toThrow("config export exposed a known fixture secret");
    expect(writer.writeText).not.toHaveBeenCalled();
  });

  it("writes YAML only after the shared secret scan passes", async () => {
    const writer = { writeText: vi.fn(async () => undefined) };
    const raw = JSON.stringify(currentInput());

    await writeSecretFreeConfigExportArtifact(writer, "config-export-live.yaml", raw, [secret]);

    expect(writer.writeText).toHaveBeenCalledWith("config-export-live.yaml", raw);
  });
});
