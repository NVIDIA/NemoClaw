// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
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

type PersistedErrorRow = {
  serializationType: string;
  valueHex: string;
};

// `JsonPlusSerializer` 4.1.1 applies `repr` to `BaseException` and encodes the
// result as one MessagePack string.
function messagePackStringHex(value: string): string {
  const payload = Buffer.from(value, "utf8");
  let prefix: Buffer;
  if (payload.length <= 31) {
    prefix = Buffer.from([0xa0 | payload.length]);
  } else if (payload.length <= 0xff) {
    prefix = Buffer.from([0xd9, payload.length]);
  } else if (payload.length <= 0xffff) {
    prefix = Buffer.alloc(3);
    prefix[0] = 0xda;
    prefix.writeUInt16BE(payload.length, 1);
  } else {
    prefix = Buffer.alloc(5);
    prefix[0] = 0xdb;
    prefix.writeUInt32BE(payload.length, 1);
  }
  return Buffer.concat([prefix, payload]).toString("hex");
}

function rawPersistedRow(serializationType: string, valueHex: string): PersistedErrorRow {
  return { serializationType, valueHex };
}

function persistedErrorDriver(
  rows: Record<string, string | PersistedErrorRow>,
  threadId: string,
): string {
  const inserts = Object.entries(rows)
    .map(([thread, value]) => {
      const row =
        typeof value === "string" ? rawPersistedRow("msgpack", messagePackStringHex(value)) : value;
      return `connection.execute("INSERT INTO writes (thread_id, channel, type, value) VALUES (?, '__error__', ?, ?)", (${JSON.stringify(
        thread,
      )}, ${JSON.stringify(row.serializationType)}, sqlite3.Binary(bytes.fromhex(${JSON.stringify(
        row.valueHex,
      )}))))`;
    })
    .join("\n");
  return `
${runtimePreamble}
handle, db_path = tempfile.mkstemp()
os.close(handle)
target._NEMOCLAW_MANAGED_STATE_DB = db_path
target.generate_thread_id = lambda: ${JSON.stringify(threadId)}

connection = sqlite3.connect(db_path)
connection.execute("CREATE TABLE writes (thread_id TEXT, channel TEXT, type TEXT, value BLOB)")
${inserts}
connection.commit()
connection.close()

exit_code = asyncio.run(target.run_non_interactive("task"))
assert exit_code == 1
os.unlink(db_path)
`;
}

