// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import { attemptNativeUiCleanup } from "./native-ui-lifecycle.mts";

const source = fs
  .readFileSync(new URL("./run-installed-native-hermes-turn.mts", import.meta.url), "utf8")
  .replaceAll("\r\n", "\n");

// Execute controller code unchanged, replacing only process and filesystem boundaries.
function execute(fragment: string, context: Record<string, unknown>) {
  const code = stripTypeScriptTypes(
    `(async () => { let {${Object.keys(context).join(",")}} = context;\n${fragment}\n})();`,
    { mode: "strip" },
  );
  return new Function("context", `return ${code}`)(context);
}

function between(startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0 && end > start);
  return source.slice(start, end);
}

test("Hermes registration, completion and successful deletion pass the gateway process owner", async () => {
  const owner = () => {};
  const commands: unknown[][] = [];
  const lifecycle: string[] = [];
  const environment = {};
  const gateway = {};
  const lease = {};
  const context = {
    openshell: "owned-openshell",
    openShellPort: 1234,
    gatewayName: "owned-gateway",
    sandboxName: "owned-sandbox",
    cliEnvironment: environment,
    agentLabel: "Hermes",
    gateway,
    runtimeLease: lease,
    gatewaySession: { ownCommandProcess: owner },
    sandboxAbsentFromRegistry: false,
    create: { pid: 1 },
    fail: (message: string) => {
      throw new Error(message);
    },
    run: async (...args: unknown[]) => {
      assert.equal(args[0], "owned-openshell");
      assert.equal(args[2], environment);
      assert.equal(args[4], undefined, "Keep the shared default timeout");
      assert.equal(args[5], undefined);
      assert.equal(args[6], owner);
      commands.push(args);
    },
    waitForNativeMxcCompletion: async (...args: unknown[]) => {
      assert.deepEqual(args, [
        "owned-openshell",
        environment,
        "owned-sandbox",
        gateway,
        lease,
        undefined,
        owner,
      ]);
      lifecycle.push("completion");
      return "Exited";
    },
    stopChild: async () => {
      lifecycle.push("request-stop");
      return true;
    },
    confirmNativeUiRegistryEmpty: async (...args: unknown[]) => {
      assert.deepEqual(args, [
        "owned-openshell",
        environment,
        { sandboxName: "owned-sandbox", gateway, stateSession: lease },
        owner,
      ]);
      lifecycle.push("registry");
    },
  };
  await execute(between("    await run(\n", "    const sandboxEnvironment ="), context);
  const absent = await execute(
    between(
      "    const completion = await waitForNativeMxcCompletion(",
      "    if (!(await gatewaySession.stopGateway()))",
    ) + "\nreturn sandboxAbsentFromRegistry;",
    context,
  );
  assert.equal(absent, true);
  assert.deepEqual(
    commands.map((args) => args[1]),
    [
      ["gateway", "add", "https://127.0.0.1:1234", "--local", "--name", "owned-gateway"],
      ["gateway", "select", "owned-gateway"],
      ["sandbox", "delete", "owned-sandbox"],
    ],
  );
  assert.deepEqual(lifecycle, ["completion", "request-stop", "registry"]);
});

