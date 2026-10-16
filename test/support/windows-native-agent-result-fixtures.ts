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
export type ResultRoute = "terminal";
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

const terminalWait = actualFunctions("run-installed-native-hermes-turn.mts", [
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
export async function openNativeAgentResultFixture(
  _route: ResultRoute,
  mode: CreateMode = "success",
) {
  const root = await mkdtemp(path.join(tmpdir(), "native-agent-result-"));
  const resultPath = path.join(root, "result.json");
  const createFailure: Failure = { error: null };
  const owned: { child: ChildProcess; closed: Promise<void> }[] = [];
  const launch = (program: string, executable = process.execPath, args: string[] = []) => {
    const child = spawn(executable, ["-e", program, ...args], {
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
  const expected = { verdict: "pass", token: "OWNED_FINAL_TOKEN" };
  const wait = (timeout = 2000, token = "OWNED_FINAL_TOKEN", label = "Hermes") =>
    terminalWait(resultPath, token, create.child, gateway.child, createFailure, label, timeout);
  let disposed = false;
  return {
    resultPath,
    expected,
    create: create.child,
    gateway: gateway.child,
    createFailure,
    wait,
    publish(result: unknown = expected, delayMilliseconds = 100) {
      return launch(
        'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], process.argv[2]), Number(process.argv[3]));',
        process.execPath,
        [resultPath, JSON.stringify(result) + "\n", String(delayMilliseconds)],
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
      for (const item of owned) {
        if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill();
      }
      await Promise.all(owned.map((item) => item.closed));
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function createNativeAgentCompletionFixture(_route: ResultRoute, deferAbsence = false) {
  const file = "run-installed-native-hermes-turn.mts";
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
      const last = node.statements.findIndex(
        (item, index) =>
          index > first &&
          ts.isExpressionStatement(item) &&
          ts.isAwaitExpression(item.expression) &&
          ts.isCallExpression(item.expression.expression) &&
          item.expression.expression.expression.getText(source) === "confirmNativeUiRegistryEmpty",
      );
      if (first >= 0 && last > first) fence = node.statements.slice(first, last + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const fail = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "fail",
  );
  if (!fence || !fail) throw new Error("The native agent completion fence is missing.");
  const code = ts.transpileModule(
    fail.getText(source) +
      "\n(async () => {\n" +
      fence.map((node) => node.getText(source)).join("\n") +
      "\n});",
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    },
  ).outputText;
  type Completion = "AgentCompleted" | "ExecFailed" | "MainProcessCompleted" | "MainProcessFailed";
  let complete!: (value: Completion) => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<Completion>((resolve, rejectPromise) => {
    complete = resolve;
    reject = rejectPromise;
  });
  const gateway = { exitCode: null, signalCode: null };
  const environment = { OWNED_SESSION: "qualification" };
  const queries: unknown[][] = [];
  const deletions: unknown[][] = [];
  const registryQueries: unknown[][] = [];
  const runtimeLease = { assertHeld() {} };
  const ownProcess = (_child: ChildProcess) => {
    throw new Error("The controlled command boundary must not launch a real process.");
  };
  let confirmAbsent!: () => void;
  let rejectAbsence!: (error: Error) => void;
  const absence = new Promise<void>((resolve, reject) => {
    confirmAbsent = resolve;
    rejectAbsence = reject;
  });
  void absence.catch(() => {});
  if (!deferAbsence) confirmAbsent();
  const finish = new vm.Script(code).runInNewContext({
    Error,
    openshell: "owned-openshell",
    cliEnvironment: environment,
    sandboxName: "owned-sandbox",
    gateway,
    gatewaySession: { ownCommandProcess: ownProcess },
    agentLabel: "Hermes",
    create: null,
    runtimeLease,
    // The real shared completion helper has its own terminal-condition tests.
    // This gate controls that boundary to exercise the exact caller's ordering.
    waitForNativeMxcCompletion: (...args: unknown[]) => {
      queries.push(args);
      return completion;
    },
    run: async (...args: unknown[]) => {
      deletions.push(args);
    },
    confirmNativeUiRegistryEmpty: (...args: unknown[]) => {
      registryQueries.push(args);
      return absence;
    },
  }) as () => Promise<void>;
  return {
    finish,
    complete,
    reject,
    gateway,
    environment,
    queries,
    deletions,
    registryQueries,
    runtimeLease,
    confirmAbsent,
    rejectAbsence,
    ownProcess,
  };
}
