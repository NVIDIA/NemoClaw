// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patchFixture,
} from "./helpers/langchain-deepagents-code-patch-fixture";

type ManagedNonInteractiveEnvelope = {
  schema: string;
  schemaVersion: number;
  command: string;
  mode: string;
  status: string;
  exit: {
    code: number;
    classification: string;
  };
  response: string;
  completion: {
    threadId: string | null;
    durationMs: number;
    responseBytes: number;
    responseComplete: boolean;
    outputLimitBytes: number;
  };
  failure: { reason: string } | null;
};

function parseManagedNonInteractiveEnvelope(stdout: string): ManagedNonInteractiveEnvelope {
  return JSON.parse(stdout) as ManagedNonInteractiveEnvelope;
}

afterEach(cleanupPackageFixtures);

describe("LangChain Deep Agents Code managed non-interactive JSON", () => {
  it("emits one envelope while progress and tool diagnostics use stderr (#7773)", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const result = spawnSync(
      "python3",
      [
        "-m",
        "deepagents_code",
        "-n",
        "fixture-json-success",
        "--json",
        "--max-turns",
        "1",
        "--timeout",
        "5",
      ],
      {
        env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("fixture progress");
    expect(result.stderr).toContain("fixture tool use: read_file");
    expect(result.stdout).not.toContain("fixture progress");
    expect(result.stdout).not.toContain("fixture tool use");
    const envelope = parseManagedNonInteractiveEnvelope(result.stdout);
    expect(envelope).toEqual({
      schema: "nemoclaw.dcode.non-interactive-result",
      schemaVersion: 1,
      command: "dcode",
      mode: "non-interactive",
      status: "succeeded",
      exit: { code: 0, classification: "success" },
      response: "PONG",
      completion: {
        threadId: "thread-1",
        durationMs: expect.any(Number),
        responseBytes: 4,
        responseComplete: true,
        outputLimitBytes: 1_048_576,
      },
      failure: null,
    });
    expect(envelope.completion.durationMs).toBeGreaterThanOrEqual(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(
      envelope.completion.outputLimitBytes,
    );
  });

  it.each([
    {
      message: "fixture-json-process-failure",
      expectedExit: 1,
      expectedStatus: "failed",
      expectedClassification: "process_failure",
      timeout: "5",
    },
    {
      message: "fixture-json-timeout",
      expectedExit: 124,
      expectedStatus: "timed_out",
      expectedClassification: "timeout",
      timeout: "1",
    },
    {
      message: "fixture-json-turn-limit",
      expectedExit: 124,
      expectedStatus: "timed_out",
      expectedClassification: "timeout",
      timeout: "5",
    },
  ])("preserves $expectedClassification exit behavior in the envelope (#7773)", ({
    message,
    expectedExit,
    expectedStatus,
    expectedClassification,
    timeout,
  }) => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const result = spawnSync(
      "python3",
      ["-m", "deepagents_code", "-n", message, "--json", "--timeout", timeout],
      {
        env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
        encoding: "utf8",
        timeout: 5_000,
      },
    );

    expect(result.status, result.stderr).toBe(expectedExit);
    const envelope = parseManagedNonInteractiveEnvelope(result.stdout);
    expect(envelope.status).toBe(expectedStatus);
    expect(envelope.exit).toEqual({
      code: expectedExit,
      classification: expectedClassification,
    });
    expect(envelope.response).toBe("");
    expect(envelope.completion.responseComplete).toBe(false);
  });

  it("classifies an agent error without exposing its diagnostic on stdout (#7773)", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import sys
from deepagents_code.client import non_interactive
from deepagents_code.main import cli_main

non_interactive._nemoclaw_classify_persisted_error = lambda _thread_id: (
    "ProviderError",
    "agent_failure",
    "false",
)
sys.argv = [
    "dcode",
    "-n",
    "fixture-json-process-failure",
    "--json",
    "--timeout",
    "5",
]
cli_main()
`,
      ],
      {
        env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(1);
    const envelope = parseManagedNonInteractiveEnvelope(result.stdout);
    expect(envelope.status).toBe("failed");
    expect(envelope.exit).toEqual({ code: 1, classification: "agent_failure" });
    expect(envelope.response).toBe("");
    expect(result.stdout).not.toContain("ProviderError");
    expect(result.stderr).toContain("ProviderError");
  });

  it.each([
    { message: "fixture-json-output-limit", reason: "output_limit_exceeded" },
    { message: "fixture-json-unframed", reason: "unframed_stdout" },
  ])("returns a bounded $reason envelope (#7773)", ({ message, reason }) => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const result = spawnSync(
      "python3",
      ["-m", "deepagents_code", "-n", message, "--json", "--timeout", "5"],
      {
        env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(1);
    const envelope = parseManagedNonInteractiveEnvelope(result.stdout);
    expect(envelope.exit).toEqual({ code: 1, classification: "process_failure" });
    expect(envelope.response).toBe("");
    expect(envelope.failure).toEqual({ reason });
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(
      envelope.completion.outputLimitBytes,
    );
  });

  it("emits a cancelled envelope before the task propagates cancellation (#7773)", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import asyncio
from deepagents_code.client import non_interactive

async def run():
    task = asyncio.create_task(
        non_interactive.run_non_interactive(
            message="fixture-json-timeout",
            assistant_id="assistant",
            quiet=True,
            stream=False,
            _nemoclaw_json_output=True,
            _nemoclaw_json_timeout=None,
        )
    )
    await asyncio.sleep(0.01)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        raise SystemExit(130)

asyncio.run(run())
`,
      ],
      {
        env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(130);
    const envelope = parseManagedNonInteractiveEnvelope(result.stdout);
    expect(envelope.status).toBe("cancelled");
    expect(envelope.exit).toEqual({ code: 130, classification: "cancelled" });
    expect(envelope.completion.responseComplete).toBe(false);
  });
});
