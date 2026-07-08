// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  cleanupMessagingState,
  parseOpenClawAgentText,
} from "../live/messaging-compatible-endpoint-helpers.ts";

const COMPAT_AGENT_REPLY = "COMPAT_MOCK_ROUTE_5098_OK";
const COMPAT_AGENT_PROMPT =
  "Call the configured model and report the compatible endpoint route token.";

describe("messaging compatible endpoint helper coverage", () => {
  it("keeps missing-sandbox cleanup from masking endpoint validation evidence", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const host = {
      command: async (command: string, args: string[]) => {
        calls.push({ command, args });
        throw new Error("Sandbox e2e-msg-compat-missing does not exist");
      },
    } as unknown as HostCliClient;

    await expect(
      (async () => {
        try {
          throw new Error("endpoint validation failed with HTTP 429");
        } catch (error) {
          await cleanupMessagingState(host, "e2e-msg-compat-missing");
          throw error;
        }
      })(),
    ).rejects.toThrow(/HTTP 429/);

    expect(calls).toHaveLength(3);
    expect(calls[0]?.command).toBe("node");
    expect(calls[0]?.args[0]).toMatch(/bin\/nemoclaw\.js$/);
    expect(calls[0]?.args.slice(1)).toEqual(["e2e-msg-compat-missing", "destroy", "--yes"]);
    expect(calls[1]).toEqual({
      command: "openshell",
      args: ["sandbox", "delete", "e2e-msg-compat-missing"],
    });
    expect(calls[2]?.command).toBe("bash");
    expect(calls[2]?.args[0]).toBe("-lc");
    expect(calls[2]?.args[1]).toContain("openshell gateway destroy -g nemoclaw");
  });

  it("extracts noisy OpenClaw JSON while rejecting prompt echo text", () => {
    expect(COMPAT_AGENT_PROMPT).not.toContain(COMPAT_AGENT_REPLY);
    expect(
      parseOpenClawAgentText(JSON.stringify({ result: { content: COMPAT_AGENT_PROMPT } })),
    ).not.toContain(COMPAT_AGENT_REPLY);

    const noisyOutput = [
      "openclaw: session starting",
      "debug: {not-json}",
      JSON.stringify({
        result: {
          messages: [{ role: "assistant", content: COMPAT_AGENT_REPLY }],
        },
      }),
      "openclaw: session complete",
    ].join("\n");

    expect(parseOpenClawAgentText(noisyOutput)).toContain(COMPAT_AGENT_REPLY);
  });

  it("extracts OpenAI Responses content parts", () => {
    const output = JSON.stringify({
      result: {
        content: [{ type: "output_text", text: COMPAT_AGENT_REPLY }],
      },
    });

    expect(parseOpenClawAgentText(output)).toContain(COMPAT_AGENT_REPLY);
  });
});
