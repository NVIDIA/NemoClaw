// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile(
  "turn.mts",
  fs.readFileSync(
    new URL("../../packaging/windows/runtime/run-installed-native-turn.mts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const namedFunction = (name: string) => {
  const node = source.statements.find(
    (item): item is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(item) && item.name?.text === name,
  );
  if (!node) throw new Error(`The actual native turn function ${name} is missing.`);
  return node;
};
const mainTry = namedFunction("main").body?.statements.find(ts.isTryStatement);
if (!mainTry) throw new Error("The native turn lifecycle is missing.");
const statements = mainTry.tryBlock.statements;
const resultIndex = statements.findIndex(
  (node) =>
    ts.isExpressionStatement(node) &&
    ts.isBinaryExpression(node.expression) &&
    node.expression.left.getText(source) === "result",
);
const rejectedIndex = statements.findIndex(
  (node) => ts.isIfStatement(node) && node.expression.getText(source) === "!turnPassed",
);
if (resultIndex < 0 || rejectedIndex <= resultIndex)
  throw new Error("The actual native turn result validation is missing.");
const validation = statements
  .slice(resultIndex, rejectedIndex + 1)
  .map((node) => node.getText(source))
  .join("\n");
const implementation = ts.transpileModule(
  ["fail", "sanitizedDiagnostic", "waitForNativeTurnResult"]
    .map((name) =>
      namedFunction(name)
        .getText(source)
        .replace(/^export\s+/, ""),
    )
    .join("\n") +
    `
async function waitAndRead(resultPath, create, gateway, createFailure, timeout) {
  await waitForNativeTurnResult(resultPath, create, gateway, createFailure, timeout);
  let result;
  const installRoot = "owned-install", runtimeRoot = "owned-runtime";
  const shareRoot = "owned-share", runRoot = "owned-run";
  ${validation}
  return result;
}
waitAndRead;
`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;
const waitAndRead = new vm.Script(implementation).runInNewContext({
  fs,
  Error,
  TIMEOUT_MS: 300_000,
  sleep: (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  console: { error: () => {} },
}) as (
  resultPath: string,
  create: ChildProcess,
  gateway: ChildProcess,
  createFailure: { error: Error | null },
  timeout: number,
) => Promise<Record<string, unknown>>;

export const validNativeTurnResult = {
  executionMode: "embedded-worker",
  version: "2026.7.1",
  versionExitCode: 0,
  chatExitCode: 0,
  exactReply: true,
  reply: "CHAT_OK",
};

type CreateMode = "success" | "failure" | "signal" | "missing" | "pending";

export async function openNativeTurnResultFixture(mode: CreateMode = "success") {
  const root = await mkdtemp(path.join(tmpdir(), "native-turn-result-"));
  const resultPath = path.join(root, "result.json");
  const owned: { child: ChildProcess; closed: Promise<void> }[] = [];
  const createFailure: { error: Error | null } = { error: null };
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
    const item = { child, closed };
    owned.push(item);
    return item;
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
  let disposed = false;
  return {
    root,
    resultPath,
    create: create.child,
    gateway: gateway.child,
    createFailure,
    wait: (timeout = 2000) =>
      waitAndRead(resultPath, create.child, gateway.child, createFailure, timeout),
    publish(result: unknown = validNativeTurnResult, delayMilliseconds = 100) {
      return launch(
        `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(resultPath)}, ${JSON.stringify(JSON.stringify(result))}), ${delayMilliseconds});`,
      );
    },
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
