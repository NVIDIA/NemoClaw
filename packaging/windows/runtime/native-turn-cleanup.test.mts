// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { stripTypeScriptTypes, syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { qualifyNativeOpenClawTurn, stopChild } from "./run-installed-native-turn.mts";
import {
  createPrivateShareRoot,
  qualifyNativeTerminalAgent,
} from "./run-installed-native-hermes-turn.mts";
import type { NativeRuntimeSession } from "./native-runtime.mts";
import type { NativeEdgeBrowserOwner } from "./native-edge-browser.mts";
import { NativeGatewaySession } from "./native-gateway-session.mts";
import { attemptNativeUiCleanup } from "./native-ui-lifecycle.mts";

// Execute the actual finally block with stubbed process/filesystem boundaries.
// This checks sequencing without launching an installed runtime or bypassing its platform guard.
function openClawCleanupController() {
  const source = fs
    .readFileSync(new URL("./run-installed-native-turn.mts", import.meta.url), "utf8")
    .replaceAll("\r\n", "\n");
  const start = source.lastIndexOf("  } finally {") + "  } finally {".length;
  const end = source.indexOf("    if (!passed || failures.length)", start);
  assert(start > 0 && end > start);
  return new Function(
    "attemptNativeUiCleanup",
    "create",
    "stopChild",
    "passed",
    "sandboxAbsentFromRegistry",
    "sandboxDeletionRequested",
    "cliEnvironment",
    "sandboxName",
    "gateway",
    "runtimeLease",
    "gatewaySession",
    "ownedLogs",
    "fs",
    "ownedRoots",
    "runRoot",
    "gatewayLogPath",
    "gatewayErrorPath",
    "readOpenedRegularFile",
    "sanitizedDiagnostic",
    "installRoot",
    "runtimeRoot",
    "shareRoot",
    "evidenceRoot",
    "runId",
    "path",
    "removeDirectory",
    "console",
    "return " +
      stripTypeScriptTypes(`(async () => {${source.slice(start, end)}\nreturn failures;})();`, {
        mode: "strip",
      }),
  );
}

for (const status of [
  "AgentCompleted",
  "MainProcessCompleted",
  "ExecFailed",
  "MainProcessFailed",
]) {
  test(`OpenClaw waits for executor completion before normal deletion: ${status}`, async () => {
    const events: string[] = [];
    let resolveCompletion!: (status: string) => void;
    const completion = new Promise<string>((resolve) => {
      resolveCompletion = resolve;
    });
    const operation = runCleanupFragment(
      "./run-installed-native-turn.mts",
      "    const turnPassed =",
      "    if (!(await gatewaySession.stopGateway()))",
      {
        cliEnvironment: {},
        sandboxName: "owned-sandbox",
        gateway: {},
        runtimeLease: {},
        sandboxDeletionRequested: false,
        sandboxAbsentFromRegistry: false,
        result: {
          executionMode: "embedded-worker",
          version: "2026.9.2",
          versionExitCode: 0,
          chatExitCode: 0,
          exactReply: true,
          reply: "CHAT_OK",
        },
        console: { log() {} },
        fail(message: string) {
          throw new Error(message);
        },
        gatewaySession: {
          waitForCompletion() {
            events.push("completion");
            return completion;
          },
          async deleteWorkload() {
            events.push("delete");
          },
          async confirmRegistryEmpty() {
            events.push("registry");
          },
        },
      },
      "({ sandboxDeletionRequested, sandboxAbsentFromRegistry })",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["completion"]);
    resolveCompletion(status);
    if (status === "ExecFailed" || status === "MainProcessFailed") {
      await assert.rejects(operation, /failed MXC workload termination/);
      assert.deepEqual(events, ["completion"]);
    } else {
      assert.deepEqual(await operation, {
        sandboxDeletionRequested: true,
        sandboxAbsentFromRegistry: true,
      });
      assert.deepEqual(events, ["completion", "delete", "registry"]);
    }
  });
}

