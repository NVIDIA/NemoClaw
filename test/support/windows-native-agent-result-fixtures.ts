// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

import { readOpenedRegularFile } from "../../packaging/windows/runtime/native-security.mts";

type Failure = { error: Error | null };
type ProcessState = Pick<ChildProcess, "exitCode" | "signalCode">;
type GuardedRelay = { readResult(): Promise<Buffer | null> };
export type ResultRoute = "terminal" | "nemocua";
export type CreateMode = "success" | "failure" | "signal" | "missing" | "pending";

function actualFunctions(file: string, names: readonly string[]) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(new URL(`../../packaging/windows/runtime/${file}`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = names.map((name) => {
    const node = source.statements.find(
      (item): item is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(item) && item.name?.text === name,
    );
    if (!node) throw new Error(`The native result function ${name} is missing.`);
    return node.getText(source);
  });
  const code = ts.transpileModule(declarations.join("\n") + `\n${names.at(-1)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new vm.Script(code).runInNewContext({
    Error,
    Date,
    Promise,
    setTimeout,
    readOpenedRegularFile,
    sleep: (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  }) as unknown;
}

const terminalWait = actualFunctions("run-installed-native-pi.mts", [
  "fail",
  "waitForTerminalAgentResult",
]) as (
  file: string,
  token: string,
  create: ProcessState,
  gateway: ProcessState,
  failure: Failure,
  label: string,
  timeout: number,
) => Promise<string>;
const nemocuaWait = actualFunctions("run-installed-native-nemocua.mts", [
  "fail",
  "waitForGuardedResult",
]) as (
  relay: GuardedRelay,
  create: ProcessState,
  gateway: ProcessState,
  failure: Failure,
  signal: AbortSignal,
  timeout: number,
) => Promise<string>;

export async function openNativeAgentResultFixture(
  route: ResultRoute,
  mode: CreateMode = "success",
) {
  const root = await mkdtemp(path.join(tmpdir(), "native-agent-result-"));
  const resultPath = path.join(root, "result.json");
  const createFailure: Failure = { error: null };
  const owned: { child: ChildProcess; closed: Promise<void> }[] = [];
  const controller = new AbortController();
  let reads = 0;
  const launch = (program: string, executable = process.execPath) => {
    const child = spawn(executable, ["-e", program], {
      cwd: root,
      env: process.env,
      stdio: "ignore",
    });
    const closed = new Promise<void>((resolve) => {
      child.once("error", () => {});
      child.once("close", () => resolve());
    });
    const ownedChild = { child, closed };
    owned.push(ownedChild);
    return ownedChild;
  };
  const alive = "setInterval(() => {}, 1000);";
  const gateway = launch(alive);
  const create = launch(
    mode === "pending" || mode === "signal"
      ? alive
      : `process.exit(${mode === "failure" ? 23 : 0});`,
    mode === "missing" ? path.join(root, "missing-openshell") : process.execPath,
  );
  create.child.once("error", (error) => {
    createFailure.error = error;
  });
  if (mode === "signal") create.child.kill();
  if (mode !== "pending") await create.closed;
  const relay: GuardedRelay = {
    async readResult() {
      reads++;
      // Host file-owner authority is substituted in this portable caller test.
      // The actual caller consumes a bounded Buffer or MISS in the same way.
      const result = readOpenedRegularFile(resultPath, { maxBytes: 1024 * 1024 });
      return result;
    },
  };
  const expected = { verdict: "pass", token: "OWNED_FINAL_TOKEN" };
  const wait = (timeout = 2000, token = "OWNED_FINAL_TOKEN", label = "Pi") =>
    route === "terminal"
      ? terminalWait(resultPath, token, create.child, gateway.child, createFailure, label, timeout)
      : nemocuaWait(relay, create.child, gateway.child, createFailure, controller.signal, timeout);
  let disposed = false;
  return {
    resultPath,
    expected,
    create: create.child,
    gateway: gateway.child,
    createFailure,
    wait,
    reads: () => reads,
    abort: () => controller.abort(new Error("owned result monitoring cancelled")),
    publish(result: unknown = expected, delayMilliseconds = 100) {
      return launch(
        `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(resultPath)}, ${JSON.stringify(JSON.stringify(result))}), ${delayMilliseconds});`,
      );
    },
    write: (content: string) => writeFile(resultPath, content),
    async stopGateway() {
      gateway.child.kill();
      await gateway.closed;
    },
    async close() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      for (const item of owned) {
        if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill();
      }
      await Promise.all(owned.map((item) => item.closed));
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function createNativeAgentCompletionFixture(route: ResultRoute) {
  const file =
    route === "terminal" ? "run-installed-native-pi.mts" : "run-installed-native-nemocua.mts";
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(new URL(`../../packaging/windows/runtime/${file}`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let fence: readonly ts.Statement[] | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isBlock(node)) {
      const first = node.statements.findIndex(
        (item) =>
          ts.isVariableStatement(item) &&
          item.declarationList.declarations.some(
            (declaration) =>
              declaration.name.getText(source) === "completion" &&
              declaration.initializer &&
              ts.isAwaitExpression(declaration.initializer),
          ),
      );
      if (first >= 0) fence = node.statements.slice(first, first + 3);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const fail = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "fail",
  );
  if (!fence || fence.length !== 3 || !fail)
    throw new Error("The native agent completion fence is missing.");
  const code = ts.transpileModule(
    fail.getText(source) +
      "\n(async () => {\n" +
      fence.map((node) => node.getText(source)).join("\n") +
      "\n});",
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    },
  ).outputText;
  let complete!: (value: "AgentCompleted" | "ExecFailed") => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<"AgentCompleted" | "ExecFailed">((resolve, rejectPromise) => {
    complete = resolve;
    reject = rejectPromise;
  });
  const gateway = { exitCode: null, signalCode: null };
  const environment = { OWNED_SESSION: "qualification" };
  const queries: unknown[][] = [];
  const deletions: unknown[][] = [];
  const finish = new vm.Script(code).runInNewContext({
    Error,
    openshell: "owned-openshell",
    cliEnvironment: environment,
    sandboxName: "owned-sandbox",
    gateway,
    agentLabel: "Pi",
    // The real shared completion helper has its own terminal-condition tests.
    // This gate controls that boundary to exercise the exact caller's ordering.
    waitForNativeMxcCompletion: (...args: unknown[]) => {
      queries.push(args);
      return completion;
    },
    run: async (...args: unknown[]) => {
      deletions.push(args);
    },
  }) as () => Promise<void>;
  return { finish, complete, reject, gateway, environment, queries, deletions };
}
