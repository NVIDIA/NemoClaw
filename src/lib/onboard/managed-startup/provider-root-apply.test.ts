// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { createContainerEngineCommand } from "../../adapters/container-engine";
import type { ContainerEngineOperationScope } from "../../adapters/container-engine";

import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  managedStartupE2eProfile,
} from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { createPodmanRuntimeProviderBundle } from "../runtime-provider/podman";
import type {
  RuntimeProviderBundle,
  RuntimeProviderPrivilegedSandboxCommandInput,
} from "../runtime-provider/contract";
import { MANAGED_STARTUP_SHARED_CAPTURE_MAX_BYTES } from "./shared-state-transaction";
import {
  DirectSandboxContainerNotFoundError,
  DirectSandboxFallbackUnavailableError,
} from "../runtime-provider/privileged-sandbox-control-errors";
import {
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_CONTAINER_PREFIX,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
  PODMAN_SANDBOX_WORKSPACE,
  PODMAN_SANDBOX_WORKSPACE_LABEL,
} from "../runtime-provider/podman-lifecycle";
import { encodeManagedStartupProfile } from "./profile";
import * as ownerLease from "./openclaw-owner-lease";
import {
  applyProviderManagedStartupRootRequest,
  finalizeProviderManagedStartupSharedState,
  releaseProviderManagedStartupHold,
} from "./provider-root-apply";
import { createManagedStartupRootApplyRequest } from "./root-apply";

const CONTAINER_ID = "a".repeat(64);
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const SANDBOX_ID = "sandbox-podman-managed";
const SANDBOX_NAME = "managed-podman";
const LEGACY_STARTUP_PROTOCOL_RESULT = {
  status: 1,
  stdout: "",
  stderr: "usage: managed-startup-image-runtime --release-startup-hold",
};

// Execute the shipped observer unchanged. Only the container account/root and
// clock are substituted; SQLite queries and descriptor checks run against files.
const OWNER_LEASE_FIXTURE = String.raw`
import contextlib, io, json, os, pathlib, pwd, socket, sqlite3, subprocess, sys, tempfile
from unittest.mock import patch

request = json.load(sys.stdin)
fixture = request["fixture"]
account = pwd.getpwuid(os.getuid())
epoch = 1700000000
clock = [0]
sleeps = []
attempts = [0]
real_open = os.open
real_connect = sqlite3.connect
real_file_open = open
real_run = subprocess.run

def sleep(seconds):
    assert 0 < seconds <= 1
    assert clock[0] < 301, "observer exceeded its bounded deadline"
    sleeps.append(seconds)
    clock[0] += seconds

with tempfile.TemporaryDirectory(prefix="nemoclaw-owner-lease-") as root:
    state = pathlib.Path(root, "sandbox/.openclaw/state")
    state.mkdir(parents=True)
    database_path = state / "openclaw.sqlite"
    if fixture.get("database", True):
        with real_connect(database_path) as db:
            if fixture.get("table", True):
                db.execute("CREATE TABLE state_leases (scope TEXT, lease_key TEXT, expires_at INTEGER, payload_json TEXT)")
                # Other scopes and lease keys must not block the gateway owner.
                unrelated = json.dumps({"owner": {"host": socket.gethostname() + "-foreign"}})
                db.executemany("INSERT INTO state_leases VALUES (?, ?, ?, ?)", [
                    ("unrelated", "global", epoch * 1000 + 600000, unrelated),
                    ("gateway-owner", "other", epoch * 1000 + 600000, unrelated),
                ])
                row = fixture.get("row")
                if row is not None:
                    offset = row["expiry"]
                    expiry = epoch * 1000 + offset if type(offset) is int else offset
                    host = socket.gethostname() if row["host"] == "local" else socket.gethostname() + "-foreign"
                    payload = row.get("payload", json.dumps({"owner": {"host": host}}))
                    db.execute("INSERT INTO state_leases VALUES ('gateway-owner', 'global', ?, ?)", (expiry, payload))
            else:
                # A valid SQLite database without the lease table, not an empty file.
                db.execute("CREATE TABLE unrelated(value TEXT)")
        db.close()
        database_path.chmod(fixture.get("mode", 0o660))
    before = database_path.read_bytes() if database_path.exists() else None

    def open_root(path, *args, **kwargs):
        return real_open(root if path == "/" else path, *args, **kwargs)

    real_stat = os.stat
    def stat_root(path, *args, **kwargs):
        if isinstance(path, str) and path.startswith("/sandbox/"):
            path = root + path
        return real_stat(path, *args, **kwargs)

    def connect_descriptor(reference, *args, **kwargs):
        # Redirect only the container root to the fixture. SQLite still opens
        # a real pathname, and the shared reader validates its actual descriptor.
        assert reference.startswith("file:/sandbox/.openclaw/state/openclaw.sqlite?mode=ro")
        assert kwargs.get("uri") is True
        race = fixture.get("race")
        original = state / "original.sqlite"
        if race in ("replace-before-open", "replace-and-restore"):
            replacement = state / "replacement.sqlite"
            with real_connect(replacement) as substitute:
                substitute.execute("CREATE TABLE substituted(value TEXT)")
            substitute.close()
            database_path.rename(original)
            replacement.rename(database_path)
        if fixture.get("busyReads", 0) > attempts[0]:
            attempts[0] += 1
            raise sqlite3.OperationalError("database is locked")
        connection = real_connect(database_path.as_uri() + reference[reference.index("?"):], *args, **kwargs)
        if race == "replace-and-restore":
            database_path.rename(state / "substituted.sqlite")
            original.rename(database_path)
        elif race == "remove-after-open":
            database_path.unlink()
        elif race == "replace-directory":
            state.rename(state.with_name("retired-state"))
            state.mkdir()
        return connection

    def package_open(file, *args, **kwargs):
        if file == "/usr/local/lib/node_modules/openclaw/package.json":
            return io.StringIO(json.dumps({"name": "openclaw", "version": fixture.get("version", "2026.9.2")}))
        return real_file_open(file, *args, **kwargs)

    native_calls = []
    native_root = pathlib.Path(root, "runtime")
    native_root.mkdir()
    (native_root / "package.json").write_text('{"name":"openclaw","version":"2026.10.5"}')
    (native_root / "dist").mkdir()
    (native_root / "dist/gateway-lock-test.mjs").write_text("function readActiveGatewayLockIdentity() {} export { readActiveGatewayLockIdentity };")
    native_trace = native_root / "trace"
    (native_root / "dist/gateway-owner-lease-test.mjs").write_text(
        "import fs from 'node:fs'; import os from 'node:os'; let calls = 0; "
        "function assertGatewayOwnerLeaseStopped(env) { calls++; "
        "if (process.getuid() !== " + str(account.pw_uid) + " || process.env.HOME !== '/sandbox' || env !== process.env) throw new Error('wrong native context');"
        "fs.appendFileSync(" + json.dumps(str(native_trace)) + ", String(calls)); "
        "if (calls < 2) throw new Error('Another Gateway owner lease is still active for this state directory: ' + os.hostname()); }"
        "export { assertGatewayOwnerLeaseStopped };"
    )

    def run_native(argv, **kwargs):
        assert argv == ["/usr/local/bin/node", "--input-type=module", "-"]
        assert kwargs["timeout"] == 315 and kwargs["check"] is True
        assert kwargs["env"] == {"HOME": "/sandbox", "OPENCLAW_STATE_DIR": "/sandbox/.openclaw", "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
        # Substitute only the installed package and interpreter location.
        kwargs["input"] = kwargs["input"].replace('"/usr/local/lib/node_modules/openclaw"', json.dumps(str(native_root)))
        result = real_run([request["node"], *argv[1:]], **kwargs, capture_output=True)
        native_calls.extend(native_trace.read_text())
        return result

    error = None
    with contextlib.ExitStack() as stack:
        stack.enter_context(patch("pwd.getpwnam", return_value=account))
        stack.enter_context(patch("builtins.open", side_effect=package_open))
        stack.enter_context(patch("subprocess.run", side_effect=run_native))
        stack.enter_context(patch("os.open", side_effect=open_root))
        stack.enter_context(patch("os.stat", side_effect=stat_root))
        stack.enter_context(patch("time.monotonic", side_effect=lambda: clock[0]))
        stack.enter_context(patch("time.time", side_effect=lambda: epoch + clock[0]))
        stack.enter_context(patch("time.sleep", side_effect=sleep))
        stack.enter_context(patch("sqlite3.connect", side_effect=connect_descriptor))
        try:
            exec(compile(request["source"], "openclaw-owner-lease", "exec"), {})
        except Exception as failure:
            error = str(failure)
    after = database_path.read_bytes() if database_path.exists() else None
    print(json.dumps({"elapsedSeconds": clock[0], "sleptSeconds": sum(sleeps), "databaseUnchanged": before == after, "error": error, "nativeCalls": native_calls}))
sys.exit(1 if error is not None else 0)
`;

