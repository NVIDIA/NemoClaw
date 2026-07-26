// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patchFixture,
} from "./helpers/langchain-deepagents-code-patch-fixture";

afterEach(cleanupPackageFixtures);

function runPatchedNonInteractive(driver: string) {
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

const runtimePreamble = `
import asyncio
import logging
import os
import sqlite3
import tempfile

from deepagents_code.client import non_interactive as target

logging.basicConfig(level=logging.WARNING, format="%(message)s")


class RemoteException(Exception):
    pass


async def fail(*args, **kwargs):
    del args, kwargs
    raise RemoteException("remote failure token=runtime-secret")


target._run_non_interactive_impl = fail
`;

describe("managed non-interactive error reporting", () => {
  it("reports the provider-capacity error persisted for the failing thread (#7415)", () => {
    const result = runPatchedNonInteractive(`
${runtimePreamble}
handle, db_path = tempfile.mkstemp()
os.close(handle)
target._NEMOCLAW_MANAGED_STATE_DB = db_path
target.generate_thread_id = lambda: "thread-current"

connection = sqlite3.connect(db_path)
connection.execute("CREATE TABLE writes (thread_id TEXT, channel TEXT, value BLOB)")
connection.execute(
    "INSERT INTO writes (thread_id, channel, value) VALUES (?, ?, ?)",
    (
        "thread-current",
        "__error__",
        sqlite3.Binary(
            b"APIError('ResourceExhausted: Worker local total request limit reached "
            b"(32/32) token=checkpoint-secret request_body=private-request "
            b"model_message=private-model-message "
            b"tool_argument=private-tool-argument "
            b"tool_result=private-tool-result')"
        ),
    ),
)
connection.commit()
connection.close()

exit_code = asyncio.run(target.run_non_interactive("task"))
assert exit_code == 1
os.unlink(db_path)
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "error_class=ResourceExhausted category=upstream_provider_capacity retryable=true correlation_id=thread-current",
    );
    expect(result.stdout).toContain(
      "Model request failed: ResourceExhausted (correlation_id=thread-current)",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
      /runtime-secret|checkpoint-secret|private-request|private-model-message|private-tool-argument|private-tool-result/,
    );
  });

  it("does not use a provider error from another thread (#7415)", () => {
    const result = runPatchedNonInteractive(`
${runtimePreamble}
handle, db_path = tempfile.mkstemp()
os.close(handle)
target._NEMOCLAW_MANAGED_STATE_DB = db_path
target.generate_thread_id = lambda: "thread-current"

connection = sqlite3.connect(db_path)
connection.execute("CREATE TABLE writes (thread_id TEXT, channel TEXT, value BLOB)")
connection.execute(
    "INSERT INTO writes (thread_id, channel, value) VALUES (?, ?, ?)",
    (
        "thread-other",
        "__error__",
        "APIError('ResourceExhausted: Worker local total request limit reached (32/32)')",
    ),
)
connection.execute(
    "INSERT INTO writes (thread_id, channel, value) VALUES (?, ?, ?)",
    ("thread-current", "__error__", "APIError('MCP connection refused')"),
)
connection.commit()
connection.close()

exit_code = asyncio.run(target.run_non_interactive("task"))
assert exit_code == 1
os.unlink(db_path)
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "error_class=unknown category=unknown retryable=false correlation_id=thread-current",
    );
    expect(result.stdout).toContain("Unexpected error (correlation_id=thread-current)");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("upstream_provider_capacity");
  });

  it("keeps MCP, gateway, and policy errors unknown (#7415)", () => {
    const result = runPatchedNonInteractive(`
${runtimePreamble}
handle, db_path = tempfile.mkstemp()
os.close(handle)
target._NEMOCLAW_MANAGED_STATE_DB = db_path

connection = sqlite3.connect(db_path)
connection.execute("CREATE TABLE writes (thread_id TEXT, channel TEXT, value BLOB)")
errors = {
    "thread-mcp": "APIError('MCP connection refused')",
    "thread-gateway": "APIError('gateway timeout')",
    "thread-policy": "APIError('policy returned 429')",
}
connection.executemany(
    "INSERT INTO writes (thread_id, channel, value) VALUES (?, '__error__', ?)",
    errors.items(),
)
connection.commit()
connection.close()

for thread_id in errors:
    target.generate_thread_id = lambda current=thread_id: current
    exit_code = asyncio.run(target.run_non_interactive("task"))
    assert exit_code == 1

os.unlink(db_path)
`);

    expect(result.status).toBe(0);
    expect(result.stderr.match(/error_class=unknown/g)).toHaveLength(3);
    expect(result.stdout.match(/Unexpected error/g)).toHaveLength(3);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("upstream_provider_capacity");
  });

  it("sanitizes unknown failures when checkpoint diagnostics are unavailable (#7415)", () => {
    const result = runPatchedNonInteractive(`
${runtimePreamble}
handle, db_path = tempfile.mkstemp()
os.close(handle)
target._NEMOCLAW_MANAGED_STATE_DB = db_path
target.generate_thread_id = lambda: "thread-no-diagnostics"

exit_code = asyncio.run(target.run_non_interactive("task"))
assert exit_code == 1
os.unlink(db_path)
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "error_class=unknown category=unknown retryable=false correlation_id=thread-no-diagnostics",
    );
    expect(result.stdout).toContain("Unexpected error (correlation_id=thread-no-diagnostics)");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("runtime-secret");
  });
});