for (const failure of [
  "none",
  "request-stop",
  "gateway-stop",
  "gateway-dispose",
  "registry",
  "before-create",
  "already-absent",
  "deletion-requested",
  "deletion-requested-registry",
] as const) {
  test(`OpenClaw turn retains temporary roots when cleanup is unconfirmed: ${failure}`, async () => {
    const removed: string[] = [];
    const roots = ["owned-run", "owned-share", "owned-runtime"];
    const gateway = { pid: 1234 };
    const errors = await openClawCleanupController()(
      attemptNativeUiCleanup,
      failure === "before-create" ? undefined : { pid: 5678 },
      async () => failure !== "request-stop",
      false,
      ["before-create", "already-absent"].includes(failure),
      failure.startsWith("deletion-requested"),
      {},
      "owned-sandbox",
      gateway,
      {},
      {
        async deleteWorkload() {
          assert.notEqual(failure, "already-absent", "Confirmed removal must not be repeated");
          assert.notEqual(failure, "deletion-requested", "An uncertain mutation must not repeat");
          assert.notEqual(
            failure,
            "deletion-requested-registry",
            "An uncertain mutation must not repeat",
          );
        },
        async confirmRegistryEmpty() {
          assert.notEqual(failure, "already-absent", "Confirmed absence survives gateway shutdown");
          if (["registry", "deletion-requested-registry"].includes(failure))
            throw new Error("unconfirmed registry");
        },
        async stopGateway() {
          return failure !== "gateway-stop";
        },
        async dispose() {
          if (failure === "gateway-stop" || failure === "gateway-dispose")
            throw new Error("unconfirmed gateway cleanup");
        },
      },
      new Set(),
      { closeSync() {}, writeFileSync() {} },
      roots,
      roots[0],
      "owned-stdout",
      "owned-stderr",
      () => null,
      () => "",
      "owned-install",
      roots[2],
      roots[1],
      "owned-evidence",
      "fixture",
      path,
      async (directory: string) => {
        removed.push(directory);
        return true;
      },
      { error() {} },
    );
    if (
      [
        "request-stop",
        "gateway-stop",
        "gateway-dispose",
        "registry",
        "deletion-requested-registry",
      ].includes(failure)
    ) {
      assert.deepEqual(removed, [], "Unconfirmed process cleanup must not remove any owned root.");
      assert.equal(
        errors.filter((label: string) => label.startsWith("temporary root removal:")).length,
        3,
      );
    } else {
      assert.deepEqual(removed, roots);
      assert.deepEqual(errors, []);
    }
    assert.equal(
      errors.includes("sandbox registry verification"),
      ["registry", "deletion-requested-registry"].includes(failure),
    );
  });
}

function runCleanupFragment(
  file: string,
  startMarker: string,
  endMarker: string,
  context: Record<string, unknown>,
  result: string,
) {
  const source = fs.readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const start = source.lastIndexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0 && end > start);
  const code = stripTypeScriptTypes(
    `(async () => { let {${Object.keys(context).join(",")}} = context;\n${source.slice(start, end)}\nreturn ${result}; })()`,
    { mode: "strip" },
  );
  return new Function("context", `return ${code}`)(context);
}

for (const failure of [
  "none",
  "request-stop",
  "gateway-cleanup",
  "ui-owner",
  "inference-owner",
  "registry",
  "before-create",
] as const) {
  test(`OpenClaw web cleanup retains roots until backend cleanup is confirmed: ${failure}`, async () => {
    const removed: string[] = [];
    const roots = ["web-run", "web-share", "web-runtime"];
    const recovery: Record<string, unknown>[] = [];
    const errors = await runCleanupFragment(
      "./run-installed-native-web-ui.mts",
      '    const runId = randomBytes(5).toString("hex");',
      "    try {\n      stateSession?.assertHeld();",
      {
        randomBytes: () => Buffer.alloc(5),
        cleanupPromise: undefined,
        attemptNativeUiCleanup,
        monitoring: new AbortController(),
        monitor: undefined,
        uiRelay: {
          async close() {},
          async dispose() {
            if (failure === "ui-owner") throw new Error("UI file owner remains");
          },
        },
        brokerRelay: {
          async close() {},
          async dispose() {
            if (failure === "inference-owner") throw new Error("inference file owner remains");
          },
        },
        onboarding: null,
        create: failure === "before-create" ? undefined : { pid: 5678 },
        gateway: { pid: 1234 },
        gatewaySession: {
          async requestWorkloadDeletion() {},
          async confirmRegistryEmpty() {
            if (failure === "registry") throw new Error("unconfirmed registry");
          },
          async stopGateway() {
            return failure !== "gateway-cleanup";
          },
          async dispose() {
            if (failure === "gateway-cleanup") throw new Error("unconfirmed gateway");
          },
        },
        stopChild: async () => failure !== "request-stop",
        openshell: "fixture",
        cliEnvironment: {},
        sandboxName: "fixture",
        stateSession: null,
        creation: undefined,
        ownedLogs: [],
        gatewayLogPath: "",
        gatewayErrorPath: "",
        ownedRoots: roots,
        diagnostics: {
          capture(_channel: string, text: string) {
            recovery.push(JSON.parse(text));
          },
        },
        removeDirectory: async (directory: string) => {
          removed.push(directory);
          return true;
        },
        inferenceBroker: null,
      },
      "await cleanup()",
    );
    if (
      ["request-stop", "gateway-cleanup", "ui-owner", "inference-owner", "registry"].includes(
        failure,
      )
    ) {
      assert.deepEqual(removed, []);
      assert(errors.includes("temporary runtime directories"));
      assert.deepEqual(recovery, [
        {
          sandboxName: "fixture",
          sandboxAbsentFromRegistry: failure !== "registry",
          retainedRuntimeRoots: roots,
        },
      ]);
    } else {
      assert.deepEqual(removed, roots);
      assert.deepEqual(errors, []);
    }
    assert.equal(errors.includes("sandbox registry"), failure === "registry");
  });
}

