// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ANSI_ESCAPE = /\u001b\[[0-9;]*m/gu;
const RESULT_BASENAMES = [
  "openclaw-mcp-concurrent-add-first.result.json",
  "openclaw-mcp-concurrent-add-second.result.json",
] as const;
const POLICY_STATUS =
  /^\u2713 Policy version \d+ (?:submitted \(hash: [0-9a-f]+\)|loaded \(active version: \d+\))$/u;
const REVISION_FAILURE =
  /^OpenShell did not synchronize the expected credential revision for placeholder 'FAKE_MCP_SECRET' into sandbox '(e2e-pr-exact-mcp-([12]))' after provider attachment or update\.$/u;

type JsonObject = Record<string, unknown>;

function readJsonObject(file: string): JsonObject {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`OpenShell #2847 evidence is not a regular file: ${file}`);
  }
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`OpenShell #2847 evidence is not a JSON object: ${file}`);
  }
  return value as JsonObject;
}

function commandSandbox(file: string, expectedPass: string): string {
  const result = readJsonObject(file);
  if (result.exitCode !== 1 || result.timedOut !== false || result.signal !== null) {
    throw new Error(`OpenShell #2847 result has an unexpected process outcome: ${file}`);
  }
  if (typeof result.stderr !== "string") {
    throw new Error(`OpenShell #2847 result has no stderr text: ${file}`);
  }
  const lines = result.stderr
    .replace(ANSI_ESCAPE, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const failure = lines.at(-1)?.match(REVISION_FAILURE);
  if (!failure || failure[2] !== expectedPass) {
    throw new Error(`OpenShell #2847 result has a different terminal diagnostic: ${file}`);
  }
  if (
    lines.length < 7 ||
    lines
      .slice(0, -1)
      .some(
        (line) => line !== "Preset not found: mcp-bridge-concurrent" && !POLICY_STATUS.test(line),
      )
  ) {
    throw new Error(`OpenShell #2847 result contains an unexpected diagnostic: ${file}`);
  }
  return failure[1];
}

export function assertOpenShell2847FailureEvidence(artifactDirectory: string): string {
  const root = path.resolve(artifactDirectory);
  const pass = path.basename(root).match(/^pass-([12])$/u)?.[1];
  if (!pass) throw new Error("OpenShell #2847 evidence directory must end in pass-1 or pass-2");

  const sandboxes = RESULT_BASENAMES.map((basename) =>
    commandSandbox(path.join(root, "mcp-bridge", "shell", basename), pass),
  );
  if (new Set(sandboxes).size !== 1) {
    throw new Error("OpenShell #2847 command results identify different sandboxes");
  }
  const sandbox = sandboxes[0];

  const signal = readJsonObject(path.join(root, "risk-signal.json"));
  const expectedSignal: JsonObject = {
    version: 1,
    jobId: "mcp-bridge",
    shardId: "openclaw",
    passed: 0,
    failed: 1,
    skipped: 0,
    pending: 0,
    unhandledErrors: 0,
    runReason: "failed",
  };
  if (
    Object.entries(expectedSignal).some(([key, value]) => signal[key] !== value) ||
    typeof signal.expectedSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(signal.expectedSha) ||
    signal.testedSha !== signal.expectedSha
  ) {
    throw new Error("OpenShell #2847 evidence has an unexpected E2E risk signal");
  }

  const cleanup = readJsonObject(path.join(root, "mcp-bridge", "cleanup.json"));
  if (
    !Array.isArray(cleanup.failures) ||
    cleanup.failures.length !== 0 ||
    !Array.isArray(cleanup.passed) ||
    !cleanup.passed.includes(`destroy sandbox ${sandbox}`)
  ) {
    throw new Error("OpenShell #2847 evidence does not confirm sandbox cleanup");
  }
  return sandbox;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const root = process.argv[2];
    if (!root || process.argv.length !== 3) {
      throw new Error(
        "Usage: npx tsx tools/e2e/assert-openshell-2847-mcp-failure.mts ARTIFACT_DIR",
      );
    }
    const sandbox = assertOpenShell2847FailureEvidence(root);
    console.log(
      `::warning title=OpenShell #2847::Accepted the exact provider credential revision failure for ${sandbox}. Remove this waiver after NVIDIA/OpenShell#2847 is released and pinned.`,
    );
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
