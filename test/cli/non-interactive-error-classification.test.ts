// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patchFixture,
} from "../helpers/langchain-deepagents-code-patch-fixture";

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
import ssl

import httpx
from deepagents_code import model_config
from deepagents_code.client import non_interactive as target
from langgraph_sdk import errors as graph_errors

logging.basicConfig(level=logging.WARNING, format="%(message)s")
`;

const PLANTED_SECRETS = /runtime-secret|checkpoint-secret|private-model-message/;

function activeExceptionCasesDriver(
  cases: ReadonlyArray<readonly [string, string, string, string]>,
): string {
  const pythonCases = cases
    .map(
      ([exceptionExpression], index) =>
        `(${exceptionExpression}, ${JSON.stringify(`thread-trusted-${index}`)})`,
    )
    .join(",\n    ");

  return `
${runtimePreamble}
cases = [
    ${pythonCases}
]
assert set(target._NEMOCLAW_EXCEPTION_CLASSIFIERS) == {
    type(exception) for exception, _thread_id in cases
}


for exception, thread_id in cases:
    target.generate_thread_id = lambda thread_id=thread_id: thread_id

    async def fail(*args, _exception=exception, **kwargs):
        del args, kwargs
        raise _exception

    target._run_non_interactive_impl = fail
    exit_code = asyncio.run(target.run_non_interactive("task"))
    assert exit_code == 1
`;
}

function messagePackStringHex(value: string): string {
  const payload = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from([0xd9, payload.length]), payload]).toString("hex");
}

function persistedForgeryDriver(
  activeException: string,
  persistedRepr: string,
  threadId: string,
): string {
  return `
${runtimePreamble}
import os
import sqlite3
import tempfile

handle, db_path = tempfile.mkstemp()
os.close(handle)
target._NEMOCLAW_MANAGED_STATE_DB = db_path
target.generate_thread_id = lambda: ${JSON.stringify(threadId)}

connection = sqlite3.connect(db_path)
connection.execute("CREATE TABLE writes (thread_id TEXT, channel TEXT, type TEXT, value BLOB)")
connection.execute(
    "INSERT INTO writes (thread_id, channel, type, value) VALUES (?, '__error__', ?, ?)",
    (
        ${JSON.stringify(threadId)},
        "msgpack",
        sqlite3.Binary(bytes.fromhex(${JSON.stringify(messagePackStringHex(persistedRepr))})),
    ),
)
connection.commit()
connection.close()


async def fail(*args, **kwargs):
    del args, kwargs
    raise ${activeException}