for (const registryFails of [false, true])
  for (const deletionRequested of [false, true]) {
    test(`Hermes console failure cleanup records confirmed sandbox absence: ${registryFails}, deletion requested: ${deletionRequested}`, async () => {
      const failures: string[] = [];
      const absent = await runCleanupFragment(
        "./run-installed-native-console-agent.mts",
        "      if (!passed) {",
        "      const gatewayStopped = await gatewaySession.stopGateway();",
        {
          passed: false,
          sandboxAbsentFromRegistry: false,
          sandboxDeletionRequested: deletionRequested,
          sandboxName: "owned-sandbox",
          diagnostics: {
            cleanupFailed(label: string) {
              failures.push(label);
            },
            capture() {},
          },
          statusFiles: { async write() {} },
          runId: "fixture",
          relay: null,
          brokerRelay: null,
          browserRelay: null,
          openshell: "fixture",
          cliEnvironment: {},
          gateway: {},
          stateSession: {},
          gatewaySession: {
            async requestWorkloadDeletion() {
              assert.equal(deletionRequested, false, "An uncertain mutation must not repeat");
            },
            async confirmRegistryEmpty() {
              if (registryFails) throw new Error("registry unavailable");
            },
          },
        },
        "sandboxAbsentFromRegistry",
      );
      assert.equal(absent, !registryFails);
      assert.deepEqual(failures, registryFails ? ["native sandbox registry"] : []);
    });
  }

for (const file of [
  "./run-installed-native-turn.mts",
  "./run-installed-native-hermes-turn.mts",
  "./run-installed-native-console-agent.mts",
])
  for (const failure of ["deletion", "registry"]) {
    test(`${file} records deletion before an uncertain ${failure} result`, async () => {
      const source = fs
        .readFileSync(new URL(file, import.meta.url), "utf8")
        .replaceAll("\r\n", "\n");
      const deletion = source.indexOf("await gatewaySession.deleteWorkload(");
      const requested = source.lastIndexOf("sandboxDeletionRequested = true;", deletion);
      const start = requested < 0 ? deletion : requested;
      const end = source.indexOf("sandboxAbsentFromRegistry = true;", deletion);
      assert(deletion > 0 && start >= 0 && end > deletion);
      const primary = new Error(`Uncertain ${failure} response`);
      const context = {
        sandboxDeletionRequested: false,
        sandboxAbsentFromRegistry: false,
        sandboxName: "owned-sandbox",
        cliEnvironment: {},
        agentLabel: "Hermes",
        gateway: {},
        runtimeLease: {},
        stateSession: {},
        create: null,
        passed: false,
        gatewaySession: {
          async deleteWorkload() {
            if (failure === "deletion") throw primary;
          },
          async confirmRegistryEmpty() {
            throw primary;
          },
        },
      };
      const code = stripTypeScriptTypes(
        `(async () => {
          let {${Object.keys(context).join(",")}} = context;
          try { ${source.slice(start, end)} } catch (error) {
            return { error, sandboxDeletionRequested, sandboxAbsentFromRegistry };
          }
          throw new Error("The uncertain operation must fail.");
        })()`,
        { mode: "strip" },
      );
      const result = await new Function("context", `return ${code}`)(context);
      assert.equal(result.error, primary);
      assert.equal(result.sandboxDeletionRequested, true);
      assert.equal(result.sandboxAbsentFromRegistry, false);
    });
  }

for (const failure of [
  "none",
  "gateway-stop",
  "gateway-cleanup",
  "file-owner",
  "registry",
] as const) {
  test(`console cleanup retains temporary roots when an owner cannot stop: ${failure}`, async () => {
    const removed: string[] = [];
    const roots = ["console-run", "console-runtime", "dashboard", "status", "broker", "browser"];
    const errors = await runCleanupFragment(
      "./run-installed-native-console-agent.mts",
      "    const cleanupFailures: string[] = [];",
      "    let released = false;",
      {
        sandboxName: "owned-sandbox",
        sandboxAbsentFromRegistry: failure !== "registry",
        diagnostics: { capture() {} },
        relay: {
          async close() {},
          async dispose() {
            if (failure === "file-owner") throw new Error("file owner still running");
          },
        },
        statusFiles: null,
        brokerRelay: null,
        browserRelay: null,
        edgeOwner: null,
        broker: null,
        consoleAttachment: { async dispose() {} },
        gatewaySession: {
          async stopGateway() {
            return failure !== "gateway-stop";
          },
          async dispose() {
            if (failure === "gateway-cleanup") throw new Error("unconfirmed gateway");
          },
        },
        runRoot: roots[0],
        runtimeRoot: roots[1],
        dashboardRelayRoot: roots[2],
        statusRoot: roots[3],
        brokerRelayRoot: roots[4],
        browserRelayRoot: roots[5],
        consoleSessionEnded: false,
        removeDirectory: async (directory: string) => {
          removed.push(directory);
          return true;
        },
      },
      "cleanupFailures",
    );
    if (failure === "none") {
      assert.deepEqual(removed, roots);
      assert.deepEqual(errors, []);
    } else {
      assert.deepEqual(removed, []);
      assert.equal(
        errors.filter((label: string) => label === "temporary runtime removal").length,
        6,
      );
    }
  });
}

