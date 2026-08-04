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

/** Every secret-shaped token the fixtures plant in exception or checkpoint text. */
const PLANTED_SECRETS =
  /runtime-secret|checkpoint-secret|private-request|private-model-message|private-tool-argument|private-tool-result/;

function persistedErrorDriver(rows: Record<string, string>, threadId: string): string {
  const inserts = Object.entries(rows)
    .map(
      ([thread, value]) =>
        `connection.execute("INSERT INTO writes (thread_id, channel, value) VALUES (?, '__error__', ?)", (${JSON.stringify(
          thread,
        )}, ${JSON.stringify(value)}))`,
    )
    .join("\n");
  return `
${runtimePreamble}
handle, db_path = tempfile.mkstemp()
os.close(handle)
target._NEMOCLAW_MANAGED_STATE_DB = db_path
target.generate_thread_id = lambda: ${JSON.stringify(threadId)}

connection = sqlite3.connect(db_path)
connection.execute("CREATE TABLE writes (thread_id TEXT, channel TEXT, value BLOB)")
${inserts}
connection.commit()
connection.close()

exit_code = asyncio.run(target.run_non_interactive("task"))
assert exit_code == 1
os.unlink(db_path)
`;
}

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
      "Model request failed: ResourceExhausted (category=upstream_provider_capacity " +
        "retryable=true correlation_id=thread-current)",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(PLANTED_SECRETS);
  });

  it("does not use a provider error from another thread (#7415)", () => {
    const result = runPatchedNonInteractive(
      persistedErrorDriver(
        {
          "thread-other":
            "APIError('ResourceExhausted: Worker local total request limit reached (32/32)')",
          "thread-current": "APIError('unrecognized backend condition')",
        },
        "thread-current",
      ),
    );

    expect(result.status).toBe(0);
    // The other thread's capacity row must never be borrowed; the unmatched row
    // for this thread falls through to the exception-type classifier.
    expect(result.stderr).toContain(
      "error_class=RemoteException category=agent_remote_failure retryable=false correlation_id=thread-current",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("upstream_provider_capacity");
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(PLANTED_SECRETS);
  });

  it("classifies transport and remote failures without claiming provider capacity (#8121)", () => {
    const cases = [
      [
        "APIConnectionError('connect to inference.local')",
        "Unavailable",
        "route_unreachable",
        "true",
      ],
      ["APITimeoutError('request exceeded budget')", "Timeout", "request_timeout", "true"],
      [
        "AuthenticationError('rejected at the managed route')",
        "Unauthorized",
        "authorization_rejected",
        "false",
      ],
      ["{'error': 'upstream', 'status_code': 429}", "RateLimited", "rate_limited", "true"],
      ["HTTP 503 from the managed route", "Unavailable", "route_unreachable", "true"],
      [
        "InternalServerError('an internal error occurred')",
        "InternalServerError",
        "remote_server_error",
        "true",
      ],
    ] as const;

    for (const [persisted, errorClass, category, retryable] of cases) {
      const result = runPatchedNonInteractive(
        persistedErrorDriver({ "thread-current": persisted }, "thread-current"),
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        `error_class=${errorClass} category=${category} retryable=${retryable} ` +
          "correlation_id=thread-current",
      );
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("upstream_provider_capacity");
      // The classification is a fixed vocabulary: no persisted text is echoed.
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(persisted);
    }
  });

  it("keeps an unrecognized persisted cause out of the provider-capacity class (#7415)", () => {
    const result = runPatchedNonInteractive(
      persistedErrorDriver({ "thread-policy": "APIError('policy returned 429')" }, "thread-policy"),
    );

    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("upstream_provider_capacity");
    expect(result.stderr).toContain("correlation_id=thread-policy");
  });

  it("does not classify a supported name quoted inside payload content (#8121)", () => {
    // Every name the classifiers support, placed where a model or tool payload
    // would put it rather than where a serializer would. None may classify: the
    // quoted text is the model's words, not the failure. (PRA-1 blocker)
    const supportedNames = [
      "ResourceExhausted",
      "RateLimitError",
      "TooManyRequests",
      "AuthenticationError",
      "PermissionDeniedError",
      "PermissionDenied",
      "Unauthenticated",
      "NotFoundError",
      "ModelNotFoundError",
      "model_not_found",
      "APITimeoutError",
      "DeadlineExceeded",
      "ReadTimeout",
      "ConnectTimeout",
      "TimeoutError",
      "APIConnectionError",
      "ClientConnectorError",
      "ProxyError",
      "SSLCertVerificationError",
      "SSLError",
      "ConnectionRefusedError",
      "ConnectionResetError",
      "InternalServerError",
      "ServiceUnavailable",
      "BadGateway",
    ];
    const quoted = supportedNames.map((name) => `APIError('tool output: ${name}')`);
    quoted.push("APIError('tool said status_code=429')");

    for (const persisted of quoted) {
      const result = runPatchedNonInteractive(
        persistedErrorDriver({ "thread-quoted": persisted }, "thread-quoted"),
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        "error_class=RemoteException category=agent_remote_failure retryable=false " +
          "correlation_id=thread-quoted",
      );
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(persisted);
    }
  });

  it("classifies a supported name in serialized position (#8121)", () => {
    // The counterpart to the quoted-payload case: the same names classify when
    // a serializer wrote them, including nested inside an outer exception repr.
    const cases = [
      [
        "APIError('ResourceExhausted: Worker local total request limit reached (32/32)')",
        "ResourceExhausted",
        "upstream_provider_capacity",
      ],
      ["ResourceExhausted: capacity exceeded", "ResourceExhausted", "upstream_provider_capacity"],
      ["openai.RateLimitError: rate limit exceeded", "RateLimited", "rate_limited"],
    ] as const;

    for (const [persisted, errorClass, category] of cases) {
      const result = runPatchedNonInteractive(
        persistedErrorDriver({ "thread-serialized": persisted }, "thread-serialized"),
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(`error_class=${errorClass} category=${category} `);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(persisted);
    }
  });

  it("does not classify prose quoted from model or tool output (#8121)", () => {
    // Each row carries a classifier word only inside quoted content, with no
    // exception name and no named status field, so the checkpoint text must
    // stay unclassified and the exception-type fallback must decide instead.
    const prose = [
      "APIError('tool output: timeout')",
      "APIError('the model replied: connection refused')",
      "APIError('assistant said the request was unauthorized')",
      "APIError('tool result contained 429 items')",
      "APIError('shell output: rate limit documentation')",
    ];

    for (const persisted of prose) {
      const result = runPatchedNonInteractive(
        persistedErrorDriver({ "thread-prose": persisted }, "thread-prose"),
      );

      expect(result.status).toBe(0);
      // The RemoteException fallback classification is the only verdict here:
      // no transport, timeout, authorization, or rate-limit claim is made.
      expect(result.stderr).toContain(
        "error_class=RemoteException category=agent_remote_failure retryable=false " +
          "correlation_id=thread-prose",
      );
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(persisted);
    }
  });

  it("classifies the raised exception type when no checkpoint row explains it (#8121)", () => {
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
      "error_class=RemoteException category=agent_remote_failure retryable=false " +
        "correlation_id=thread-no-diagnostics",
    );
    expect(result.stdout).toContain(
      "Model request failed: RemoteException (category=agent_remote_failure " +
        "retryable=false correlation_id=thread-no-diagnostics)",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(PLANTED_SECRETS);
  });

  it("classifies a chained transport cause behind an opaque wrapper (#8121)", () => {
    const result = runPatchedNonInteractive(`
${runtimePreamble}
handle, db_path = tempfile.mkstemp()
os.close(handle)
target._NEMOCLAW_MANAGED_STATE_DB = db_path
target.generate_thread_id = lambda: "thread-chained"


class OpaqueWrapper(Exception):
    pass


async def fail_chained(*args, **kwargs):
    del args, kwargs
    try:
        raise ConnectionRefusedError("connect to inference.local token=runtime-secret")
    except ConnectionRefusedError as cause:
        raise OpaqueWrapper("wrapped token=runtime-secret") from cause


target._run_non_interactive_impl = fail_chained

exit_code = asyncio.run(target.run_non_interactive("task"))
assert exit_code == 1
os.unlink(db_path)
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "error_class=Unavailable category=route_unreachable retryable=true " +
        "correlation_id=thread-chained",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(PLANTED_SECRETS);
  });

  it("leaves an unlisted exception type unknown instead of echoing its name (#8121)", () => {
    const result = runPatchedNonInteractive(`
${runtimePreamble}
handle, db_path = tempfile.mkstemp()
os.close(handle)
target._NEMOCLAW_MANAGED_STATE_DB = db_path
target.generate_thread_id = lambda: "thread-unlisted"


class SomeVendorSpecificFailure_runtime_secret(Exception):
    pass


async def fail_unlisted(*args, **kwargs):
    del args, kwargs
    raise SomeVendorSpecificFailure_runtime_secret("token=runtime-secret")


target._run_non_interactive_impl = fail_unlisted

exit_code = asyncio.run(target.run_non_interactive("task"))
assert exit_code == 1
os.unlink(db_path)
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "error_class=unknown category=unknown retryable=false correlation_id=thread-unlisted",
    );
    expect(result.stdout).toContain("Unexpected error (correlation_id=thread-unlisted)");
    // The observable contract is that the class name itself never reaches the
    // output, not merely that the planted token does not.
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      "SomeVendorSpecificFailure_runtime_secret",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(PLANTED_SECRETS);
  });
});
