// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  inferenceResponseModel,
  inferenceSetAttemptCount,
  isTransientInferenceSetFailure,
  runInferenceSetWithRetry,
  writeInferenceSwitchRetryEvidence,
} from "../fixtures/inference-switch-retry.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

function result(exitCode: number, stderr = ""): ShellProbeResult {
  return {
    artifacts: { result: "", stderr: "", stdout: "" },
    command: [],
    exitCode,
    signal: null,
    stderr,
    stdout: "",
    timedOut: false,
  };
}

describe("inference switch retry", () => {
  it("reads only the top-level response model used for route proof", () => {
    expect(inferenceResponseModel('{"model":"target-model"}')).toBe("target-model");
    expect(inferenceResponseModel('{"model":null}')).toBe("");
    expect(inferenceResponseModel('{"choices":[{"model":"nested-model"}]}')).toBe("");
  });

  it("retries transient verification failures and preserves verification", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(result(1, "failed to verify inference endpoint: timeout"))
      .mockResolvedValueOnce(result(0));
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(runInferenceSetWithRetry({ attempts: 3, delay, run })).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(run.mock.calls).toEqual([
      [1, true],
      [2, true],
    ]);
    expect(delay).toHaveBeenCalledWith(5_000);
  });

  it("retains degraded evidence when a transient verification passes after retry", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(result(1, "failed to verify inference endpoint: timeout"))
      .mockResolvedValueOnce(result(0));
    const writeJson = vi.fn().mockResolvedValue("inference-switch-retry-evidence.json");

    await runInferenceSetWithRetry({
      attempts: 2,
      delay: async () => {},
      run,
      onEvidence: (evidence) => writeInferenceSwitchRetryEvidence({ writeJson }, evidence),
    });

    expect(writeJson).toHaveBeenCalledWith(
      "inference-switch-retry-evidence.json",
      expect.objectContaining({
        outcome: "passed-after-retry",
        attempts: [
          expect.objectContaining({ failureClass: "transient-external", retryScheduled: true }),
          expect.objectContaining({ outcome: "passed", retryScheduled: false }),
        ],
      }),
    );
  });

  it("keeps exhausted verified attempts failed without bypassing verification", async () => {
    const transient = result(1, "failed to connect to endpoint");
    const run = vi.fn().mockResolvedValueOnce(transient).mockResolvedValueOnce(transient);
    const writeJson = vi.fn().mockResolvedValue("inference-switch-retry-evidence.json");

    await expect(
      runInferenceSetWithRetry({
        attempts: 2,
        delay: async () => {},
        onEvidence: (evidence) => writeInferenceSwitchRetryEvidence({ writeJson }, evidence),
        run,
      }),
    ).resolves.toMatchObject({ exitCode: 1 });
    expect(run.mock.calls).toEqual([
      [1, true],
      [2, true],
    ]);
    expect(writeJson).toHaveBeenCalledWith(
      "inference-switch-retry-evidence.json",
      expect.objectContaining({
        outcome: "exhausted",
        attempts: [
          expect.objectContaining({ failureClass: "transient-external", retryScheduled: true }),
          expect.objectContaining({ failureClass: "transient-external", retryScheduled: false }),
        ],
      }),
    );
  });

  it("keeps the shell helper failed on exhaustion without adding a verification bypass", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-inference-retry-"));
    const invocationLog = path.join(tempDir, "invocations.log");
    const helper = path.resolve("test/e2e/lib/inference-switch-retry.sh");
    const harness = String.raw`
source "$1"
sleep() { :; }
fake_inference_set() {
  printf '%s\n' "$*" >> "$INVOCATION_LOG"
  printf 'failed to verify inference endpoint: timeout\n' >&2
  return 17
}
rc=0
NEMOCLAW_SWITCH_SET_ATTEMPTS=2 run_inference_set_with_retry fake_inference_set provider set --model target || rc=$?
printf 'terminal_rc=%s\n' "$rc"
`;

    try {
      const result = spawnSync("bash", ["-s", "--", helper], {
        encoding: "utf8",
        env: { ...process.env, INVOCATION_LOG: invocationLog },
        input: harness,
      });
      expect(result.status, result.stderr).toBe(0);
      const invocations = fs.readFileSync(invocationLog, "utf8").trim().split("\n");
      expect(result.stdout).toContain("terminal_rc=17");
      expect(invocations).toEqual(["provider set --model target", "provider set --model target"]);
      expect(invocations.join(" ")).not.toContain("--no-verify");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("does not bypass non-transient verification failures", async () => {
    const run = vi.fn().mockResolvedValue(result(1, "invalid provider"));

    await expect(
      runInferenceSetWithRetry({ attempts: 3, delay: async () => {}, run }),
    ).resolves.toMatchObject({ exitCode: 1 });
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(1, true);
  });

  it("does not retry a deterministic verification mismatch", async () => {
    const run = vi
      .fn()
      .mockResolvedValue(result(1, "failed to verify inference endpoint: model mismatch"));

    await runInferenceSetWithRetry({ attempts: 3, delay: async () => {}, run });
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps mixed terminal verification failures out of the TypeScript retry path", () => {
    expect(isTransientInferenceSetFailure(result(1, "authentication failed after timeout"))).toBe(
      false,
    );
    expect(isTransientInferenceSetFailure(result(1, "authorization failed after ECONNRESET"))).toBe(
      false,
    );
    expect(
      isTransientInferenceSetFailure(result(1, "denied by network policy after ETIMEDOUT")),
    ).toBe(false);
    expect(isTransientInferenceSetFailure(result(1, "malformed request after timeout"))).toBe(
      false,
    );
    expect(isTransientInferenceSetFailure(result(1, "model mismatch after timeout"))).toBe(false);
    expect(isTransientInferenceSetFailure(result(1, "route mismatch after ECONNRESET"))).toBe(
      false,
    );
    expect(isTransientInferenceSetFailure(result(1, "verification mismatch after timeout"))).toBe(
      false,
    );
  });

  it("keeps mixed terminal verification failures out of the shell retry path", () => {
    const helper = path.resolve("test/e2e/lib/inference-switch-retry.sh");
    const harness = String.raw`
source "$1"
for output in \
  "authentication failed after timeout" \
  "authorization failed after ECONNRESET" \
  "denied by network policy after ETIMEDOUT" \
  "malformed request after timeout" \
  "model mismatch after timeout" \
  "route mismatch after ECONNRESET" \
  "verification mismatch after timeout"; do
  if is_transient_inference_set_failure "$output"; then
    printf 'misclassified=%s\n' "$output"
    exit 91
  fi
done
`;
    const probe = spawnSync("bash", ["-s", "--", helper], {
      encoding: "utf8",
      input: harness,
    });
    expect(probe.status, `${probe.stdout}\n${probe.stderr}`).toBe(0);
  });

  it("validates the configured attempt count", () => {
    expect(inferenceSetAttemptCount(undefined)).toBe(3);
    expect(inferenceSetAttemptCount("2")).toBe(2);
    expect(() => inferenceSetAttemptCount("0")).toThrow(/between 1 and 10/u);
    expect(() => inferenceSetAttemptCount("11")).toThrow(/between 1 and 10/u);
  });
});