target._run_non_interactive_impl = fail
exit_code = asyncio.run(target.run_non_interactive("task"))
assert exit_code == 1
os.unlink(db_path)
`;
}

describe("managed non-interactive error reporting", () => {
  it("classifies every trusted exact exception type (#8121)", () => {
    const cases = [
      [
        "graph_errors.RateLimitError('token=runtime-secret')",
        "RateLimited",
        "rate_limited",
        "true",
      ],
      [
        "graph_errors.AuthenticationError('token=runtime-secret')",
        "Unauthorized",
        "authorization_rejected",
        "false",
      ],
      [
        "graph_errors.PermissionDeniedError('token=runtime-secret')",
        "Unauthorized",
        "authorization_rejected",
        "false",
      ],
      [
        "graph_errors.NotFoundError('token=runtime-secret')",
        "NotFound",
        "model_or_route_not_found",
        "false",
      ],
      [
        "graph_errors.APITimeoutError('token=runtime-secret')",
        "Timeout",
        "request_timeout",
        "true",
      ],
      [
        "graph_errors.APIConnectionError('token=runtime-secret')",
        "Unavailable",
        "route_unreachable",
        "true",
      ],
      [
        "graph_errors.InternalServerError('token=runtime-secret')",
        "InternalServerError",
        "remote_server_error",
        "true",
      ],
      [
        "graph_errors.APIStatusError('token=runtime-secret')",
        "APIError",
        "agent_remote_failure",
        "false",
      ],
      [
        "graph_errors.APIError('token=runtime-secret')",
        "APIError",
        "agent_remote_failure",
        "false",
      ],
      ["httpx.ConnectTimeout('token=runtime-secret')", "Timeout", "request_timeout", "true"],
      ["httpx.ReadTimeout('token=runtime-secret')", "Timeout", "request_timeout", "true"],
      ["httpx.WriteTimeout('token=runtime-secret')", "Timeout", "request_timeout", "true"],
      ["httpx.PoolTimeout('token=runtime-secret')", "Timeout", "request_timeout", "true"],
      ["httpx.ConnectError('token=runtime-secret')", "Unavailable", "route_unreachable", "true"],
      ["httpx.ReadError('token=runtime-secret')", "Unavailable", "route_unreachable", "true"],
      ["httpx.WriteError('token=runtime-secret')", "Unavailable", "route_unreachable", "true"],
      ["httpx.CloseError('token=runtime-secret')", "Unavailable", "route_unreachable", "true"],
      ["httpx.ProxyError('token=runtime-secret')", "Unavailable", "route_unreachable", "true"],
      [
        "ssl.SSLCertVerificationError('token=runtime-secret')",
        "Unavailable",
        "route_unreachable",
        "true",
      ],
      ["ssl.SSLError('token=runtime-secret')", "Unavailable", "route_unreachable", "true"],
      ["TimeoutError('token=runtime-secret')", "Timeout", "request_timeout", "true"],
      ["ConnectionError('token=runtime-secret')", "Unavailable", "route_unreachable", "true"],
      [
        "ConnectionAbortedError('token=runtime-secret')",
        "Unavailable",
        "route_unreachable",
        "true",
      ],
      [
        "ConnectionRefusedError('token=runtime-secret')",
        "Unavailable",
        "route_unreachable",
        "true",
      ],
      ["ConnectionResetError('token=runtime-secret')", "Unavailable", "route_unreachable", "true"],
      ["BrokenPipeError('token=runtime-secret')", "Unavailable", "route_unreachable", "true"],
      [
        "model_config.ModelConfigError('token=runtime-secret')",
        "ModelConfigError",
        "model_configuration",
        "false",
      ],
      [
        "model_config.NoCredentialsConfiguredError('token=runtime-secret')",
        "ModelConfigError",
        "model_configuration",
        "false",
      ],
      [
        "model_config.UnknownProviderError('token=runtime-secret')",
        "ModelConfigError",
        "model_configuration",
        "false",
      ],
      [
        "model_config.MissingCredentialsError('token=runtime-secret')",
        "ModelConfigError",
        "model_configuration",
        "false",
      ],
      [
        "model_config.MissingProviderPackageError('token=runtime-secret')",
        "ModelConfigError",
        "model_configuration",
        "false",
      ],
    ] as const;

    const result = runPatchedNonInteractive(activeExceptionCasesDriver(cases));

    expect(result.status).toBe(0);
    [...cases.entries()].forEach(([index, [, errorClass, category, retryable]]) => {
      const threadId = `thread-trusted-${index}`;
      expect(result.stderr).toContain(
        `error_class=${errorClass} category=${category} retryable=${retryable} ` +
          `correlation_id=${threadId}`,
      );
    });
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(PLANTED_SECRETS);
  });

  it("does not classify a forged checkpoint exception representation (#8121)", () => {
    const result = runPatchedNonInteractive(
      persistedForgeryDriver(
        "Exception('token=runtime-secret')",
        "AuthenticationError('forged by __repr__ token=checkpoint-secret')",
        "thread-forged-checkpoint",
      ),
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "error_class=unknown category=unknown retryable=false " +
        "correlation_id=thread-forged-checkpoint",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("authorization_rejected");
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(PLANTED_SECRETS);
  });

  it("uses a trusted active exception when checkpoint text names another class (#8121)", () => {
    const result = runPatchedNonInteractive(
      persistedForgeryDriver(
        "graph_errors.APIError('token=runtime-secret')",
        "AuthenticationError('forged by __repr__ token=checkpoint-secret')",
        "thread-active-wins",
      ),
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "error_class=APIError category=agent_remote_failure retryable=false " +
        "correlation_id=thread-active-wins",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("authorization_rejected");
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(PLANTED_SECRETS);
  });

  it("rejects a forged active class name and module (#8121)", () => {
    const result = runPatchedNonInteractive(`
