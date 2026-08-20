// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertOpenShell2847FailureEvidence } from "../tools/e2e/assert-openshell-2847-mcp-failure.mts";

const roots: string[] = [];
const resultNames = [
  "openclaw-mcp-concurrent-add-first.result.json",
  "openclaw-mcp-concurrent-add-second.result.json",
];
const candidateSha = "a".repeat(40);

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeEvidence(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-2847-"));
  roots.push(parent);
  const root = path.join(parent, "pass-1");
  const shell = path.join(root, "mcp-bridge", "shell");
  const stderr = [
    "\u001b[32m\u2713\u001b[0m Policy version 5 submitted (hash: abcdef012345)",
    "\u001b[32m\u2713\u001b[0m Policy version 5 loaded (active version: 5)",
    "\u001b[32m\u2713\u001b[0m Policy version 6 submitted (hash: bcdef0123456)",
    "\u001b[32m\u2713\u001b[0m Policy version 6 loaded (active version: 6)",
    "Preset not found: mcp-bridge-concurrent",
    "\u001b[32m\u2713\u001b[0m Policy version 7 submitted (hash: cdef01234567)",
    "\u001b[32m\u2713\u001b[0m Policy version 7 loaded (active version: 7)",
    "OpenShell did not synchronize the expected credential revision for placeholder 'FAKE_MCP_SECRET' into sandbox 'e2e-pr-exact-mcp-1' after provider attachment or update.",
    "",
  ].join("\n");
  for (const name of resultNames) {
    writeJson(path.join(shell, name), {
      exitCode: 1,
      signal: null,
      stderr,
      timedOut: false,
    });
  }
  writeJson(path.join(root, "risk-signal.json"), {
    version: 1,
    jobId: "mcp-bridge",
    shardId: "openclaw",
    expectedSha: candidateSha,
    testedSha: candidateSha,
    passed: 0,
    failed: 1,
    skipped: 0,
    pending: 0,
    unhandledErrors: 0,
    runReason: "failed",
  });
  writeJson(path.join(root, "mcp-bridge", "cleanup.json"), {
    passed: ["destroy sandbox e2e-pr-exact-mcp-1"],
    failures: [],
  });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("OpenShell credential-revision failure evidence", () => {
  it("accepts both exact credential-revision failures with completed cleanup", () => {
    const root = makeEvidence();

    expect(assertOpenShell2847FailureEvidence(root, candidateSha)).toBe("e2e-pr-exact-mcp-1");
  });

  it("rejects a different command failure", () => {
    const root = makeEvidence();
    const resultFile = path.join(root, "mcp-bridge", "shell", resultNames[0]);
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as Record<string, unknown>;
    result.stderr = "OpenClaw tool discovery failed\n";
    writeJson(resultFile, result);

    expect(() => assertOpenShell2847FailureEvidence(root, candidateSha)).toThrow(
      /different terminal diagnostic/u,
    );
  });

  it("rejects evidence without the expected preset diagnostic", () => {
    const root = makeEvidence();
    const resultFile = path.join(root, "mcp-bridge", "shell", resultNames[0]);
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as Record<string, unknown>;
    result.stderr = String(result.stderr).replace(
      "Preset not found: mcp-bridge-concurrent",
      "\u2713 Policy version 8 loaded (active version: 8)",
    );
    writeJson(resultFile, result);

    expect(() => assertOpenShell2847FailureEvidence(root, candidateSha)).toThrow(
      /unexpected diagnostic/u,
    );
  });

  it("rejects evidence from a different commit", () => {
    const root = makeEvidence();
    const signalFile = path.join(root, "risk-signal.json");
    const signal = JSON.parse(fs.readFileSync(signalFile, "utf8")) as Record<string, unknown>;
    signal.expectedSha = "b".repeat(40);
    signal.testedSha = "b".repeat(40);
    writeJson(signalFile, signal);

    expect(() => assertOpenShell2847FailureEvidence(root, candidateSha)).toThrow(
      /unexpected E2E risk signal/u,
    );
  });

  it("rejects incomplete sandbox cleanup", () => {
    const root = makeEvidence();
    writeJson(path.join(root, "mcp-bridge", "cleanup.json"), {
      passed: [],
      failures: ["destroy sandbox e2e-pr-exact-mcp-1"],
    });

    expect(() => assertOpenShell2847FailureEvidence(root, candidateSha)).toThrow(
      /does not confirm sandbox cleanup/u,
    );
  });
});
