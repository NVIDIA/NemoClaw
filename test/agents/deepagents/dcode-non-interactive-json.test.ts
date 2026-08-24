// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patchFixture,
} from "../../helpers/langchain-deepagents-code-patch-fixture";

afterEach(cleanupPackageFixtures);

type JsonEnvelope = {
  schema_version: number;
  command: string;
  data: {
    status: string;
    exit_code: number;
    response: string | null;
    completion: {
      thread_id: string | null;
      duration_ms: number;
      response_bytes: number;
    };
  };
};

function runDriver(driver: string) {
  const tempDir = createPackageFixture();
  patchFixture(tempDir);
  return spawnSync("python3", ["-c", driver], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      PYTHONPATH: tempDir,
    },
    timeout: 10_000,
  });
}

function parseEnvelope(stdout: string): JsonEnvelope {
  return JSON.parse(stdout) as JsonEnvelope;
}

const preamble = `
import asyncio
from deepagents_code.client import non_interactive as target
`;

describe("managed DCode non-interactive JSON output", () => {
  it("forwards the public --json flag through the non-interactive CLI (#7773)", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const result = spawnSync(
      "python3",
      ["-m", "deepagents_code", "-n", "fixture-json-task", "--json"],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          PYTHONPATH: tempDir,
        },
        timeout: 10_000,
      },
    );

    expect(result.status).toBe(0);
    expect(parseEnvelope(result.stdout).data).toMatchObject({
      status: "success",
      exit_code: 0,
      response: "",
    });
  });

  it("emits one versioned success envelope with exact assistant text (#7773)", () => {
    const result = runDriver(`
${preamble}
async def succeed(*args, **kwargs):
    del args, kwargs
    target._write_text('hello "')
    target._write_text("雪\\n")
    return 0

target._run_non_interactive_impl = succeed
exit_code = asyncio.run(
    target.run_non_interactive(
        "task",
        output_format="json",
        timeout_seconds=None,
    )
)
assert exit_code == 0
`);

    expect(result.status).toBe(0);
    const envelope = parseEnvelope(result.stdout);
    expect(envelope).toEqual({
      schema_version: 1,
      command: "non-interactive",
      data: {
        status: "success",
        exit_code: 0,
        response: 'hello "雪\n',
        completion: {
          thread_id: "thread-1",
          duration_ms: expect.any(Number),
          response_bytes: Buffer.byteLength('hello "雪\n'),
        },
      },
    });
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("suppresses progress output without corrupting the success envelope (#7773)", () => {
    const result = runDriver(`
${preamble}
async def succeed(*args, **kwargs):
    del args, kwargs
    print("progress that must not reach stdout")
    target._write_text("PONG")
    return 0

target._run_non_interactive_impl = succeed
exit_code = asyncio.run(target.run_non_interactive("task", output_format="json"))
assert exit_code == 0
`);

    expect(result.status).toBe(0);
    expect(parseEnvelope(result.stdout).data).toMatchObject({
      status: "success",
      exit_code: 0,
      response: "PONG",
    });
    expect(result.stdout).not.toContain("progress");
    expect(result.stderr).toContain("suppressed unexpected stdout");
  });

  it("suppresses direct and child-process writes to stdout (#7773)", () => {
    const result = runDriver(`
${preamble}
import os
import subprocess
import sys

async def succeed(*args, **kwargs):
    del args, kwargs
    os.write(1, b"direct descriptor output")
    subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; sys.stdout.buffer.write(b'child output' * 200000)",
        ],
        check=True,
    )
    target._write_text("PONG")
    return 0

target._run_non_interactive_impl = succeed
exit_code = asyncio.run(target.run_non_interactive("task", output_format="json"))
assert exit_code == 0
`);

    expect(result.status).toBe(0);
    expect(parseEnvelope(result.stdout).data).toMatchObject({
      status: "success",
      exit_code: 0,
      response: "PONG",
    });
    expect(result.stdout).not.toContain("descriptor output");
    expect(result.stdout).not.toContain("child output");
    expect(result.stderr).toContain("suppressed unexpected stdout");
  });

  it.each([
    ["agent_failure", "target._run_non_interactive_impl = fail_agent", 1],
    ["process_failure", "target._nemoclaw_original_run_non_interactive = fail_process", 1],
    ["turn_limit", "target._run_non_interactive_impl = finish_at_limit", 124],
  ])("emits a null response for %s (#7773)", (expectedStatus, setup, expectedExit) => {
    const result = runDriver(`
${preamble}
async def fail_agent(*args, **kwargs):
    del args, kwargs
    raise RuntimeError("private failure detail")

async def fail_process(*args, **kwargs):
    del args, kwargs
    raise RuntimeError("private process detail")

async def finish_at_limit(*args, **kwargs):
    del args, kwargs
    return 124

${setup}
exit_code = asyncio.run(target.run_non_interactive("task", output_format="json"))
assert exit_code == ${expectedExit}
`);

    expect(result.status).toBe(0);
    expect(parseEnvelope(result.stdout).data).toMatchObject({
      status: expectedStatus,
      exit_code: expectedExit,
      response: null,
      completion: {
        response_bytes: 0,
      },
    });
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("private");
  });

  it("classifies cancellation and timeout independently (#7773)", () => {
    const cancelled = runDriver(`
${preamble}
async def wait_forever(*args, **kwargs):
    del args, kwargs
    await asyncio.sleep(60)

async def main():
    target._run_non_interactive_impl = wait_forever
    task = asyncio.create_task(
        target.run_non_interactive("task", output_format="json")
    )
    await asyncio.sleep(0)
    task.cancel()
    assert await task == 130

asyncio.run(main())
`);
    const timedOut = runDriver(`
${preamble}
async def wait_forever(*args, **kwargs):
    del args, kwargs
    await asyncio.sleep(60)

target._run_non_interactive_impl = wait_forever
exit_code = asyncio.run(
    target.run_non_interactive(
        "task",
        output_format="json",
        timeout_seconds=0.01,
    )
)
assert exit_code == 124
`);

    expect(cancelled.status).toBe(0);
    expect(parseEnvelope(cancelled.stdout).data).toMatchObject({
      status: "cancelled",
      exit_code: 130,
      response: null,
    });
    expect(timedOut.status).toBe(0);
    expect(parseEnvelope(timedOut.stdout).data).toMatchObject({
      status: "timeout",
      exit_code: 124,
      response: null,
    });
  });

  it("returns a bounded output-limit envelope instead of partial text (#7773)", () => {
    const result = runDriver(`
${preamble}
async def overflow(*args, **kwargs):
    del args, kwargs
    target._write_text("x" * 300)
    return 0

target._NEMOCLAW_JSON_MAX_BYTES = 512
target._NEMOCLAW_JSON_ENVELOPE_RESERVE_BYTES = 256
target._run_non_interactive_impl = overflow
exit_code = asyncio.run(target.run_non_interactive("task", output_format="json"))
assert exit_code == 1
`);

    expect(result.status).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(512);
    expect(parseEnvelope(result.stdout).data).toMatchObject({
      status: "output_limit",
      exit_code: 1,
      response: null,
      completion: {
        response_bytes: 0,
      },
    });
    expect(result.stdout).not.toContain("x".repeat(100));
  });

  it("preserves the existing text-mode stdout contract (#7773)", () => {
    const result = runDriver(`
${preamble}
async def succeed(*args, **kwargs):
    del args, kwargs
    target._write_text("PONG")
    return 0

target._run_non_interactive_impl = succeed
exit_code = asyncio.run(target.run_non_interactive("task"))
assert exit_code == 0
`);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("PONG");
  });
});