for (const failure of ["none", "edge", "broker", "browser", "status", "removal"] as const) {
  test(`console cleanup retains temporary roots through final owner shutdown: ${failure}`, async () => {
    const roots = ["run", "runtime", "dashboard", "status", "broker", "browser"];
    const present = new Set([...roots, "private-gateway", "state"]);
    const removed: string[] = [];
    const events: string[] = [];
    const receipts = new Map<string, Record<string, unknown>>();
    let statusClosed = false;
    const context = {
      sandboxName: "owned-sandbox",
      sandboxAbsentFromRegistry: true,
      diagnostics: { capture() {} },
      gatewaySession: {
        root: "private-gateway",
        async stopGateway() {
          return true;
        },
        async dispose() {
          present.delete("private-gateway");
        },
      },
      dashboardGatewayStopped: false,
      sessionPassed: true,
      passed: true,
      consoleSessionEnded: false,
      consoleAttachment: { async dispose() {} },
      relay: { async close() {}, async dispose() {} },
      statusFiles: {
        async close() {
          events.push("status");
          if (failure === "status") throw new Error("status owner remains");
          statusClosed = true;
        },
      },
      brokerRelay: {
        async dispose() {
          events.push("broker");
          if (failure === "broker") throw new Error("broker owner remains");
        },
      },
      browserRelay: {
        async dispose() {
          events.push("browser");
          if (failure === "browser") throw new Error("browser owner remains");
        },
      },
      edgeOwner: {
        async close() {
          events.push("edge");
          assert(present.has("run"), "Edge profile must remain until its owner stops.");
          if (failure === "edge") throw new Error("Edge remains");
        },
      },
      broker: null,
      runRoot: roots[0],
      runtimeRoot: roots[1],
      dashboardRelayRoot: roots[2],
      statusRoot: roots[3],
      brokerRelayRoot: roots[4],
      browserRelayRoot: roots[5],
      agentRuntimeRoot: "state",
      consoleEvidenceRoot: "evidence",
      agentId: "hermes",
      path,
      probeRelative: "probe",
      exitRelative: "exit",
      readStatus: async (relative: string) => {
        assert(!statusClosed, "Capture status before closing its owner.");
        events.push("read-" + relative);
        return JSON.stringify({ kind: relative });
      },
      fs: {
        existsSync: (directory: string) => present.has(directory),
        writeFileSync: (file: string, text: string) => {
          const name = path.basename(file);
          events.push(name);
          receipts.set(name, JSON.parse(text));
        },
      },
      removeDirectory: async (directory: string) => {
        removed.push(directory);
        events.push("remove-" + directory);
        if (failure === "removal" && directory === "run") return false;
        present.delete(directory);
        return true;
      },
      fail: (message: string) => {
        throw new Error(message);
      },
    };
    Object.assign(
      context,
      await runCleanupFragment(
        "./run-installed-native-console-agent.mts",
        "      const gatewayStopped = await gatewaySession.stopGateway();",
        "\n    }\n  } catch (error) {",
        context,
        "({ consoleSessionEnded, dashboardGatewayStopped })",
      ),
    );
    assert.deepEqual(removed, [], "Inner cleanup must leave root removal to final owners.");
    assert(!receipts.has("interactive-session-end.json"), "Do not publish early cleanup success.");
    assert.deepEqual([...receipts.keys()], ["contained-console.json", "agent-exit.json"]);
    const failures = await runCleanupFragment(
      "./run-installed-native-console-agent.mts",
      "    const cleanupFailures: string[] = [];",
      "    let released = false;",
      context,
      "cleanupFailures",
    );
    const end = receipts.get("interactive-session-end.json");
    assert(end, "Publish the final observed cleanup result.");
    assert.equal(end.ephemeralRootsRemoved, failure === "none");
    assert.equal(end.persistentStateRetained, true);
    assert.equal(end.gatewayStopped, true);
    assert.equal(end.sandboxDeleted, true);
    for (const owner of ["status", "broker", "browser", "edge"])
      assert(events.indexOf(owner) < events.indexOf("interactive-session-end.json"));
    if (failure === "none" || failure === "removal") {
      assert.deepEqual(removed, roots);
      assert(events.indexOf("edge") < events.indexOf("remove-run"));
    } else {
      assert.deepEqual(removed, []);
      assert.equal(
        failures.filter((label: string) => label === "temporary runtime removal").length,
        6,
      );
    }
    assert.equal(failures.length === 0, failure === "none");
  });
}

