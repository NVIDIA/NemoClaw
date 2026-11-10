// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type * as TypeScript from "typescript";

export const gatewaySourceSha256 =
  "86a0259975e1515d46d6e50939c2756dfbda135d585a5e03cd12c0763f4d4d2c";

export const dashboardSocketHelper = String.raw`
function __nemoDashboardSocket(url: string, fallback: typeof WebSocket): WebSocket {
  const declared = process.env.NEMOCLAW_HERMES_DASHBOARD_PIPE_PORT;
  if (declared === undefined) return new fallback(url);
  if (process.platform !== "win32" || !/^[1-9][0-9]{0,4}$/.test(declared) || Number(declared) > 65535)
    throw new Error("The Hermes dashboard pipe declaration is invalid.");
  const target = new URL(url);
  if (target.protocol !== "ws:" || target.hostname !== "127.0.0.1" || target.port !== declared ||
      target.username || target.password || target.hash || !["/api/ws", "/api/pub"].includes(target.pathname))
    throw new Error("The Hermes dashboard connection escaped its declared endpoint.");
  const dispatcher = new __nemoDashboardAgent({
    connect: { socketPath: "\\\\.\\pipe\\LOCAL\\OpenShell-Loopback-" + declared },
  });
  let retiring = false;
  const retire = () => {
    if (retiring) return;
    retiring = true;
    void dispatcher.destroy().catch(() => {
      console.error("The Hermes dashboard connection did not close cleanly.");
      process.exitCode = 1;
    });
  };
  try {
    const socket = new UndiciWebSocket(url, { dispatcher });
    socket.addEventListener("close", retire, { once: true });
    socket.addEventListener("error", retire, { once: true });
    return socket as unknown as WebSocket;
  } catch (error) {
    retire();
    throw error;
  }
}
`;

export function compileNativeTuiPipe(source: string, syntax: typeof TypeScript): string {
  if (createHash("sha256").update(source).digest("hex") !== gatewaySourceSha256)
    throw new Error("The pinned Hermes gateway client source changed.");
  const tree = syntax.createSourceFile(
    "gatewayClient.ts",
    source,
    syntax.ScriptTarget.Latest,
    true,
    syntax.ScriptKind.TS,
  );
  const edits: { start: number; end: number; value: string }[] = [];
  const targets = new Set<string>();
  const visit = (node: TypeScript.Node) => {
    if (syntax.isNewExpression(node) && node.expression.getText(tree) === "WebSocketCtor") {
      const argument = node.arguments?.length === 1 ? node.arguments[0].getText(tree) : "";
      if (!["this.sidecarUrl", "attachUrl"].includes(argument) || targets.has(argument))
        throw new Error("The pinned Hermes dashboard WebSocket call sites changed.");
      targets.add(argument);
      edits.push({
        start: node.getStart(tree),
        end: node.end,
        value: `__nemoDashboardSocket(${argument}, WebSocketCtor)`,
      });
    }
    syntax.forEachChild(node, visit);
  };
  visit(tree);
  if (targets.size !== 2)
    throw new Error("The pinned Hermes dashboard WebSocket call sites are incomplete.");
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  return (
    'import { Agent as __nemoDashboardAgent } from "undici";\n' + dashboardSocketHelper + result
  );
}

export function adaptNativeTuiPipeFile(target: string, syntax: typeof TypeScript): string {
  const descriptor = fs.openSync(target, "r+");
  try {
    const held = fs.fstatSync(descriptor);
    const requireOwnedInput = () => {
      const named = fs.lstatSync(target);
      if (
        !held.isFile() ||
        held.nlink !== 1 ||
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.dev !== held.dev ||
        named.ino !== held.ino ||
        fs.realpathSync(target) !== target
      )
        throw new Error("The Hermes TUI source is not an ordinary owned build input.");
    };
    const readHeld = () => {
      const data = Buffer.alloc(1024 * 1024 + 1);
      let bytes = 0;
      while (bytes < data.length) {
        const count = fs.readSync(descriptor, data, bytes, data.length - bytes, bytes);
        if (count === 0) return data.subarray(0, bytes);
        bytes += count;
      }
      throw new Error("The Hermes TUI source exceeds its build input limit.");
    };
    requireOwnedInput();
    const result = Buffer.from(compileNativeTuiPipe(readHeld().toString("utf8"), syntax));
    requireOwnedInput();
    let written = 0;
    while (written < result.length) {
      const count = fs.writeSync(descriptor, result, written, result.length - written, written);
      if (count === 0) throw new Error("The Hermes TUI build input write did not progress.");
      written += count;
    }
    fs.ftruncateSync(descriptor, result.length);
    fs.fsyncSync(descriptor);
    const actual = readHeld();
    requireOwnedInput();
    if (!actual.equals(result)) throw new Error("The Hermes TUI adapted build input changed.");
    return createHash("sha256").update(actual).digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2]))
    throw new Error("The Hermes TUI build directory must be an absolute path.");
  const root = fs.realpathSync(process.argv[2]);
  const target = path.join(root, "ui-tui", "src", "gatewayClient.ts");
  const require = createRequire(path.join(root, "package.json"));
  const adaptedSha256 = adaptNativeTuiPipeFile(target, require("typescript"));
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      classification: "build-time-hermes-dashboard-pipe-client",
      path: "ui-tui/src/gatewayClient.ts",
      sourceSha256: gatewaySourceSha256,
      adaptedSha256,
      adapterSha256: createHash("sha256")
        .update(fs.readFileSync(fileURLToPath(import.meta.url)))
        .digest("hex"),
      callSites: 2,
      nativeExecutionQualified: false,
    }) + "\n",
  );
}