function observeOwnerLease(fixture: unknown) {
  const result = spawnSync("python3", ["-I", "-c", OWNER_LEASE_FIXTURE], {
    input: JSON.stringify({
      fixture,
      node: process.execPath,
      source: ownerLease.buildOpenClawOwnerLeaseObserver(),
    }),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 32 * 1_024,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  return { result, observation: JSON.parse(result.stdout) };
}

describe("legacy OpenClaw owner lease observation", () => {
  it.each([
    { name: "missing database", fixture: { database: false }, elapsed: 0, error: null },
    { name: "missing lease table", fixture: { table: false }, elapsed: 0, error: null },
    { name: "absent global owner", fixture: {}, elapsed: 0, error: null },
    {
      name: "world-accessible database",
      fixture: { mode: 0o666 },
      elapsed: 0,
      error: "unsafe canonical pairing-state SQLite entry",
    },
    {
      name: "foreign owner that expires at the native deadline",
      fixture: { row: { host: "foreign", expiry: 300_000 } },
      elapsed: 300,
      error: null,
    },
    {
      name: "local owner active beyond the native deadline",
      fixture: { row: { host: "local", expiry: 600_000 } },
      elapsed: 300,
      error: "OpenClaw owner lease remained active through its native expiry window",
    },
    {
      name: "expired foreign owner",
      fixture: { row: { host: "foreign", expiry: -1 } },
      elapsed: 0,
      error: null,
    },
    {
      name: "foreign owner that expires during observation",
      fixture: { row: { host: "foreign", expiry: 2_000 } },
      elapsed: 2,
      error: null,
    },
    {
      name: "foreign owner active beyond the native deadline",
      fixture: { row: { host: "foreign", expiry: 600_000 } },
      elapsed: 300,
      error: "OpenClaw owner lease remained active through its native expiry window",
    },
    {
      name: "a busy database that settles before the lease is absent",
      fixture: { busyReads: 3 },
      elapsed: 3,
      error: null,
    },
    {
      name: "a database that stays busy through the native deadline",
      fixture: { busyReads: 1_000 },
      elapsed: 300,
      error: "OpenClaw owner lease state stayed busy through its native expiry window",
    },
    {
      name: "foreign owner with an invalid expiry",
      fixture: { row: { host: "foreign", expiry: "unbounded" } },
      elapsed: 0,
      error: "OpenClaw owner lease has no bounded expiry",
    },
    {
      name: "owner without a host identity",
      fixture: { row: { host: "foreign", expiry: 600_000, payload: '{"owner":{}}' } },
      elapsed: 0,
      error: "OpenClaw owner lease has no host identity",
    },
  ])("preserves the database when observing $name", ({ fixture, elapsed, error }) => {
    const { result, observation } = observeOwnerLease(fixture);
    expect(result.status).toBe(error === null ? 0 : 1);
    expect(observation.elapsedSeconds).toBe(elapsed);
    expect(observation.sleptSeconds).toBe(elapsed);
    expect(observation.error).toBe(error);
    expect(observation.databaseUnchanged).toBe(true);
  });
});

type LifecycleFixtureProvider = RuntimeProviderBundle & {
  lifecycle: Extract<RuntimeProviderBundle["lifecycle"], { supported: true }>;
};

function createDockerRootApplyFixture(
  resolveTarget: (input: { readonly timeoutMs?: number }) => { resourceHandle: string },
  agent: Parameters<typeof createManagedStartupRootApplyRequest>[0]["agent"] = "openclaw",
) {
  const labels = {
    "openshell.ai/managed-by": "openshell",
    "openshell.ai/sandbox-name": SANDBOX_NAME,
    "openshell.ai/sandbox-id": SANDBOX_ID,
    "openshell.ai/sandbox-workspace": "default",
  };
  const execute = vi.fn(
    (input: { readonly command: readonly string[]; readonly timeoutMs?: number }) => ({
      status: input.command.includes("--startup-protocol") ? 1 : 0,
      stdout: input.command.includes("--shared-state-transaction-status") ? "pending\n" : "",
      stderr: input.command.includes("--startup-protocol")
        ? "usage: managed-startup-image-runtime --release-startup-hold"
        : "",
    }),
  );
  const runtimeProvider = {
    identity: { id: "docker" },
    lifecycle: {
      supported: true,
      privilegedSandboxControl: { resolveTarget, execute, prepareManagedStartupWorkspace: vi.fn() },
    },
    containerEngine: {
      supported: true,
      identities: [{ operation: "sandbox-lifecycle" }],
      capture: () => ({
        status: 0,
        stdout: JSON.stringify([
          {
            Id: CONTAINER_ID,
            Image: IMAGE_ID,
            Config: { Labels: labels },
            State: { Dead: false, Paused: false, Restarting: false, Running: true },
          },
        ]),
        stderr: "",
      }),
    },
  } as unknown as LifecycleFixtureProvider;
  const request = createManagedStartupRootApplyRequest({
    agent,
    corporateCaB64: Buffer.from(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM, "utf8").toString("base64"),
    encodedProfile: encodeManagedStartupProfile(managedStartupE2eProfile(agent, false, true, true)),
  });
  return { request, runtimeProvider, execute };
}

function createOwnerLeaseDeadlineFixture(expiry: number) {
  const { result, observation } = observeOwnerLease({ row: { host: "foreign", expiry } });
  expect(observation.elapsedSeconds).toBe(300);
  const fixture = createDockerRootApplyFixture(() => ({ resourceHandle: CONTAINER_ID }));
  let timedOut = false;
  fixture.execute
    .mockReturnValueOnce(LEGACY_STARTUP_PROTOCOL_RESULT)
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
    .mockReturnValueOnce({ status: 0, stdout: "pending\n", stderr: "" })
    .mockImplementationOnce(({ timeoutMs }) => {
      // Include interpreter/container startup outside the actual observer's
      // measured time; the supervisor must allow either native result back.
      timedOut = observation.elapsedSeconds * 1_000 + 1_000 >= (timeoutMs ?? 0);
      return { status: timedOut ? 1 : result.status!, stdout: "", stderr: "" };
    });
  const apply = () =>
    applyProviderManagedStartupRootRequest({
      runtimeProvider: fixture.runtimeProvider,
      sandboxName: SANDBOX_NAME,
      sandboxId: SANDBOX_ID,
      bootstrapIdentity: "c".repeat(64),
      request: fixture.request,
      environment: {},
    });
  return { apply, execute: fixture.execute, timedOut: () => timedOut };
}

function delegatedFixture(
  agent: Parameters<typeof createDockerRootApplyFixture>[1] = "openclaw",
  phase: "none" | "pending" | "committed" = "none",
) {
  const fixture = createDockerRootApplyFixture(() => ({ resourceHandle: CONTAINER_ID }), agent);
  const calls: Array<RuntimeProviderPrivilegedSandboxCommandInput & { sandboxUser?: string }> = [];
  const output: Record<string, string> = {
    "--startup-protocol": "delegated-owner-v1\n",
    "--prepare-delegated-transaction-stdin": phase,
    "--capture-shared-state-stdin": "private original capture",
    "--begin-shared-state-from-capture-stdin": "created\n",
    "--prepare-delegated-startup-stdin":
      phase === "committed" ? "already-committed\n" : "prepared\n",
    "--apply-owner-startup-stdin": "private generated result",
    "--finish-delegated-startup-stdin": "CA tool output\napplied\n",
    "--export-shared-restoration-profile-stdin": "private original capture",
    "--restore-shared-state-stdin": "private restored observation",
    "--finish-shared-restoration-stdin": "restored\n",
  };
  const failures = new Set<string>();
  const execute = vi.fn(
    (input: RuntimeProviderPrivilegedSandboxCommandInput & { sandboxUser?: string }) => {
      calls.push(input);
      const operation = input.command.find((value) => value.startsWith("--"))!;
      return {
        status: failures.has(operation) ? 1 : 0,
        signal: null,
        stdout: Buffer.from(output[operation] ?? ""),
        stderr: Buffer.from(failures.has(operation) ? "private-error-sentinel" : ""),
      };
    },
  );
  fixture.runtimeProvider.lifecycle.privilegedSandboxControl.execute = execute;
  fixture.runtimeProvider.lifecycle.privilegedSandboxControl.executeAsSandboxUser = execute;
  const input = {
    ...fixture,
    sandboxName: SANDBOX_NAME,
    sandboxId: SANDBOX_ID,
    bootstrapIdentity: "c".repeat(64),
    environment: {},
  };
  return { input, calls, output, failures, execute };
}

describe("provider delegated private startup", () => {
  it.each([
    ["openclaw", "998:998"],
    ["hermes", "998:999"],
    ["langchain-deepagents-code", "999:999"],
    ["pi", "999:999"],
  ] as const)(
    "orders %s capture, protected admission, generation and root finish",
    (agent, sandboxUser) => {
      const { input, calls } = delegatedFixture(agent);
      const transaction = applyProviderManagedStartupRootRequest(input);
      expect(transaction).toMatchObject({
        protocol: "identity-bound",
        delegatedProfile: input.request.encodedProfile,
      });
      expect(calls.map(({ command }) => command.find((value) => value.startsWith("--")))).toEqual([
        "--startup-protocol",
        "--prepare-delegated-transaction-stdin",
        "--capture-shared-state-stdin",
        "--begin-shared-state-from-capture-stdin",
        "--prepare-delegated-startup-stdin",
        "--apply-owner-startup-stdin",
        "--finish-delegated-startup-stdin",
      ]);
      expect(calls.filter((call) => call.sandboxUser).map((call) => call.sandboxUser)).toEqual([
        sandboxUser,
        sandboxUser,
      ]);
      expect(calls.every((call) => call.expectedResourceHandle === CONTAINER_ID)).toBe(true);
      expect(calls[2]?.maxOutputBytes).toBe(MANAGED_STARTUP_SHARED_CAPTURE_MAX_BYTES);
      expect(JSON.parse(String(calls[3]?.input))).toEqual({
        encodedProfile: input.request.encodedProfile,
        capturedState: "private original capture",
      });
      expect(JSON.parse(String(calls[6]?.input)).ownerResult).toBe("private generated result");
      expect(JSON.stringify(transaction)).not.toContain("private");
      expect(calls.flatMap((call) => call.command)).not.toContain("--release-startup-hold");
    },
  );

  it.each(["pending", "committed"] as const)(
    "keeps the original snapshot on %s recovery",
    (phase) => {
      const { input, calls } = delegatedFixture("openclaw", phase);
      applyProviderManagedStartupRootRequest(input);
      expect(calls.flatMap((call) => call.command)).not.toContain("--capture-shared-state-stdin");
      expect(calls.flatMap((call) => call.command)).not.toContain(
        "--begin-shared-state-from-capture-stdin",
      );
      const generation = calls.find((call) => call.command.includes("--apply-owner-startup-stdin"));
      expect(generation?.command.includes("--replay")).toBe(phase === "committed");
    },
  );

  it.each([
    "--prepare-delegated-transaction-stdin",
    "--capture-shared-state-stdin",
    "--begin-shared-state-from-capture-stdin",
    "--prepare-delegated-startup-stdin",
    "--apply-owner-startup-stdin",
    "--finish-delegated-startup-stdin",
  ])("retains recovery without leaking private output or falling back after %s fails", (action) => {
    const { input, calls, failures } = delegatedFixture();
    failures.add(action);
    let failure: Error & { managedStartupTransaction?: unknown };
    try {
      applyProviderManagedStartupRootRequest(input);
      throw new Error("expected failure");
    } catch (error) {
      failure = error as typeof failure;
    }
    expect(failure.message).toContain("retained for recovery");
    expect(failure.message).not.toContain("private-error-sentinel");
    expect(failure.managedStartupTransaction).toMatchObject({
      delegatedProfile: input.request.encodedProfile,
    });
    expect(calls.at(-1)?.command).toContain(action);
    expect(calls.flatMap((call) => call.command)).not.toContain("--apply-root-stdin");
  });

  it("rejects unknown protocol output before workspace changes", () => {
    const { input, output, calls } = delegatedFixture();
    output["--startup-protocol"] = "unknown";
    const prepare = vi.fn();
    input.runtimeProvider.lifecycle.privilegedSandboxControl.prepareManagedStartupWorkspace =
      prepare;
    expect(() => applyProviderManagedStartupRootRequest(input)).toThrow(/unknown protocol/u);
    expect(prepare).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("restores through the native owner and retires only its returned observation", () => {
    const { input, calls } = delegatedFixture();
    const transaction = applyProviderManagedStartupRootRequest(input);
    calls.length = 0;
    expect(
      finalizeProviderManagedStartupSharedState({ ...input, transaction, supervisorReady: false }),
    ).toEqual({ supervisorReady: false, failure: null });
    expect(calls.map(({ command }) => command.find((value) => value.startsWith("--")))).toEqual([
      "--export-shared-restoration-profile-stdin",
      "--restore-shared-state-stdin",
      "--finish-shared-restoration-stdin",
    ]);
    expect(String(calls[0]?.input)).toBe(input.request.encodedProfile);
    expect(calls[0]?.maxOutputBytes).toBe(MANAGED_STARTUP_SHARED_CAPTURE_MAX_BYTES);
    expect(calls[1]?.sandboxUser).toBe("998:998");
    expect(JSON.parse(String(calls[2]?.input))).toEqual({
      encodedProfile: input.request.encodedProfile,
      capturedState: "private restored observation",
    });
  });

  it.each([
    "--export-shared-restoration-profile-stdin",
    "--restore-shared-state-stdin",
    "--finish-shared-restoration-stdin",
  ])("retains recovery without root fallback when %s fails", (action) => {
    const { input, calls, failures } = delegatedFixture();
    const transaction = applyProviderManagedStartupRootRequest(input);
    calls.length = 0;
    failures.add(action);
    expect(() =>
      finalizeProviderManagedStartupSharedState({ ...input, transaction, supervisorReady: false }),
    ).toThrow(/recovery receipt are retained/u);
    expect(calls.at(-1)?.command).toContain(action);
    expect(calls.flatMap((call) => call.command)).not.toContain(
      "--rollback-shared-state-transaction",
    );
  });
});

describe("provider-owned managed startup root application", () => {
  it("keeps a same-host live native owner held even after lease expiry", () => {
    const { result, observation } = observeOwnerLease({
      version: "2026.10.5",
      row: { host: "local", expiry: -1 },
    });
    expect(result.status).toBe(0);
    expect(observation.nativeCalls).toEqual(["1", "2"]);
    expect(observation.databaseUnchanged).toBe(true);
    const fixture = createDockerRootApplyFixture(() => ({ resourceHandle: CONTAINER_ID }));
    fixture.execute
      .mockReturnValueOnce(LEGACY_STARTUP_PROTOCOL_RESULT)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "pending\n", stderr: "" })
      .mockReturnValueOnce({ status: result.status!, stdout: "", stderr: "" });
    const transaction = applyProviderManagedStartupRootRequest({
      runtimeProvider: fixture.runtimeProvider,
      sandboxName: SANDBOX_NAME,
      sandboxId: SANDBOX_ID,
      bootstrapIdentity: "c".repeat(64),
      request: fixture.request,
      environment: {},
    });
    expect(transaction?.containerId).toBe(CONTAINER_ID);
    expect(fixture.execute.mock.calls).toHaveLength(4);
    expect(fixture.execute.mock.calls[0]?.[0].command).toContain("--startup-protocol");
  });

  it.each([
    { race: "replace-before-open", error: "unvalidated pairing-state file identity" },
    { race: "replace-and-restore", error: "unvalidated pairing-state file identity" },
    { race: "remove-after-open", error: "canonical pairing-state database changed while reading" },
    { race: "replace-directory", error: "canonical pairing-state database changed while reading" },
  ])("retains the startup hold after the SQLite $race race", ({ race, error }) => {
    const { result, observation } = observeOwnerLease({ race, table: false });
    expect(result.status).toBe(1);
    expect(observation.error).toContain(error);
    expect(observation.elapsedSeconds).toBe(0);
    const fixture = createDockerRootApplyFixture(() => ({ resourceHandle: CONTAINER_ID }));
    fixture.execute
      .mockReturnValueOnce(LEGACY_STARTUP_PROTOCOL_RESULT)
      .mockImplementation(({ command }) =>
        command.includes("python3")
          ? { status: result.status!, stdout: "", stderr: observation.error }
          : { status: 0, stdout: "pending\n", stderr: "" },
      );
    expect(() =>
      applyProviderManagedStartupRootRequest({
        runtimeProvider: fixture.runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        bootstrapIdentity: "c".repeat(64),
        request: fixture.request,
        environment: {},
      }),
    ).toThrow("OpenClaw owner lease did not settle before managed startup");
    expect(fixture.execute.mock.calls.map(([call]) => call.command)).toHaveLength(4);
    expect(fixture.execute.mock.calls[0]?.[0].command).toContain("--startup-protocol");
  });

  it("returns the transaction when the native lease expires at its deadline", () => {
    const fixture = createOwnerLeaseDeadlineFixture(300_000);
    expect(fixture.apply()?.containerId).toBe(CONTAINER_ID);
    expect(fixture.timedOut()).toBe(false);
    expect(fixture.execute.mock.calls).toHaveLength(4);
    expect(fixture.execute.mock.calls[0]?.[0].command).toContain("--startup-protocol");
  });

  it("retains the startup hold after the observer reports an active lease at its deadline", () => {
    const fixture = createOwnerLeaseDeadlineFixture(600_000);
    expect(fixture.apply).toThrow("OpenClaw owner lease did not settle before managed startup");
    expect(fixture.timedOut()).toBe(false);
    expect(fixture.execute.mock.calls).toHaveLength(4);
    expect(fixture.execute.mock.calls[0]?.[0].command).toContain("--startup-protocol");
  });

  it("retains the startup hold when the previous OpenClaw owner cannot be observed safely", () => {
    const fixture = createDockerRootApplyFixture(() => ({ resourceHandle: CONTAINER_ID }));
    fixture.execute
      .mockReturnValueOnce(LEGACY_STARTUP_PROTOCOL_RESULT)
      .mockImplementation(({ command }) => ({
        status: command.includes("python3") ? 1 : 0,
        stdout: command.includes("--shared-state-transaction-status") ? "pending\n" : "",
        stderr: "",
      }));
    expect(() =>
      applyProviderManagedStartupRootRequest({
        runtimeProvider: fixture.runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        bootstrapIdentity: "c".repeat(64),
        request: fixture.request,
        environment: {},
      }),
    ).toThrow("OpenClaw owner lease did not settle before managed startup");
    expect(fixture.execute.mock.calls.map(([call]) => call.command)).toHaveLength(4);
    expect(fixture.execute.mock.calls[0]?.[0].command).toContain("--startup-protocol");
  });

  it("retains the pending transaction when the packaged state reader is unavailable", () => {
    const fixture = createDockerRootApplyFixture(() => ({ resourceHandle: CONTAINER_ID }));
    const reader = vi
      .spyOn(ownerLease, "buildOpenClawOwnerLeaseObserver")
      .mockImplementation(() => {
        throw new Error("reader unavailable");
      });
    try {
      expect(() =>
        applyProviderManagedStartupRootRequest({
          runtimeProvider: fixture.runtimeProvider,
          sandboxName: SANDBOX_NAME,
          sandboxId: SANDBOX_ID,
          bootstrapIdentity: "c".repeat(64),
          request: fixture.request,
          environment: {},
        }),
      ).toThrow(
        expect.objectContaining({
          message: expect.stringContaining("Packaged OpenClaw state reader is unavailable"),
          managedStartupTransaction: expect.objectContaining({ containerId: CONTAINER_ID }),
        }),
      );
      expect(fixture.execute.mock.calls).toHaveLength(3);
      expect(fixture.execute.mock.calls[0]?.[0].command).toContain("--startup-protocol");
    } finally {
      reader.mockRestore();
    }
  });

  it("does not inspect owner leases again after the managed transaction is committed", () => {
    const fixture = createDockerRootApplyFixture(() => ({ resourceHandle: CONTAINER_ID }));
    fixture.execute
      .mockReturnValueOnce(LEGACY_STARTUP_PROTOCOL_RESULT)
      .mockImplementation(({ command }) => ({
        status: 0,
        stdout: command.includes("--shared-state-transaction-status") ? "committed\n" : "",
        stderr: "",
      }));
    expect(
      applyProviderManagedStartupRootRequest({
        runtimeProvider: fixture.runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        bootstrapIdentity: "c".repeat(64),
        request: fixture.request,
        environment: {},
      })?.containerId,
    ).toBe(CONTAINER_ID);
    expect(fixture.execute.mock.calls.some(([call]) => call.command.includes("python3"))).toBe(
      false,
    );
    expect(fixture.execute.mock.calls[0]?.[0].command).toContain("--startup-protocol");
  });

  it.each([
    ["openclaw", { uid: 998, gid: 998, mode: 0o755 }],
    ["hermes", { uid: 998, gid: 999, mode: 0o755 }],
    ["langchain-deepagents-code", { uid: 0, gid: 999, mode: 0o1775 }],
    ["pi", { uid: 999, gid: 999, mode: 0o755 }],
  ] as const)(
    "prepares %s workspace metadata before the first root application",
    (agent, workspace) => {
      const { request, runtimeProvider } = createDockerRootApplyFixture(
        () => ({
          resourceHandle: CONTAINER_ID,
        }),
        agent,
      );
      const control = runtimeProvider.lifecycle.privilegedSandboxControl;
      const prepare = vi.fn();
      control.prepareManagedStartupWorkspace = prepare;
      applyProviderManagedStartupRootRequest({
        runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        bootstrapIdentity: "c".repeat(64),
        request,
        environment: {},
      });
      expect(prepare).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          expectedResourceHandle: CONTAINER_ID,
          workspace,
        }),
      );
      expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(control.execute).mock.invocationCallOrder[1]!,
      );
    },
  );

  it("rejects a provider without workspace preparation before root application", () => {
    const { request, runtimeProvider } = createDockerRootApplyFixture(() => ({
      resourceHandle: CONTAINER_ID,
    }));
    const control = runtimeProvider.lifecycle.privilegedSandboxControl;
    delete control.prepareManagedStartupWorkspace;
    expect(() =>
      applyProviderManagedStartupRootRequest({
        runtimeProvider,
        request,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        bootstrapIdentity: "c".repeat(64),
        environment: {},
      }),
    ).toThrow(/cannot prepare the managed startup workspace/u);
    expect(control.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(control.execute).mock.calls[0]?.[0].command).toContain("--startup-protocol");
  });

  it("does not start root application after workspace preparation fails", () => {
    const { request, runtimeProvider } = createDockerRootApplyFixture(() => ({
      resourceHandle: CONTAINER_ID,
    }));
    const control = runtimeProvider.lifecycle.privilegedSandboxControl;
    control.prepareManagedStartupWorkspace = () => {
      throw new Error("workspace changed");
    };
    expect(() =>
      applyProviderManagedStartupRootRequest({
        runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        bootstrapIdentity: "c".repeat(64),
        request,
        environment: {},
      }),
    ).toThrow(/workspace changed/u);
    expect(control.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(control.execute).mock.calls[0]?.[0].command).toContain("--startup-protocol");
  });
  it("waits for the exact OpenShell container to appear after create returns", () => {
    const resolveTarget = vi
      .fn<() => { resourceHandle: string }>()
      .mockImplementationOnce(() => {
        throw new DirectSandboxContainerNotFoundError("container absent");
      })
      .mockImplementationOnce(() => {
        throw new DirectSandboxContainerNotFoundError("container absent");
      })
      .mockReturnValue({ resourceHandle: CONTAINER_ID });
    const { request, runtimeProvider } = createDockerRootApplyFixture(resolveTarget);
    const sleep = vi.fn();

    const transaction = applyProviderManagedStartupRootRequest(
      {
        runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        bootstrapIdentity: "c".repeat(64),
        request,
        environment: {},
      },
      { sleep },
    );

    expect(transaction?.containerId).toBe(CONTAINER_ID);
    expect(resolveTarget).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [250]]);
  });

  it("fails with bounded evidence when the exact OpenShell container stays absent", () => {
    const resolveTarget = vi.fn(() => {
      throw new DirectSandboxContainerNotFoundError("container absent");
    });
    const { request, runtimeProvider } = createDockerRootApplyFixture(resolveTarget);
    const sleep = vi.fn();

    expect(() =>
      applyProviderManagedStartupRootRequest(
        {
          runtimeProvider,
          sandboxName: SANDBOX_NAME,
          sandboxId: SANDBOX_ID,
          bootstrapIdentity: "c".repeat(64),
          request,
          environment: {},
        },
        { sleep },
      ),
    ).toThrow(/remained absent after 21 observations over \d+ms \(budget 5000ms\)/u);
    expect(resolveTarget).toHaveBeenCalledTimes(21);
    expect(sleep).toHaveBeenCalledTimes(20);
  });

  it("bounds slow container discovery by the remaining handoff deadline", () => {
    let nowMs = 10_000;
    const resolveTarget = vi.fn((input: { readonly timeoutMs?: number }) => {
      nowMs += input.timeoutMs === 5_000 ? 3_000 : 2_000;
      throw new DirectSandboxContainerNotFoundError("container absent");
    });
    const { request, runtimeProvider } = createDockerRootApplyFixture(resolveTarget);
    const sleep = vi.fn();

    expect(() =>
      applyProviderManagedStartupRootRequest(
        {
          runtimeProvider,
          sandboxName: SANDBOX_NAME,
          sandboxId: SANDBOX_ID,
          bootstrapIdentity: "c".repeat(64),
          request,
          environment: {},
        },
        { now: () => nowMs, sleep },
      ),
    ).toThrow(/remained absent after 2 observations over 5000ms \(budget 5000ms\)/u);
    expect(resolveTarget).toHaveBeenCalledTimes(2);
    expect(resolveTarget.mock.calls.map(([input]) => input.timeoutMs)).toEqual([5_000, 2_000]);
    expect(sleep.mock.calls).toEqual([[250]]);
  });

  it("does not retry ambiguous container ownership", () => {
    const resolveTarget = vi.fn(() => {
      throw new DirectSandboxFallbackUnavailableError("ambiguous container ownership");
    });
    const { request, runtimeProvider } = createDockerRootApplyFixture(resolveTarget);
    const sleep = vi.fn();

    expect(() =>
      applyProviderManagedStartupRootRequest(
        {
          runtimeProvider,
          sandboxName: SANDBOX_NAME,
          sandboxId: SANDBOX_ID,
          bootstrapIdentity: "c".repeat(64),
          request,
          environment: {},
        },
        { sleep },
      ),
    ).toThrow(/ambiguous container ownership/u);
    expect(resolveTarget).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a failed hold release on resume through the same exact Podman runtime", () => {
    const calls: Array<{ args: readonly string[]; input?: Buffer }> = [];
    let committed = false;
    let releaseAttempts = 0;
    let workspace = { uid: 0, gid: 0, mode: 0o700, dev: "1", ino: "2", mtime: 100 };
    const inspect = JSON.stringify([
      {
        Id: CONTAINER_ID,
        Image: IMAGE_ID,
        Name: `${PODMAN_SANDBOX_CONTAINER_PREFIX}${SANDBOX_NAME}-${SANDBOX_ID}`,
        Config: {
          Labels: {
            [PODMAN_MANAGED_LABEL]: "true",
            [PODMAN_SANDBOX_ID_LABEL]: SANDBOX_ID,
            [PODMAN_SANDBOX_NAME_LABEL]: SANDBOX_NAME,
            [PODMAN_SANDBOX_NAMESPACE_LABEL]: "",
            [PODMAN_SANDBOX_WORKSPACE_LABEL]: PODMAN_SANDBOX_WORKSPACE,
          },
        },
        Mounts: [],
        State: { Dead: false, Paused: false, Restarting: false, Running: true, Status: "running" },
      },
    ]);
    const capture = vi.fn((args: readonly string[], _timeoutMs?: number, input?: Buffer) => {
      calls.push({ args, ...(input ? { input } : {}) });
      const operation = [
        "--startup-protocol",
        "--shared-state-transaction-status",
        "--commit-shared-state-transaction",
        "--release-startup-hold",
      ].find((candidate) => args.includes(candidate));
      switch (operation) {
        case "--startup-protocol":
          return {
            status: 1,
            stdout: "",
            stderr: "usage: managed-startup-image-runtime --release-startup-hold",
          };
        case "--shared-state-transaction-status":
          return { status: 0, stdout: committed ? "committed\n" : "pending\n", stderr: "" };
        case "--commit-shared-state-transaction":
          committed = true;
          break;
        case "--release-startup-hold":
          releaseAttempts += 1;
          switch (releaseAttempts) {
            case 1:
              return { status: 1, stdout: "", stderr: "release unavailable" };
          }
          break;
      }
      switch (`${String(args[0])}:${String(args[1])}`) {
        case "container:cp":
          workspace = { ...workspace, uid: 998, gid: 998, mode: 0o755 };
          return { status: 0, stdout: "", stderr: "" };
        case "container:exec":
          return { status: 0, stdout: JSON.stringify(workspace), stderr: "" };
        case "ps:--all":
          return { status: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" };
        case "container:inspect":
        case "inspect:--type":
          return { status: 0, stdout: inspect, stderr: "" };
        default:
          return { status: 0, stdout: "", stderr: "" };
      }
    });
    const engine = (operation: ContainerEngineOperationScope) => ({
      ...createContainerEngineCommand({
        operation,
        engineId: "podman",
        displayName: "Podman",
        authorityId: "podman:test",
        endpointAuthorityId: "podman:test",
        executable: "podman",
        capture: (_executable, args, timeoutMs, input) => capture(args, timeoutMs, input),
      }),
      endpointAuthorityId: "podman:test",
    });
    const runtimeProvider = createPodmanRuntimeProviderBundle({
      engines: {
        hostDoctor: engine("host-doctor"),
        sandboxLifecycle: engine("sandbox-lifecycle"),
      },
    });
    const profile = managedStartupE2eProfile("openclaw", false, true, true);
    const request = createManagedStartupRootApplyRequest({
      agent: "openclaw",
      corporateCaB64: Buffer.from(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM, "utf8").toString("base64"),
      encodedProfile: encodeManagedStartupProfile(profile),
    });
    const transaction = applyProviderManagedStartupRootRequest({
      runtimeProvider,
      sandboxName: SANDBOX_NAME,
      sandboxId: SANDBOX_ID,
      bootstrapIdentity: "c".repeat(64),
      request,
      environment: {},
    });

    const copyIndex = calls.findIndex(({ args }) => args[1] === "cp");
    expect(copyIndex).toBeGreaterThan(0);
    expect(calls[copyIndex]?.args).toEqual([
      "container",
      "cp",
      "--archive=false",
      "-",
      `${CONTAINER_ID}:/`,
    ]);
    expect(calls[copyIndex]?.input?.length).toBe(1536);
    expect(copyIndex).toBeLessThan(
      calls.findIndex(({ args }) => args.includes("--apply-root-stdin")),
    );
    expect(workspace).toEqual({ uid: 998, gid: 998, mode: 0o755, dev: "1", ino: "2", mtime: 100 });
    expect(transaction).toMatchObject({
      containerId: CONTAINER_ID,
      image: IMAGE_ID,
      providerId: "podman",
    });
    expect(
      finalizeProviderManagedStartupSharedState({
        runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        transaction,
        supervisorReady: true,
      }),
    ).toEqual({ supervisorReady: true, failure: null });
    expect(() =>
      releaseProviderManagedStartupHold({
        runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        transaction: transaction!,
        profileFingerprint: request.profileFingerprint,
      }),
    ).toThrow(/release unavailable/u);
    const resumedTransaction = applyProviderManagedStartupRootRequest({
      runtimeProvider,
      sandboxName: SANDBOX_NAME,
      sandboxId: SANDBOX_ID,
      bootstrapIdentity: "c".repeat(64),
      request,
      environment: {},
    });
    expect(resumedTransaction).toEqual(transaction);
    expect(
      finalizeProviderManagedStartupSharedState({
        runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        transaction: resumedTransaction,
        supervisorReady: true,
      }),
    ).toEqual({ supervisorReady: true, failure: null });
    releaseProviderManagedStartupHold({
      runtimeProvider,
      sandboxName: SANDBOX_NAME,
      sandboxId: SANDBOX_ID,
      transaction: resumedTransaction!,
      profileFingerprint: request.profileFingerprint,
    });

    expect(calls.some(({ args }) => args.includes("--apply-root-stdin"))).toBe(true);
    expect(calls.some(({ args }) => args.includes("--commit-shared-state-transaction"))).toBe(true);
    expect(calls.some(({ args }) => args.includes("--release-startup-hold"))).toBe(true);
    const observation = calls.find(({ args }) => args.includes("python3"));
    expect(observation?.args.slice(-3)).toEqual(["python3", "-I", "-"]);
    expect(observation?.args).toContain("--interactive");
    expect(observation?.input?.toString("utf8")).toBe(ownerLease.buildOpenClawOwnerLeaseObserver());
    expect(releaseAttempts).toBe(2);
    expect(JSON.stringify(calls.map(({ args }) => args))).not.toContain("docker");
  });

  it("uses the published base-image unbound protocol without explicit hold release", () => {
    const labels = {
      "openshell.ai/managed-by": "openshell",
      "openshell.ai/sandbox-name": SANDBOX_NAME,
      "openshell.ai/sandbox-id": SANDBOX_ID,
      "openshell.ai/sandbox-workspace": "default",
    };
    const capture = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify([
        {
          Id: CONTAINER_ID,
          Image: IMAGE_ID,
          Config: { Labels: labels },
          State: { Dead: false, Paused: false, Restarting: false, Running: true },
        },
      ]),
      stderr: "",
    }));
    const execute = vi.fn((input: { readonly command: readonly string[] }) => {
      const operation = [
        "--startup-protocol",
        "--apply-root-stdin",
        "--commit-shared-state-transaction",
        "--release-startup-hold",
      ].find((candidate) => input.command.includes(candidate));
      switch (`${String(operation)}:${String(input.command.includes("--bootstrap-identity"))}`) {
        case "--startup-protocol:false":
        case "--startup-protocol:true":
          return {
            status: 1,
            stdout: "",
            stderr: "usage: managed-startup-image-runtime --apply-root-stdin",
          };
        case "--apply-root-stdin:true":
          return {
            status: 1,
            stdout: "",
            stderr:
              "usage: managed-startup-image-runtime [--apply-root-stdin|--wait-for-completion] --agent <agent>",
          };
        case "--apply-root-stdin:false":
        case "--commit-shared-state-transaction:false":
          return { status: 0, stdout: "", stderr: "" };
        default:
          return { status: 1, stdout: "", stderr: "unexpected command" };
      }
    });
    const runtimeProvider = {
      identity: { id: "docker" },
      lifecycle: {
        supported: true,
        privilegedSandboxControl: {
          resolveTarget: () => ({ resourceHandle: CONTAINER_ID }),
          prepareManagedStartupWorkspace: vi.fn(),
          execute,
        },
      },
      containerEngine: {
        supported: true,
        identities: [{ operation: "sandbox-lifecycle" }],
        capture,
      },
    } as unknown as RuntimeProviderBundle;
    const request = createManagedStartupRootApplyRequest({
      agent: "openclaw",
      corporateCaB64: Buffer.from(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM, "utf8").toString("base64"),
      encodedProfile: encodeManagedStartupProfile(
        managedStartupE2eProfile("openclaw", false, true, true),
      ),
    });

    const transaction = applyProviderManagedStartupRootRequest({
      runtimeProvider,
      sandboxName: SANDBOX_NAME,
      sandboxId: SANDBOX_ID,
      bootstrapIdentity: "c".repeat(64),
      request,
      environment: {},
    });

    expect(transaction).toMatchObject({ protocol: "legacy-unbound" });
    expect(
      finalizeProviderManagedStartupSharedState({
        runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        transaction,
        supervisorReady: true,
      }),
    ).toEqual({ supervisorReady: true, failure: null });
    releaseProviderManagedStartupHold({
      runtimeProvider,
      sandboxName: SANDBOX_NAME,
      sandboxId: SANDBOX_ID,
      transaction: transaction!,
      profileFingerprint: request.profileFingerprint,
    });

    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute.mock.calls[3]?.[0].command).not.toContain("--bootstrap-identity");
    expect(
      execute.mock.calls.some(([input]) => input.command.includes("--release-startup-hold")),
    ).toBe(false);
  });

  it.each(["docker", "podman"] as const)(
    "rolls back a definitive %s commit failure inside the exact sandbox without stop or removal",
    (providerId) => {
      const labels = {
        ...(providerId === "docker"
          ? { "openshell.ai/managed-by": "openshell" }
          : { "openshell.managed": "true" }),
        "openshell.ai/sandbox-name": SANDBOX_NAME,
        "openshell.ai/sandbox-id": SANDBOX_ID,
        "openshell.ai/sandbox-workspace": "default",
      };
      const capture = vi.fn((_args: readonly string[], _timeoutMs?: number) => ({
        status: 0,
        stdout: JSON.stringify([
          {
            Id: CONTAINER_ID,
            Image: IMAGE_ID,
            Config: { Labels: labels },
            State: { Dead: false, Paused: false, Restarting: false, Running: true },
          },
        ]),
        stderr: "",
      }));
      const execute = vi
        .fn((_input: { readonly command: readonly string[] }) => ({
          status: 0,
          stdout: "",
          stderr: "",
        }))
        .mockReturnValueOnce({ status: 1, stdout: "", stderr: "commit rejected" })
        .mockReturnValueOnce({ status: 0, stdout: "restored", stderr: "" });
      const runtimeProvider = {
        identity: { id: providerId },
        lifecycle: {
          supported: true,
          privilegedSandboxControl: {
            resolveTarget: () => ({ resourceHandle: CONTAINER_ID }),
            execute,
          },
        },
        containerEngine: {
          supported: true,
          identities: [{ operation: "sandbox-lifecycle" }],
          capture: (_operation: string, args: readonly string[], timeoutMs?: number) =>
            capture(args, timeoutMs),
        },
      } as unknown as RuntimeProviderBundle;

      const outcome = finalizeProviderManagedStartupSharedState({
        runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        transaction: {
          agent: "openclaw",
          bootstrapIdentity: "c".repeat(64),
          containerId: CONTAINER_ID,
          image: IMAGE_ID,
          protocol: "identity-bound",
          providerId,
        },
        supervisorReady: true,
      });

      expect(outcome.supervisorReady).toBe(false);
      expect(outcome.failure?.message).toContain("commit rejected");
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls[0]?.[0].command).toContain("--commit-shared-state-transaction");
      expect(execute.mock.calls[1]?.[0].command).toContain("--rollback-shared-state-transaction");
      expect(capture.mock.calls.flatMap(([args]) => args)).not.toEqual(
        expect.arrayContaining(["stop", "rm", "--force"]),
      );
    },
  );
});