test("Edge startup cleanup keeps the caller owner when readiness rejects", async () => {
  const source = fs
    .readFileSync(new URL("./run-installed-native-console-agent.mts", import.meta.url), "utf8")
    .replaceAll("\r\n", "\n");
  const start = source.indexOf("      edge = await startNativeEdgeBrowser({");
  const end = source.indexOf("      diagnostics.capture(", start);
  assert(start >= 0 && end > start);
  const cleanupError = new Error("Edge is still running");
  const primary = new Error("Edge startup failed");
  const owner = {
    async close() {
      throw cleanupError;
    },
  };
  const result = await new Function(
    "startNativeEdgeBrowser",
    "path",
    "process",
    "return " +
      stripTypeScriptTypes(
        `(async () => {
      let edge, edgeOwner; const runRoot = "run", webSession = undefined;
      try { ${source.slice(start, end)} } catch (error) { return {edge, edgeOwner, error}; }
      throw new Error("Fixture startup must fail.");
    })();`,
        { mode: "strip" },
      ),
  )(
    async (options: { onOwner(value: typeof owner): void }) => {
      options.onOwner(owner);
      throw primary;
    },
    path,
    { env: {} },
  );
  assert.equal(result.edge, undefined);
  assert.equal(result.edgeOwner, owner);
  assert.equal(result.error, primary);
  const removed: string[] = [];
  const failures = await runCleanupFragment(
    "./run-installed-native-console-agent.mts",
    "    const cleanupFailures: string[] = [];",
    "    let released = false;",
    {
      sandboxName: "",
      sandboxAbsentFromRegistry: true,
      diagnostics: { capture() {} },
      relay: null,
      statusFiles: null,
      brokerRelay: null,
      browserRelay: null,
      edgeOwner: result.edgeOwner,
      broker: null,
      consoleAttachment: null,
      gatewaySession: undefined,
      consoleSessionEnded: false,
      runRoot: "run",
      runtimeRoot: "runtime",
      dashboardRelayRoot: undefined,
      statusRoot: undefined,
      brokerRelayRoot: "broker",
      browserRelayRoot: undefined,
      removeDirectory: async (directory: string) => {
        removed.push(directory);
        return true;
      },
    },
    "cleanupFailures",
  );
  assert.deepEqual(removed, []);
  assert(failures.includes("Microsoft Edge shutdown"));
  assert.equal(failures.filter((value: string) => value === "temporary runtime removal").length, 3);
});

for (const fault of [
  "startup",
  "stop",
  "remove",
  "success",
  "identity-abort",
  "owner",
  "process-error",
  "timeout",
  "output-limit",
] as const) {
  test(`Edge startup cleanup retains an owner through failure: ${fault}`, async () => {
    const source = fs.readFileSync(new URL("./native-edge-browser.mts", import.meta.url), "utf8");
    const start = source.indexOf("export async function startNativeEdgeBrowser(");
    assert(start >= 0);
    const profile = "owned-profile";
    const present = new Set<string>();
    const events: string[] = [];
    const primary = new Error("owned startup failure");
    const cleanupError = new Error("owned cleanup failure");
    const abort = new AbortController();
    let owner: NativeEdgeBrowserOwner | undefined;
    let stops = 0;
    let now = 0;
    let kills = 0;
    const child = Object.assign(new EventEmitter(), {
      pid: 1234,
      exitCode: null as number | null,
      signalCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill() {
        kills++;
      },
    });
    const context = {
      Date: { now: () => now },
      detectNativeEdge: async () => ({ path: "sealed-edge", sha256: "fixture" }),
      spawn: () => child,
      fs: {
        existsSync: (file: string) => present.has(file),
        mkdirSync: (file: string) => {
          present.add(file);
        },
        rmSync: (file: string) => {
          events.push("remove");
          assert.equal(child.exitCode, 0, "Do not remove the profile before confirmed stop.");
          if (fault === "remove") throw cleanupError;
          present.delete(file);
        },
      },
      path,
      stopEdge: async () => {
        stops++;
        events.push("stop");
        if (fault === "stop") throw cleanupError;
        child.exitCode = 0;
        child.stderr.emit("data", Buffer.from("; shutdown"));
      },
      readNativeEdgeEndpoint: () => {
        if (fault === "timeout") {
          now = 15_000;
          return null;
        }
        if (!["success", "identity-abort", "process-error", "output-limit"].includes(fault))
          throw primary;
        return { port: 12345, path: "/devtools/browser/fixture" };
      },
      transientEdgeEndpointRead: () => false,
      nativeProcessIdentity: async () => {
        if (fault === "identity-abort") abort.abort(primary);
        return { pid: 1234, path: "sealed-edge", creationFiletime: "123456789012345678" };
      },
      hash: () => ({ sha256: "fixture" }),
    };
    const controller = new Function(
      ...Object.keys(context),
      stripTypeScriptTypes(source.slice(start).replace("export ", ""), { mode: "strip" }) +
        "\nreturn startNativeEdgeBrowser;",
    )(...Object.values(context));
    const operation = controller({
      profileRoot: profile,
      environment: { NEMOCLAW_RUNTIME_JOB_OWNED: "1" },
      signal: abort.signal,
      onOwner: (value: typeof owner) => {
        owner = value;
        events.push("owner");
        child.stdout.emit("data", Buffer.from("owned startup output"));
        child.stderr.emit("data", Buffer.from("owned startup error"));
        if (fault === "output-limit") child.stdout.emit("data", Buffer.alloc(70 * 1024, "x"));
        if (fault === "owner") throw primary;
      },
    });
    if (fault === "success" || fault === "process-error") {
      const ready = await operation;
      assert(owner, "Transfer cleanup ownership before returning readiness.");
      assert.equal(ready.close, owner.close);
      if (fault === "process-error") {
        let reported: unknown;
        void ready.failure.catch((error: unknown) => {
          reported = error;
        });
        child.emit("error", primary);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(reported, primary, "The session monitor must receive child-process errors.");
      }
      const firstClose = owner.close();
      assert.equal(owner.close(), firstClose, "Shutdown has one memoized owner.");
      await firstClose;
    } else {
      await assert.rejects(operation, (error: unknown) => {
        if (fault === "stop" || fault === "remove") {
          assert(error instanceof AggregateError);
          assert.deepEqual(error.errors, [primary, cleanupError]);
          assert.equal(error.cause, primary);
        } else if (fault === "timeout")
          assert.match(String(error), /did not become ready within its host startup bound/u);
        else if (fault === "output-limit")
          assert.match(String(error), /startup output exceeded its bound/u);
        else assert.equal(error, primary);
        return true;
      });
      assert(owner, "Startup failure must not discard the cleanup owner.");
      if (fault === "stop" || fault === "remove") await assert.rejects(owner.close(), cleanupError);
      else await owner.close();
    }
    assert.equal(stops, 1, "Outer cleanup must observe the same shutdown, not retry it.");
    assert.equal(present.has(profile), fault === "stop" || fault === "remove");
    assert.equal(events[0], "owner");
    assert.equal(events.includes("remove"), fault !== "stop");
    const observed = owner.diagnostics();
    assert.deepEqual(observed.identity, { path: "sealed-edge", sha256: "fixture" });
    assert.equal(observed.pid, 1234);
    assert.equal(observed.startup?.exitCode, null, "Keep the pre-cleanup process state.");
    assert.equal(observed.startup?.elapsedMs, fault === "timeout" ? 15_000 : 0);
    assert.equal(
      observed.startup?.endpointPublished,
      ["success", "identity-abort", "process-error", "output-limit"].includes(fault),
    );
    assert.equal(observed.exitCode, fault === "stop" ? null : 0);
    assert.equal(observed.signalCode, null);
    assert.equal(observed.outputExceeded, fault === "output-limit");
    assert.equal(kills, fault === "output-limit" ? 1 : 0);
    assert.equal(observed.stdout.length, fault === "output-limit" ? 64 * 1024 : 20);
    assert.equal(observed.stderr, "owned startup error" + (fault === "stop" ? "" : "; shutdown"));
    assert.deepEqual(JSON.parse(JSON.stringify(observed)), observed);
    observed.startup!.exitCode = 99;
    observed.identity.path = "changed snapshot";
    assert.equal(owner.diagnostics().startup?.exitCode, null);
    assert.equal(owner.diagnostics().identity.path, "sealed-edge");
  });
}