async function cleanup(scenario: string, primaryFailed = true) {
  const marker = "  } finally {";
  const start = source.lastIndexOf(marker) + marker.length;
  const after = source.indexOf("\n  if (!passed || !receipt)", start);
  const end = source.lastIndexOf("\n  }", after);
  assert(start > marker.length && end > start);
  const runRoot = "owned-run";
  const shareRoot = "owned-share";
  const runtimeRoot = "owned-runtime";
  const roots = [runRoot, shareRoot, runtimeRoot];
  const ownedRoots = scenario === "unconfirmed-share" ? [runRoot, runtimeRoot] : [...roots];
  const present = new Set([...roots, "owned-gateway"]);
  const removed: string[] = [];
  const operations: string[] = [];
  const writes = new Map<string, string>();
  const logs = new Set([42]);
  const owner = () => {};
  const environment = {};
  const gateway = { pid: 100 };
  const lease = {};
  const context = {
    attemptNativeUiCleanup,
    shareCreator: { pid: 101 },
    shareCreatorStopped: false,
    create: scenario === "before-create" ? undefined : { pid: 102 },
    stopChild: async (child: { pid: number }) => {
      operations.push(child.pid === 101 ? "share-stop" : "request-stop");
      if (scenario === "request-throws" && child.pid === 102) throw new Error("stop failed");
      return !(
        (scenario === "request-stop" && child.pid === 102) ||
        (scenario === "share-stop" && child.pid === 101)
      );
    },
    passed: false,
    sandboxAbsentFromRegistry: ["before-create", "already-absent"].includes(scenario),
    primaryFailed,
    cliEnvironment: environment,
    openshell: "owned-openshell",
    sandboxName: "owned-sandbox",
    agentLabel: "Hermes",
    agentId: "hermes",
    gateway,
    runtimeLease: lease,
    gatewaySession: {
      root: "owned-gateway",
      ownCommandProcess: owner,
      async stopGateway() {
        operations.push("gateway-stop");
        return scenario !== "gateway-stop";
      },
      async dispose() {
        operations.push("gateway-dispose");
        if (["gateway-stop", "gateway-dispose"].includes(scenario))
          throw new Error("unconfirmed gateway");
        present.delete("owned-gateway");
      },
    },
    run: async (...args: unknown[]) => {
      assert.deepEqual(args, [
        "owned-openshell",
        ["sandbox", "delete", "owned-sandbox"],
        environment,
        "Failure cleanup native Hermes sandbox",
        30_000,
        undefined,
        owner,
      ]);
      operations.push("sandbox-delete");
    },
    confirmNativeUiRegistryEmpty: async (...args: unknown[]) => {
      assert.deepEqual(args, [
        "owned-openshell",
        environment,
        { sandboxName: "owned-sandbox", gateway, stateSession: lease },
        owner,
      ]);
      operations.push("registry");
      if (scenario === "registry") throw new Error("registry unavailable");
    },
    ownedLogs: logs,
    fs: {
      closeSync(descriptor: number) {
        assert.equal(descriptor, 42);
        operations.push("log-close");
      },
      writeFileSync(file: string, content: string) {
        writes.set(file, content);
      },
      existsSync(file: string) {
        return present.has(file);
      },
    },
    ownedRoots,
    runRoot,
    shareRoot,
    runtimeRoot,
    installRoot: "owned-install",
    evidenceRoot: "owned-evidence",
    receiptPath: "owned-receipt",
    runId: "fixture",
    gatewayLogPath: "owned-stdout",
    gatewayErrorPath: "owned-stderr",
    createOutput: "failure output",
    createError: "",
    readOpenedRegularFile: () => null,
    sanitizedDiagnostic: (value: string) => value,
    path,
    removeDirectory: async (directory: string) => {
      assert(operations.includes("gateway-dispose"));
      removed.push(directory);
      present.delete(directory);
      return true;
    },
    console: { error() {} },
    fail: (message: string) => {
      throw new Error(message);
    },
  };
  let error: unknown;
  try {
    await execute(source.slice(start, end), context);
  } catch (value) {
    error = value;
  }
  const receipt = JSON.parse(writes.get("owned-receipt")!);
  assert(writes.has(path.join("owned-evidence", "native-windows-hermes-diagnostic-fixture.log")));
  assert.equal(logs.size, 0);
  return { removed, receipt, error, operations, ownedRoots };
}

for (const scenario of [
  "none",
  "request-stop",
  "request-throws",
  "gateway-stop",
  "gateway-dispose",
  "registry",
  "before-create",
  "already-absent",
  "share-stop",
  "unconfirmed-share",
]) {
  test(`Hermes cleanup preserves process custody and share ownership: ${scenario}`, async () => {
    const { removed, receipt, error, operations, ownedRoots } = await cleanup(scenario);
    assert.equal(error, undefined, "Cleanup must preserve the existing primary error");
    assert.equal(receipt.verdict, "fail");
    assert.equal(receipt.sandboxName, "owned-sandbox");
    assert.equal(receipt.sandboxAbsentFromRegistry, scenario !== "registry");
    assert.deepEqual(operations, [
      "share-stop",
      ...(scenario === "before-create" ? [] : ["request-stop"]),
      ...(["before-create", "already-absent"].includes(scenario)
        ? []
        : ["sandbox-delete", "registry"]),
      "gateway-stop",
      "gateway-dispose",
      "log-close",
    ]);
    if (
      ["request-stop", "request-throws", "gateway-stop", "gateway-dispose", "registry"].includes(
        scenario,
      )
    ) {
      assert.deepEqual(removed, []);
      assert.deepEqual(receipt.retainedQualificationRoots, ownedRoots);
      assert.equal(receipt.ownedQualificationRootsRemoved, false);
      assert.equal(
        receipt.cleanupFailures.filter((label: string) =>
          label.startsWith("temporary root removal:"),
        ).length,
        3,
      );
    } else {
      assert.deepEqual(
        removed,
        scenario === "share-stop" ? ["owned-run", "owned-runtime"] : ownedRoots,
      );
      assert.deepEqual(
        receipt.cleanupFailures,
        scenario === "share-stop"
          ? ["private share creator stop", "temporary root removal: owned-share"]
          : scenario === "unconfirmed-share"
            ? ["private share ownership verification"]
            : [],
      );
    }
    assert.equal(
      receipt.cleanupFailures.includes("sandbox registry verification"),
      scenario === "registry",
    );
    assert.equal(
      receipt.unconfirmedShareRoot,
      scenario === "unconfirmed-share" ? "owned-share" : null,
    );
  });
}

test("Hermes cleanup failure without a primary error still fails qualification", async () => {
  const { error, receipt, removed } = await cleanup("gateway-dispose", false);
  assert.match(String(error), /cleanup failed/u);
  assert(receipt.cleanupFailures.includes("private gateway cleanup"));
  assert.deepEqual(removed, []);
});
