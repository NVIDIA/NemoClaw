// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HELPER = path.join(
  import.meta.dirname,
  "e2e",
  "lib",
  "openclaw-agent-json.py",
);

function runHelper(input: string) {
  return spawnSync("python3", [HELPER], {
    input,
    encoding: "utf-8",
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
    const result = runHelper([
      JSON.stringify({ payloads: [] }),
      "progress line",
      JSON.stringify({ payloads: [{ text: "42" }] }),
    ].join("\n"));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("42\n");
  });
});