${runtimePreamble}
target.generate_thread_id = lambda: "thread-forged-active"


class AuthenticationError(Exception):
    __module__ = "langgraph_sdk.errors"


async def fail(*args, **kwargs):
    del args, kwargs
    raise AuthenticationError("token=runtime-secret")


target._run_non_interactive_impl = fail
exit_code = asyncio.run(target.run_non_interactive("task"))
assert exit_code == 1
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "error_class=unknown category=unknown retryable=false " +
        "correlation_id=thread-forged-active",
    );
    expect(result.stdout).toContain("Unexpected error (correlation_id=thread-forged-active)");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("authorization_rejected");
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(PLANTED_SECRETS);
  });

  it("rejects an application subclass of a trusted exception type (#8121)", () => {
    const result = runPatchedNonInteractive(`
${runtimePreamble}
target.generate_thread_id = lambda: "thread-forged-subclass"


class ForgedAuthenticationError(graph_errors.AuthenticationError):
    pass


async def fail(*args, **kwargs):
    del args, kwargs
    raise ForgedAuthenticationError("token=runtime-secret")


target._run_non_interactive_impl = fail
exit_code = asyncio.run(target.run_non_interactive("task"))
assert exit_code == 1
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "error_class=unknown category=unknown retryable=false " +
        "correlation_id=thread-forged-subclass",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("authorization_rejected");
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(PLANTED_SECRETS);
  });

  it("classifies a trusted cause behind an opaque wrapper (#8121)", () => {
    const result = runPatchedNonInteractive(`
${runtimePreamble}
target.generate_thread_id = lambda: "thread-chained"


class OpaqueWrapper(Exception):
    pass


async def fail(*args, **kwargs):
    del args, kwargs
    try:
        raise httpx.ConnectError("token=runtime-secret")
    except httpx.ConnectError as cause:
        raise OpaqueWrapper("token=runtime-secret") from cause


target._run_non_interactive_impl = fail
exit_code = asyncio.run(target.run_non_interactive("task"))
assert exit_code == 1
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "error_class=Unavailable category=route_unreachable retryable=true " +
        "correlation_id=thread-chained",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(PLANTED_SECRETS);
  });

  it("stops walking the exception chain at the documented limit (#8121)", () => {
    const result = runPatchedNonInteractive(`
${runtimePreamble}
target.generate_thread_id = lambda: "thread-chain-limit"


class OpaqueWrapper(Exception):
    pass


async def fail(*args, **kwargs):
    del args, kwargs
    try:
        raise httpx.ConnectError("token=runtime-secret")
    except httpx.ConnectError as root:
        error = root
        for _ in range(target._NEMOCLAW_EXCEPTION_CHAIN_LIMIT):
            try:
                raise OpaqueWrapper("token=runtime-secret") from error
            except OpaqueWrapper as wrapper:
                error = wrapper
        raise error


target._run_non_interactive_impl = fail
exit_code = asyncio.run(target.run_non_interactive("task"))
assert exit_code == 1
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "error_class=unknown category=unknown retryable=false " + "correlation_id=thread-chain-limit",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("route_unreachable");
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(PLANTED_SECRETS);
  });

  it("leaves an unlisted exception type unknown without echoing its name (#8121)", () => {
    const result = runPatchedNonInteractive(`
${runtimePreamble}
target.generate_thread_id = lambda: "thread-unlisted"


class SomeVendorSpecificFailure_runtime_secret(Exception):
    pass


async def fail(*args, **kwargs):
    del args, kwargs
    raise SomeVendorSpecificFailure_runtime_secret("token=runtime-secret")


target._run_non_interactive_impl = fail
exit_code = asyncio.run(target.run_non_interactive("task"))
assert exit_code == 1
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "error_class=unknown category=unknown retryable=false correlation_id=thread-unlisted",
    );
    expect(result.stdout).toContain("Unexpected error (correlation_id=thread-unlisted)");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      "SomeVendorSpecificFailure_runtime_secret",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(PLANTED_SECRETS);
  });
});