describe("managed non-interactive error reporting", () => {
  it("classifies root exception classes from pinned checkpoint serialization (#8121)", () => {
    const cases = [
      [
        "d930415049436f6e6e656374696f6e4572726f722827636f6e6e65637420746f20696e666572656e63652e6c6f63616c2729",
        "Unavailable",
        "route_unreachable",
        "true",
      ],
      [
        "d9265265736f75726365457868617573746564282763617061636974792065786365656465642729",
        "ResourceExhausted",
        "upstream_provider_capacity",
        "true",
      ],
      [
        "bf41757468656e7469636174696f6e4572726f72282772656a65637465642729",
        "Unauthorized",
        "authorization_rejected",
        "false",
      ],
      [
        "d925496e7465726e616c5365727665724572726f72282772656d6f7465206661696c7572652729",
        "InternalServerError",
        "remote_server_error",
        "true",
      ],
      [
        messagePackStringHex(`APIError('${"x".repeat(300)}')`),
        "APIError",
        "agent_remote_failure",
        "false",
      ],
    ] as const;

    for (const [valueHex, errorClass, category, retryable] of cases) {
      const result = runPatchedNonInteractive(
        persistedErrorDriver(
          { "thread-current": rawPersistedRow("msgpack", valueHex) },
          "thread-current",
        ),
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        `error_class=${errorClass} category=${category} retryable=${retryable} ` +
          "correlation_id=thread-current",
      );
    }
  });

  it("does not infer provider capacity from a nested checkpoint name (#7415)", () => {
    const result = runPatchedNonInteractive(
      persistedErrorDriver(
        {
          "thread-current":
            "APIError('ResourceExhausted: tool_result=private-tool-result " +
            "token=checkpoint-secret')",
        },
        "thread-current",
      ),
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "error_class=APIError category=agent_remote_failure retryable=false " +
        "correlation_id=thread-current",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("upstream_provider_capacity");
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
    // The other thread's capacity row must never be borrowed. The current
    // thread's root APIError class determines the result.
    expect(result.stderr).toContain(
      "error_class=APIError category=agent_remote_failure retryable=false " +
        "correlation_id=thread-current",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("upstream_provider_capacity");
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(PLANTED_SECRETS);
  });

  it("classifies root transport and remote exception classes (#8121)", () => {
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

  it("does not classify a supported name inside scalar payload content (#8121)", () => {
    // Only the root APIError class can classify. Each inner name belongs to
    // payload text, including forms that start with `Name:` or `Name(`.
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
    const quoted = supportedNames.map((name) => `APIError('${name}: tool output')`);
    quoted.push(
      "APIError('ResourceExhausted(tool output)')",
      "APIError({'payload': 'ResourceExhausted: tool output'})",
      "APIError({'payloads': ['ResourceExhausted(tool output)']})",
    );

    for (const persisted of quoted) {
      const result = runPatchedNonInteractive(
        persistedErrorDriver({ "thread-quoted": persisted }, "thread-quoted"),
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        "error_class=APIError category=agent_remote_failure retryable=false " +
          "correlation_id=thread-quoted",
      );
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(persisted);
    }
  });

  it("rejects nested status and HTTP payloads in scalar exception text (#8121)", () => {
    const cases = [
      "APIError({'payload': {'status_code': 429}})",
      "APIError({'payloads': [{'http_status': 503}]})",
      "APIError({'payload': ['HTTP 503', 'ResourceExhausted: tool output']})",
      "APIError('HTTP 503 from tool output')",
      "APIError('status_code=429')",
    ];

    for (const persisted of cases) {
      const result = runPatchedNonInteractive(
        persistedErrorDriver({ "thread-nested": persisted }, "thread-nested"),
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        "error_class=APIError category=agent_remote_failure retryable=false " +
          "correlation_id=thread-nested",
      );
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(persisted);
    }
  });

  it("rejects checkpoint data without a root exception class (#8121)", () => {
    const cases = [
      // MessagePack map: {"payload": {"status_code": 429}}
      rawPersistedRow("msgpack", "81a77061796c6f616481ab7374617475735f636f6465cd01ad"),
      // MessagePack array: [429, 503]
      rawPersistedRow("msgpack", "92cd01adcd01f7"),
      rawPersistedRow(
        "json",
        Buffer.from('{"status_code":429,"message":"HTTP 503"}', "utf8").toString("hex"),
      ),
      rawPersistedRow("msgpack", messagePackStringHex("ResourceExhausted: tool output")),
      rawPersistedRow("msgpack", messagePackStringHex("HTTP 503 from tool output")),
      rawPersistedRow("msgpack", messagePackStringHex("openai.RateLimitError: tool output")),
      rawPersistedRow("msgpack", "d9054142"),
      rawPersistedRow("msgpack", "db00010000"),
      rawPersistedRow("msgpack", "a1ff"),
      rawPersistedRow("msgpack", ""),
    ];

    for (const persisted of cases) {
      const result = runPatchedNonInteractive(
        persistedErrorDriver({ "thread-shape": persisted }, "thread-shape"),
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        "error_class=RemoteException category=agent_remote_failure retryable=false " +
          "correlation_id=thread-shape",
      );
    }
  });

  it("does not classify prose quoted from model or tool output (#8121)", () => {
    // Each classifier word belongs to the APIError payload, not its root class.
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
      // The root APIError class is the only checkpoint classification here.
      expect(result.stderr).toContain(
        "error_class=APIError category=agent_remote_failure retryable=false " +
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

  it("still classifies a checkpoint row written after the exception is raised (#8121)", () => {
    // The documented race: the LangGraph server writes `__error__` from its own
    // process, so the row can land after the client-side exception. The row is
    // inserted from inside the failing call, which is the earliest point that
    // reproduces "written after the exception, before classification", and the
    // persisted classification must win over the exception-type fallback.
    const result = runPatchedNonInteractive(`
${runtimePreamble}
handle, db_path = tempfile.mkstemp()
os.close(handle)
target._NEMOCLAW_MANAGED_STATE_DB = db_path
target.generate_thread_id = lambda: "thread-late-row"

connection = sqlite3.connect(db_path)
connection.execute("CREATE TABLE writes (thread_id TEXT, channel TEXT, type TEXT, value BLOB)")
connection.commit()
connection.close()


async def fail_then_persist(*args, **kwargs):
    del args, kwargs
    late = sqlite3.connect(db_path)
    late.execute(
        "INSERT INTO writes (thread_id, channel, type, value) "
        "VALUES (?, '__error__', ?, ?)",
        (
            "thread-late-row",
            "msgpack",
            sqlite3.Binary(bytes.fromhex(
                "d930415049436f6e6e656374696f6e4572726f722827636f6e6e65637420746f"
                "20696e666572656e63652e6c6f63616c2729"
            )),
        ),
    )
    late.commit()
    late.close()
    raise RemoteException("remote failure token=runtime-secret")


target._run_non_interactive_impl = fail_then_persist

exit_code = asyncio.run(target.run_non_interactive("task"))
assert exit_code == 1
os.unlink(db_path)
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "error_class=Unavailable category=route_unreachable retryable=true " +
        "correlation_id=thread-late-row",
    );
    // The active exception must not pre-empt a typed row that did arrive.
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("agent_remote_failure");
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(PLANTED_SECRETS);
  });

  it("does not scan past the newest checkpoint error row (#8121)", () => {
    // The newest row is a MessagePack map with no error-type path. An older
    // scalar must not supply a diagnosis for it.
    const result = runPatchedNonInteractive(`
${runtimePreamble}
handle, db_path = tempfile.mkstemp()
os.close(handle)
target._NEMOCLAW_MANAGED_STATE_DB = db_path
target.generate_thread_id = lambda: "thread-newest"

connection = sqlite3.connect(db_path)
connection.execute("CREATE TABLE writes (thread_id TEXT, channel TEXT, type TEXT, value BLOB)")
connection.execute(
    "INSERT INTO writes (thread_id, channel, type, value) "
    "VALUES (?, '__error__', ?, ?)",
    (
        "thread-newest",
        "msgpack",
        sqlite3.Binary(bytes.fromhex(
            "d930415049436f6e6e656374696f6e4572726f722827636f6e6e65637420746f"
            "20696e666572656e63652e6c6f63616c2729"
        )),
    ),
)
connection.execute(
    "INSERT INTO writes (thread_id, channel, type, value) "
    "VALUES (?, '__error__', ?, ?)",
    (
        "thread-newest",
        "msgpack",
        sqlite3.Binary(bytes.fromhex(
            "81a77061796c6f616481ab7374617475735f636f6465cd01ad"
        )),
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
      "error_class=RemoteException category=agent_remote_failure retryable=false " +
        "correlation_id=thread-newest",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("route_unreachable");
  });

  it("stops walking the exception chain at the documented depth limit (#8121)", () => {
    // A classifiable cause one link beyond the limit must not be reached, and
    // the bounded walk must terminate rather than hang.
    const result = runPatchedNonInteractive(`
${runtimePreamble}
handle, db_path = tempfile.mkstemp()
os.close(handle)
target._NEMOCLAW_MANAGED_STATE_DB = db_path
target.generate_thread_id = lambda: "thread-chain-limit"


class OpaqueWrapper(Exception):
    pass


async def fail_deep_chain(*args, **kwargs):
    del args, kwargs
    try:
        raise ConnectionRefusedError("connect to inference.local token=runtime-secret")
    except ConnectionRefusedError as root:
        error = root
        # One wrapper per allowed step, so the transport cause sits at index
        # _NEMOCLAW_EXCEPTION_CHAIN_LIMIT and falls outside the walk.
        for _ in range(target._NEMOCLAW_EXCEPTION_CHAIN_LIMIT):
            try:
                raise OpaqueWrapper("wrapped token=runtime-secret") from error
            except OpaqueWrapper as wrapper:
                error = wrapper
        raise error


target._run_non_interactive_impl = fail_deep_chain

exit_code = asyncio.run(target.run_non_interactive("task"))
assert exit_code == 1
os.unlink(db_path)
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "error_class=unknown category=unknown retryable=false correlation_id=thread-chain-limit",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("route_unreachable");
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
