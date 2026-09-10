// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile(
  "web-ui.mts",
  readFileSync(
    new URL("../../packaging/windows/runtime/run-installed-native-web-ui.mts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const generator = source.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "gatewaySource",
);
if (!generator) throw new Error("The native OpenClaw workload generator is missing.");
const generated = new vm.Script(generator.getText(source) + "\ngatewaySource();").runInNewContext({
  String,
}) as string;
const workload = ts.createSourceFile(
  "workload.mjs",
  generated,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const shutdown = workload.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "createNativeOpenClawShutdown",
);
const lifecycle = workload.statements.find(ts.isTryStatement);
if (!shutdown || !lifecycle?.catchClause || !lifecycle.finallyBlock)
  throw new Error("The actual native OpenClaw lifecycle is missing.");
const begin = lifecycle.tryBlock.statements.findIndex(
  (node) =>
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(
      (item) => item.name.getText(workload) === "fileTunnelTask",
    ),
);
if (begin < 0) throw new Error("The native OpenClaw tunnel lifecycle is missing.");
const actualLifecycle =
  "try {\n" +
  lifecycle.tryBlock.statements
    .slice(begin)
    .map((node) => node.getText(workload))
    .join("\n") +
  "\n}" +
  lifecycle.catchClause.getText(workload) +
  " finally " +
  lifecycle.finallyBlock.getText(workload);

const gatewayFixture = String.raw`
import { createServer } from "node:http";
const mode = process.env.FIXTURE_MODE;
const server = createServer((_request, response) => {
  response.setHeader("connection", "close");
  response.end(JSON.stringify({ pid: process.pid }));
});
if (mode !== "absent") process.on("SIGINT", () => {
  process.stdout.write("SIGNAL_HANDLED\n");
  if (mode === "ignore") return;
  setTimeout(() => server.close(() => {
    process.stdout.write("SERVER_CLOSED\n");
    process.exit(mode === "nonzero" ? 23 : 0);
  }), 25);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.stdout.write(JSON.stringify({ port: server.address().port, pid: process.pid }) + "\n");
if (mode === "premature") setTimeout(() => process.exit(0), 100);
// The real pinned gateway entry import also remains pending while it serves.
await new Promise(() => {});
`;

export async function openOpenClawStopFixture(mode = "graceful") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-openclaw-stop-"));
  const launcher = path.join(root, "gateway.mjs");
  await fs.writeFile(launcher, gatewayFixture);
  const program =
    String.raw`
import { pathToFileURL } from "node:url";
const launcher = process.env.FIXTURE_LAUNCHER;
const mode = process.env.FIXTURE_MODE;
const relayRoot = "owned-fixture";
const relayToken = "owned-fixture-token";
const uiPort = 1;
let stopUi, failUi, failBroker;
const ui = new Promise((resolve, reject) => { stopUi = resolve; failUi = reject; });
const brokerTunnel = {
  failure: new Promise((_resolve, reject) => { failBroker = reject; }),
  async close() {
    if (mode === "close-blocked") await new Promise(() => {});
    if (mode === "close-failed") throw new Error("OWNED_BROKER_CLOSE_FAILED");
    process.stdout.write("BROKER_CLOSED\n");
  },
};
const startNativeUiTunnel = () => ui;
process.stdin.setEncoding("utf8");
process.stdin.once("data", (command) => {
  if (command.trim() === "startup-failure") failUi(new Error("OWNED_STARTUP_FAILED"));
  else if (command.trim() === "broker-failure") failBroker(new Error("OWNED_BROKER_FAILED"));
  else stopUi();
});
` +
    shutdown!.getText(workload) +
    "\nconst stopOwnedGateway = createNativeOpenClawShutdown(750);\nlet agentFailed = false;\n" +
    actualLifecycle;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
    env: { ...process.env, FIXTURE_MODE: mode, FIXTURE_LAUNCHER: launcher },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  void closed.catch(() => {});
  const ready = new Promise<{ port: number; pid: number }>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-32768);
      const line = stdout.split("\n").find((value) => value.startsWith('{"port":'));
      if (line) resolve(JSON.parse(line) as { port: number; pid: number });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-32768);
    });
    child.once("error", reject);
    child.once("close", () =>
      reject(new Error("The owned HTTP fixture exited before readiness: " + stderr)),
    );
  });
  const timeout = setTimeout(() => child.kill(), 8000);
  try {
    const endpoint = await ready;
    return {
      child,
      endpoint,
      closed,
      stdout: () => stdout,
      stderr: () => stderr,
      command(value = "stop") {
        child.stdin.write(value + "\n");
      },
      async close() {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed;
        await fs.rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    clearTimeout(timeout);
    child.kill();
    await closed.catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}
