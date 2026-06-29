// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HELPER = path.join(import.meta.dirname, "e2e", "lib", "openclaw-agent-json.py");
const SHELL_HELPER = path.join(import.meta.dirname, "e2e", "lib", "openclaw-json.sh");

function runHelper(input: string): SpawnSyncReturns<string> {
  return spawnSync("python3", [HELPER], {
    input,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function runShellHelper(input: string): SpawnSyncReturns<string> {
  return spawnSync("bash", ["-lc", 'source "$OPENCLAW_JSON_HELPER"; parse_openclaw_agent_text'], {
    input,
    encoding: "utf-8",
    env: { ...process.env, OPENCLAW_JSON_HELPER: SHELL_HELPER },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("openclaw-agent-json.py", () => {
  it("extracts nested result payload text", () => {
    const result = runHelper(JSON.stringify({ result: { payloads: [{ text: "42" }] } }));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("42\n");
    expect(result.stderr).toBe("");
  });

  it("extracts top-level payload text", () => {
    const result = runHelper(JSON.stringify({ payloads: [{ text: "PONG" }] }));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("PONG\n");
    expect(result.stderr).toBe("");
  });

  it("prints an empty line for valid JSON with no text payloads", () => {
    const result = runHelper(JSON.stringify({ payloads: [{ mediaUrl: null }] }));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("\n");
    expect(result.stderr).toBe("");
  });

  it("exits nonzero for invalid JSON", () => {
    const result = runHelper("{not json");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid JSON");
  });

  it("extracts JSON when OpenClaw logs precede the envelope", () => {
    const result = runHelper(`progress line\n${JSON.stringify({ payloads: [{ text: "PONG" }] })}`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("PONG\n");
  });

  it("extracts payload text from later JSON envelopes in a stream", () => {
    const result = runHelper(
      [
        JSON.stringify({ payloads: [] }),
        "progress line",
        JSON.stringify({ payloads: [{ text: "42" }] }),
      ].join("\n"),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("42\n");
  });

  it("preserves failed tool-result provenance independent of missing bare python", () => {
    const result = runHelper(
      JSON.stringify({
        result: {
          messages: [
            {
              role: "toolResult",
              content: [
                {
                  type: "toolResult",
                  toolCallId: "call_node_missing",
                  toolName: "exec",
                  isError: true,
                  text: "exec failed: /bin/sh: 1: node-not-a-real-command: not found",
                },
              ],
            },
          ],
          payloads: [{ text: "The script was saved successfully." }],
        },
      }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[openclaw provenance] failed tool result");
    expect(result.stdout).toContain("exec call_node_missing");
    expect(result.stdout).toContain("node-not-a-real-command");
    expect(result.stdout).toContain("The script was saved successfully.");
    expect(result.stdout.indexOf("[openclaw provenance] failed tool result")).toBeLessThan(
      result.stdout.indexOf("The script was saved successfully."),
    );
  });

  it("strips ANSI, OSC, and control characters from provenance details", () => {
    const result = runHelper(
      JSON.stringify({
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_hostile",
            toolName: "exec",
            isError: true,
            text: [
              "\x1B[2Jexec failed",
              "\x1B]8;;https://example.invalid/phish\x07linked text\x1B]8;;\x07",
              "overwrite\rhidden",
              "erase\bmark",
              "\u0000done",
            ].join(" "),
          },
        ],
      }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[openclaw provenance] failed tool result");
    expect(result.stdout).toContain("exec failed");
    expect(result.stdout).toContain("linked text");
    expect(result.stdout).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/u);
    expect(result.stdout).not.toContain("https://example.invalid");
  });

  it("redacts secret-shaped values from provenance details", () => {
    const rawApiKey = "nvapi-abcdefghijklmnopqrstuvwxyz123456";
    const rawBearer = "secretbearertoken1234567890";
    const rawPassword = "hunter2-password-value";
    const rawPrivateKey = "private-key-material-that-must-not-leak";
    const privateKeyEnvelope = [
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
      rawPrivateKey,
      ["-----END", "PRIVATE KEY-----"].join(" "),
    ].join(" ");
    const result = runHelper(
      JSON.stringify({
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_secret",
            toolName: "exec",
            isError: true,
            stderr: [
              `NVIDIA_INFERENCE_API_KEY=${rawApiKey}`,
              `Authorization: Bearer ${rawBearer}`,
              `password: ${rawPassword}`,
              privateKeyEnvelope,
            ].join("\n"),
          },
        ],
      }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[openclaw provenance] failed tool result");
    expect(result.stdout).toContain("<REDACTED>");
    expect(result.stdout).toContain("<REDACTED_PRIVATE_KEY>");
    expect(result.stdout).not.toContain(rawApiKey);
    expect(result.stdout).not.toContain(rawBearer);
    expect(result.stdout).not.toContain(rawPassword);
    expect(result.stdout).not.toContain(rawPrivateKey);
  });

  it("bounds deep traversal of sandbox-controlled JSON", () => {
    let envelope: unknown = { payloads: [{ text: "too deep to trust" }] };
    for (let index = 0; index < 120; index += 1) {
      envelope = { payload: envelope };
    }

    const result = runHelper(JSON.stringify(envelope));

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("\n");
  });

  it("preserves legacy assistant response shapes from choices and nested containers", () => {
    const result = runHelper(
      JSON.stringify([
        {
          choices: [
            { message: { content: "choice message" } },
            { delta: { content: "delta chunk" } },
            { text: "choice text" },
          ],
        },
        { response: { reasoning_content: "reasoning output" } },
        { result: { messages: [{ content: "nested message content" }] } },
      ]),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("choice message");
    expect(result.stdout).toContain("delta chunk");
    expect(result.stdout).toContain("choice text");
    expect(result.stdout).toContain("reasoning output");
    expect(result.stdout).toContain("nested message content");
  });

  it("labels untrusted child-agent payloads before assistant text", () => {
    const childPayload = [
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>",
      "Found a plausible but unverified URL: https://github.com/openclaw/openclaw/releases",
      "<<<END_UNTRUSTED_CHILD_RESULT>>>",
    ].join("\n");
    const result = runHelper(
      JSON.stringify({
        result: {
          messages: [{ role: "user", content: childPayload }],
          payloads: [
            {
              text: "The web-search skill found https://github.com/openclaw/openclaw/releases.",
            },
          ],
        },
      }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[openclaw provenance] untrusted child result present");
    expect(result.stdout).toContain("unverified URL");
    expect(result.stdout).toContain("The web-search skill found");
    expect(
      result.stdout.indexOf("[openclaw provenance] untrusted child result present"),
    ).toBeLessThan(result.stdout.indexOf("The web-search skill found"));
  });

  it("routes the shell E2E parser through the provenance-preserving helper", () => {
    const result = runShellHelper(
      JSON.stringify({
        payloads: [{ text: "Finished." }],
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_false",
            toolName: "exec",
            isError: true,
            text: "exec failed: /bin/false exited 1",
          },
        ],
      }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[openclaw provenance] failed tool result");
    expect(result.stdout).toContain("/bin/false exited 1");
    expect(result.stdout).toContain("Finished.");
    expect(result.stdout.indexOf("[openclaw provenance] failed tool result")).toBeLessThan(
      result.stdout.indexOf("Finished."),
    );
  });
});
