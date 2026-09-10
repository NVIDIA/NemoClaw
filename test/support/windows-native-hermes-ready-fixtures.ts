// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { open as openFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import vm from "node:vm";
import ts from "typescript";
import { hermesDashboardPythonSource } from "../../packaging/windows/runtime/native-hermes-dashboard.mts";
import { createNativeDiagnosticCapture } from "../../packaging/windows/runtime/native-session-diagnostics.mts";

const source = ts.createSourceFile(
  "console.mts",
  fs.readFileSync(
    new URL(
      "../../packaging/windows/runtime/run-installed-native-console-agent.mts",
      import.meta.url,
    ),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
function findNode(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (!found && predicate(node)) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(root);
  if (!found) throw new Error("The actual contained dashboard implementation was not found.");
  return found;
}
const generator = findNode(
  source,
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "interactiveWorkloadSource",
);
const generated = new vm.Script(
  generator.getText(source).replace(/^export\s+/, "") + "\ninteractiveWorkloadSource();",
).runInNewContext({ String, hermesDashboardPythonSource }) as string;
const workload = ts.createSourceFile(
  "workload.mjs",
  generated,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const functions = [
  "waitForHermesDashboardReady",
  "stopOwnedNativeAgent",
  "watchNativeStopRequest",
].map((name) =>
  findNode(workload, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(
    workload,
  ),
);
const implementation = new vm.Script(
  functions.join("\n") +
    "\n({ waitForHermesDashboardReady, stopOwnedNativeAgent, watchNativeStopRequest });",
).runInNewContext({
  StringDecoder,
  setTimeout,
  clearTimeout,
  Error,
  Buffer,
  AbortController,
  openFile,
  process,
}) as {
  waitForHermesDashboardReady(
    child: ChildProcess,
    exit: Promise<unknown>,
    timeout?: number,
  ): Promise<{ port: number; processId: number }>;
  stopOwnedNativeAgent(
    child: ChildProcess | undefined,
    stopped: Promise<unknown>,
    timeout?: number,
  ): Promise<boolean>;
  watchNativeStopRequest(
    file: string,
    sessionId: string,
    intervalMilliseconds?: number,
  ): { signal: AbortSignal; requested: Promise<never>; close(): Promise<void> };
};

export const watchNativeStopRequest = implementation.watchNativeStopRequest;
export const stopOwnedNativeAgent = implementation.stopOwnedNativeAgent;

export function dashboardChildEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const assignment = findNode(
    workload,
    (node) =>
      ts.isBinaryExpression(node) &&
      node.left.getText(workload) === "extraEnvironment" &&
      node.right.getText(workload).includes("HERMES_DESKTOP_READY_FILE"),
  );
  const declaration = findNode(
    workload,
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (value) => value.name.getText(workload) === "childEnvironment",
      ),
  );
  return new vm.Script(
    "let extraEnvironment;\n" +
      assignment.getText(workload) +
      ";\n" +
      declaration.getText(workload) +
      "\nchildEnvironment;",
  ).runInNewContext({
    process: { env: parent },
    home: "owned-home",
    hermesHome: "owned-hermes",
    node: "owned-node",
    python: "owned-python",
    dashboard: true,
  }) as NodeJS.ProcessEnv;
}

export const READY_CANARY = "owned-ready-output-canary";
const childSource = String.raw`
const http = require('node:http');
const mode = process.argv[1];
if (mode === 'exit') { process.stderr.write('owned startup failure\n'); process.exit(3); }
const server = http.createServer((_request, response) => response.end(JSON.stringify({ processId: process.pid })));
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  process.stdout.write('UTF-8: snowman ☃\nowned-ready-output-canary\n');
  if (mode === 'noise') process.stdout.write('n'.repeat(8192) + '\n');
  if (mode === 'oversized') { process.stdout.write('HERMES_DASHBOARD_READY port=' + '9'.repeat(8192) + '\n'); return; }
  const marker = 'HERMES_DASHBOARD_READY port=' + (mode === 'invalid' ? process.argv[2] : port) + '\r\n';
  if (mode === 'stderr') { process.stderr.write(marker); return; }
  if (mode === 'quiet') return;
  for (const byte of Buffer.from(marker)) {
    process.stdout.write(Buffer.from([byte]));
    await new Promise(resolve => setTimeout(resolve, 1));
  }
});
`;

export function openDashboardReadyFixture(
  mode: string,
  options: { portText?: string; timeout?: number; failure?: Promise<never> } = {},
) {
  const child = spawn(process.execPath, ["-e", childSource, mode, options.portText ?? ""], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HERMES_DESKTOP_READY_FILE: "" },
  });
  const stopped = new Promise<void>((resolve) => {
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
  const exit = options.failure ? Promise.race([stopped, options.failure]) : stopped;
  const ready = implementation.waitForHermesDashboardReady(child, exit, options.timeout ?? 2000);
  void ready.catch(() => {});
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const diagnostic = createNativeDiagnosticCapture(() => [READY_CANARY]);
  const capture = (chunks: Buffer[]) =>
    new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        diagnostic.write(chunk);
        setTimeout(callback, 2);
      },
    });
  const output = capture(stdout);
  const errors = capture(stderr);
  // Preserve the production pipe and its backpressure while the reader observes
  // the same owned child's stdout. This backend is synthetic, not Windows proof.
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(errors, { end: false });
  let closed = false;
  return {
    child,
    ready,
    stdout: () => Buffer.concat(stdout).toString("utf8"),
    stderr: () => Buffer.concat(stderr).toString("utf8"),
    diagnostic: () => diagnostic.finish(),
    async close() {
      if (closed) return;
      closed = true;
      const result = await implementation.stopOwnedNativeAgent(child, stopped, 2000);
      if (!result) throw new Error("The owned dashboard fixture did not stop.");
      output.end();
      errors.end();
      await Promise.all([finished(output), finished(errors)]);
    },
  };
}
