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

test("Hermes registration and cleanup use the selected provider session", async () => {
  const operations: string[] = [];
  const environment = {};
  const gateway = {};
  const lease = {};
  const context = {
    openShellPort: 1234,
    gatewayName: "owned-gateway",
    sandboxName: "owned-sandbox",
    cliEnvironment: environment,
    agentLabel: "Hermes",
    gateway,
    runtimeLease: lease,
    sandboxAbsentFromRegistry: false,
    sandboxDeletionRequested: false,
    create: { pid: 1 },
    fail: (message: string) => {
      throw new Error(message);
    },
    stopChild: async () => {
      operations.push("request-stop");
      return true;
    },
    gatewaySession: {
      async registerGateway(...args: unknown[]) {
        assert.deepEqual(args, [
          1234,
          "owned-gateway",
          environment,
          ["Registering the native Hermes gateway", "Selecting the native Hermes gateway"],
          undefined,
        ]);
        operations.push("registration");
      },
      async waitForCompletion(...args: unknown[]) {
        assert.deepEqual(args, [environment, "owned-sandbox", gateway, lease, undefined]);
        operations.push("completion");
        return "AgentCompleted";
      },
      async deleteWorkload(...args: unknown[]) {
        assert.deepEqual(args, [
          "owned-sandbox",
          environment,
          "Deleting the native Hermes sandbox",
          undefined,
          undefined,
        ]);
        operations.push("deletion");
      },
      async confirmRegistryEmpty(...args: unknown[]) {
        assert.deepEqual(args, [
          environment,
          { sandboxName: "owned-sandbox", gateway, stateSession: lease },
        ]);
        operations.push("registry");
      },
    },
  };
  await execute(
    between("    await gatewaySession.registerGateway(", "    const sandboxEnvironment ="),
    context,
  );
  const absent = await execute(
    between(
      "    const completion = await gatewaySession.waitForCompletion(",
      "    if (!(await gatewaySession.stopGateway()))",
    ) + "\nreturn sandboxAbsentFromRegistry;",
    context,
  );
  assert.equal(absent, true);
  assert.deepEqual(operations, [
    "registration",
    "completion",
    "deletion",
    "request-stop",
    "registry",
  ]);
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
    sandboxDeletionRequested: scenario.startsWith("deletion-requested"),
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
      deleteWorkload: async (...args: unknown[]) => {
        assert.deepEqual(args, [
          "owned-sandbox",
          environment,
          "Failure cleanup native Hermes sandbox",
          30_000,
          undefined,
        ]);
        operations.push("sandbox-delete");
      },
      confirmRegistryEmpty: async (...args: unknown[]) => {
        assert.deepEqual(args, [
          environment,
          { sandboxName: "owned-sandbox", gateway, stateSession: lease },
        ]);
        operations.push("registry");
        if (["registry", "deletion-requested-registry"].includes(scenario))
          throw new Error("registry unavailable");
      },

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
  "deletion-requested",
  "deletion-requested-registry",
]) {
  test(`Hermes cleanup preserves process custody and share ownership: ${scenario}`, async () => {
    const { removed, receipt, error, operations, ownedRoots } = await cleanup(scenario);
    assert.equal(error, undefined, "Cleanup must preserve the existing primary error");
    assert.equal(receipt.verdict, "fail");
    assert.equal(receipt.sandboxName, "owned-sandbox");
    assert.equal(
      receipt.sandboxAbsentFromRegistry,
      !["registry", "deletion-requested-registry"].includes(scenario),
    );
    assert.deepEqual(operations, [
      "share-stop",
      ...(scenario === "before-create" ? [] : ["request-stop"]),
      ...(["before-create", "already-absent"].includes(scenario)
        ? []
        : [...(scenario.startsWith("deletion-requested") ? [] : ["sandbox-delete"]), "registry"]),
      "gateway-stop",
      "gateway-dispose",
      "log-close",
    ]);
    if (
      [
        "request-stop",
        "request-throws",
        "gateway-stop",
        "gateway-dispose",
        "registry",
        "deletion-requested-registry",
      ].includes(scenario)
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
      ["registry", "deletion-requested-registry"].includes(scenario),
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
