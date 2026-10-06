// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { observabilityProbeThreadId } from "../live/deepagents-observability-contract.ts";

const threadId = "01900000-0000-7000-8000-000000000001";
const turn = JSON.stringify({
  schema_version: 1,
  command: "non-interactive",
  data: { status: "success", completion: { thread_id: threadId } },
});
const deleted = (id: string, value: boolean) =>
  JSON.stringify({
    schema_version: 1,
    command: "threads delete",
    data: { thread_id: id, deleted: value },
  });

describe("observability probe conversation cleanup", () => {
  it("uses the exact native completion identity", () => {
    expect(observabilityProbeThreadId(turn)).toBe(threadId);
  });

  it.each([
    "not JSON",
    "null",
    JSON.stringify({ schema_version: 1, command: "threads list", data: {} }),
    JSON.stringify({
      schema_version: 1,
      command: "non-interactive",
      data: { completion: { thread_id: "--all" } },
    }),
    JSON.stringify({ schema_version: 1, command: "non-interactive", data: { completion: null } }),
  ])("refuses to select a conversation from invalid completion metadata (%s)", (output) => {
    expect(() => observabilityProbeThreadId(output)).toThrow();
  });

  it.each([
    [0, deleted(threadId, true), 0],
    [0, deleted(threadId, false), 0],
    [7, deleted(threadId, true), 7],
  ])(
    "accepts removed or absent probe threads and propagates native cleanup failure (%s/%s)",
    (nativeStatus, receipt, expectedStatus) => {
      const script = fs.readFileSync(
        "test/e2e/e2e-cloud-experimental/checks/11-deepagents-code-observability.sh",
        "utf8",
      );
      const cleanup = script.match(/^cleanup_probe_thread\(\) \{[\s\S]*?^\}/mu)?.[0];
      expect(cleanup).toBeDefined();
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${cleanup}
timeout() { shift 2; "$@"; }
openshell() {
  test "$*" = "sandbox exec --name test-sandbox -- dcode threads delete ${threadId} --json" || return 9
  printf '%s\\n' "$NATIVE_RECEIPT"
  return "$NATIVE_STATUS"
}
cleanup_probe_thread
`,
        ],
        {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            TSX: path.resolve("node_modules/.bin/tsx"),
            CONTRACT_HELPER: path.resolve("test/e2e/live/deepagents-observability-contract.ts"),
            SANDBOX_NAME: "test-sandbox",
            direct_output: turn,
            NATIVE_RECEIPT: receipt,
            NATIVE_STATUS: String(nativeStatus),
          },
        },
      );
      expect(result.status, result.stderr).toBe(expectedStatus);
    },
  );
});