// Fault injection executes the actual qualification owner. Filesystem calls are
// mocked before entry; no installed runtime, service, sandbox or host path is changed.
async function scenario(
  t: TestContext,
  fault:
    | "second-root"
    | "config"
    | "retained"
    | "existing"
    | "private-failure"
    | "private-timeout"
    | "private-retained"
    | "private-unconfirmed",
  agent: "openclaw" | "hermes",
) {
  const originalArgv = process.argv;
  const originalInstall = process.env.NEMOCLAW_NATIVE_INSTALL_ROOT;
  const artifact = path.join(process.env.SystemDrive!, "\\", "owned-turn-test-evidence");
  process.argv = [
    process.execPath,
    "owned-test",
    "--artifact-directory",
    artifact,
    "--qualification",
    "--agent",
    agent,
  ];
  process.env.NEMOCLAW_NATIVE_INSTALL_ROOT = path.join(
    process.env.SystemDrive!,
    "\\",
    "owned-turn-test-install",
  );
  const roots = new Set<string>();
  const created: string[] = [];
  const removed: string[] = [];
  const receipts: Record<string, unknown>[] = [];
  const diagnostics: string[] = [];
  const primary = new Error("owned-primary-preparation-failure");
  const terminal = agent !== "openclaw";
  const privateFault = fault.startsWith("private-");
  let preflightCalls = 0;
  t.mock.method(NativeGatewaySession.prototype, "preflightConfiguration", (file: string) => {
    assert(privateFault, "Earlier preparation failures must not reach runtime preflight.");
    assert.equal(path.basename(file), "mxc-gateway.toml");
    preflightCalls++;
  });
  const sharePrefix = terminal ? "NemoClawNativeAgentShare-" : "NemoClawNativeShare-";
  const secondPrefix = terminal ? "NemoClawNativeAgentRuntime-" : sharePrefix;
  const runPrefix = terminal ? "NemoClawNativeAgent-" : "NemoClawNativeTurn-";
  const creator = Object.assign(new EventEmitter(), {
    pid: 987654,
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => {
      if (fault !== "private-retained")
        setImmediate(() => {
          creator.signalCode = "SIGTERM";
          creator.emit("exit", null, "SIGTERM");
          creator.emit("close", null, "SIGTERM");
        });
      return fault !== "private-retained";
    },
  });
  t.mock.method(
    childProcess,
    "spawn",
    (file: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      assert(privateFault, "Preparation faults must not start any process.");
      assert.match(file, /WindowsPowerShell.*powershell[.]exe$/u);
      const privateRoot = options.env.NEMOCLAW_NATIVE_SHARE_ROOT!;
      assert(privateRoot.includes(sharePrefix));
      assert(!roots.has(privateRoot), "The private creator must claim a fresh path.");
      roots.add(privateRoot);
      if (fault !== "private-unconfirmed") {
        created.push(privateRoot);
        setImmediate(() => {
          creator.stdout.emit("data", Buffer.from("NEMOCLAW_PRIVATE_"));
          creator.stdout.emit("data", Buffer.from("SHARE_CREATED\r"));
          creator.stdout.emit("data", Buffer.from("\n"));
        });
      }
      if (fault === "private-failure")
        setImmediate(() => {
          creator.exitCode = 1;
          creator.emit("exit", 1, null);
          creator.emit("close", 1, null);
        });
      return creator;
    },
  );
  syncBuiltinESMExports();
  let templateRead = false;
  const template = '[openshell.drivers.mxc]\nwxc_exec_path = "old.exe"\n';
  t.mock.method(fs, "fstatSync", () => ({ isFile: () => true, size: Buffer.byteLength(template) }));
  t.mock.method(fs, "readSync", (_fd: number, buffer: Buffer) => {
    if (templateRead) return 0;
    templateRead = true;
    return buffer.write(template);
  });
  t.mock.method(fs, "closeSync", () => {});
  t.mock.method(fs, "statSync", () => ({ isFile: () => true, isDirectory: () => true }));
  t.mock.method(fs, "realpathSync", (file: string) => file);
  t.mock.method(
    fs,
    "existsSync",
    (file: string) =>
      roots.has(String(file)) || (fault === "existing" && String(file).includes(sharePrefix)),
  );
  t.mock.method(fs, "mkdirSync", (file: string) => {
    if (fault === "second-root" && file.includes(secondPrefix)) throw primary;
    roots.add(file);
    if (file !== artifact) created.push(file);
  });
  t.mock.method(fs, "openSync", (file: string) => {
    if (file.endsWith("mxc-gateway.toml")) {
      if (privateFault) return 42;
      throw primary;
    }
    throw Object.assign(new Error("owned missing diagnostic"), { code: "ENOENT" });
  });
  t.mock.method(fs, "rmSync", (file: string) => {
    assert(created.includes(file), "Only a root acquired by this call may be removed.");
    removed.push(file);
    if (fault === "retained" && file.includes(runPrefix)) throw new Error("owned-removal-failure");
    if (privateFault && file.includes(sharePrefix))
      assert(
        creator.exitCode !== null || creator.signalCode !== null,
        "Confirm creator exit before removing its share.",
      );
    for (const root of roots)
      if (root === file || root.startsWith(file + path.sep)) roots.delete(root);
  });
  t.mock.method(fs, "writeFileSync", (file: string, content: string) => {
    if (privateFault && file.endsWith("mxc-gateway.toml")) return;
    assert(file.startsWith(artifact + path.sep));
    receipts.push(JSON.parse(content));
  });
  t.mock.method(console, "error", (message: string) => diagnostics.push(message));
  t.mock.method(console, "log", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const installation = process.env.NEMOCLAW_NATIVE_INSTALL_ROOT!;
    const runtimeId = "a".repeat(64);
    const runtimeRoot = path.join(installation, "runtimes", runtimeId);
    const agentRoot = path.join(runtimeRoot, agent);
    const lease = {
      purpose: agent,
      runtimeId,
      runtimeRoot,
      agentRoot,
      node: path.join(installation, "bin", "node.exe"),
      python: path.join(agentRoot, "hermes-agent", "venv", "Scripts", "python.exe"),
      bash: path.join(agentRoot, "git", "bin", "bash.exe"),
      assertHeld: () => {},
    } as NativeRuntimeSession;
    const qualify = terminal ? qualifyNativeTerminalAgent : qualifyNativeOpenClawTurn;
    const completion = assert.rejects(qualify(lease), (error: unknown) => {
      if (fault === "private-retained") {
        assert(error instanceof Error);
        assert.match(error.message, /owned process did not close/u);
        assert(error.cause instanceof Error);
        assert.match(error.cause.message, /timed out/u);
        return true;
      }
      return fault === "existing"
        ? error instanceof Error && /qualification roots? already exist/u.test(error.message)
        : privateFault
          ? error instanceof Error &&
            error.message.includes(fault === "private-failure" ? "exited 1" : "timed out")
          : error === primary;
    });
    // Attach a handler while fake time advances; retain the assertion failure
    // for the awaited result so mocks are always restored by this scenario.
    void completion.catch(() => {});
    for (let tick = 0; tick < (privateFault ? 75 : 8); tick++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1000);
    }
    await completion;
    assert.equal(preflightCalls, privateFault ? 1 : 0);
    assert(roots.has(artifact), "The evidence directory must be retained.");
    assert.equal(
      created.length,
      fault === "second-root"
        ? 1
        : fault === "existing"
          ? terminal
            ? 2
            : 1
          : terminal && (!privateFault || fault === "private-unconfirmed")
            ? 2
            : 3,
    );
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].verdict, "fail");
    assert.equal(
      receipts[0].ownedQualificationRootsRemoved,
      fault !== "retained" && fault !== "private-retained",
    );
    if (fault === "retained") {
      assert.equal(removed.filter((file) => file.includes(runPrefix)).length, 5);
      assert.equal((receipts[0].retainedQualificationRoots as string[]).length, 1);
      assert.match(diagnostics.join("\n"), /Cleanup also failed: temporary root removal/);
      assert.equal(roots.size, 2, "Evidence and the explicitly retained root remain.");
    } else if (fault === "private-retained") {
      assert.equal(removed.filter((file) => file.includes(sharePrefix)).length, 0);
      assert.equal((receipts[0].retainedQualificationRoots as string[]).length, 1);
      assert((receipts[0].cleanupFailures as string[]).includes("private share creator stop"));
      assert.equal(roots.size, 2, "Retain evidence and the private share until the creator exits.");
    } else if (fault === "private-unconfirmed") {
      assert.equal(removed.filter((file) => file.includes(sharePrefix)).length, 0);
      assert.equal((receipts[0].retainedQualificationRoots as string[]).length, 0);
      assert.equal(typeof receipts[0].unconfirmedShareRoot, "string");
      assert(
        (receipts[0].cleanupFailures as string[]).includes("private share ownership verification"),
      );
      assert.equal(roots.size, 2, "Retain the unconfirmed path without claiming ownership.");
    } else {
      assert.equal(roots.size, 1);
      assert.deepEqual(
        receipts[0].cleanupFailures,
        terminal && fault === "existing" ? ["private share ownership verification"] : [],
      );
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    process.argv = originalArgv;
    if (originalInstall === undefined) delete process.env.NEMOCLAW_NATIVE_INSTALL_ROOT;
    else process.env.NEMOCLAW_NATIVE_INSTALL_ROOT = originalInstall;
  }
}

for (const agent of ["openclaw", "hermes"] as const)
  for (const fault of [
    "second-root",
    "config",
    "retained",
    "existing",
    ...(agent === "openclaw"
      ? []
      : ["private-failure", "private-timeout", "private-retained", "private-unconfirmed"]),
  ] as const)
    test(
      `${agent} qualification cleanup: ${fault}`,
      {
        skip: process.platform !== "win32" || process.arch !== "arm64",
      },
      (t) => scenario(t, fault as Parameters<typeof scenario>[1], agent),
    );

// This component check exercises only a fresh temporary directory and the real
// Windows security API; it does not start an installed runtime or gateway.
test(
  "private share creation enforces its DACL and refuses an existing directory",
  {
    skip: process.platform !== "win32" || process.arch !== "arm64",
    timeout: 150_000,
  },
  async (t) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-private-share-control-"));
    const share = path.join(fixture, "share");
    const creators: childProcess.ChildProcess[] = [];
    let claims = 0;
    const spawn = childProcess.spawn;
    let explicitModuleCalls = 0;
    t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
      const arguments_ = [...args[1]!];
      const encodedIndex = arguments_.indexOf("-EncodedCommand") + 1;
      assert(encodedIndex > 0, "The private creator must receive its encoded script.");
      const script = Buffer.from(arguments_[encodedIndex]!, "base64").toString("utf16le");
      arguments_[encodedIndex] = Buffer.from(
        "$PSModuleAutoLoadingPreference = 'None'\n" + script,
        "utf16le",
      ).toString("base64");
      explicitModuleCalls++;
      return spawn(args[0], arguments_, args[2]);
    });
    syncBuiltinESMExports();
    try {
      const acl = await createPrivateShareRoot(
        share,
        process.env.SystemRoot!,
        (child) => creators.push(child),
        () => {
          claims++;
        },
      );
      assert.equal(claims, 1);
      assert.equal(acl.protected, true);
      assert.equal(acl.nonOwnerDataAccess, false);
      assert.equal(acl.serviceSid, "S-1-5-18");
      assert.deepEqual(acl.deniedSids, ["S-1-1-0", "S-1-5-11", "S-1-5-32-545"]);
      const retainedFile = path.join(share, "retained.txt");
      fs.writeFileSync(retainedFile, "existing-content", { flag: "wx" });
      await assert.rejects(
        createPrivateShareRoot(
          share,
          process.env.SystemRoot!,
          (child) => creators.push(child),
          () => {
            claims++;
          },
        ),
        /Private share root already exists/u,
      );
      assert.equal(
        explicitModuleCalls,
        2,
        "Both creation and refusal must work without autoloading.",
      );
      assert.equal(claims, 1, "An existing directory must not transfer ownership.");
      assert.equal(fs.readFileSync(retainedFile, "utf8"), "existing-content");
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      const stopped = await Promise.all(creators.map(stopChild));
      assert(
        stopped.every(Boolean),
        `Private-share creator did not stop; fixture retained: ${fixture}`,
      );
      fs.rmSync(fixture, { recursive: true, force: true });
      assert(!fs.existsSync(fixture));
    }
  },
);
