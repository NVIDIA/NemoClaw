// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { guardWindowsInstallerUpdate } from "./openclaw-app-resources.mts";

const position = process.argv.indexOf("--source-root");
if (position < 0 || !process.argv[position + 1])
  throw new Error("The pinned materialized source root is required.");
const source = path.resolve(process.argv[position + 1]);
const relative = "dist/update-B0wRhzt_.js";
const original = fs.readFileSync(path.join(source, relative), "utf8");
const patched = guardWindowsInstallerUpdate(relative, original);
const syntax = createRequire(import.meta.url)(
  path.join(source, "node_modules/typescript"),
) as typeof import("typescript");
const parse = (name: string, text: string) =>
  syntax.createSourceFile(name, text, syntax.ScriptTarget.Latest, true, syntax.ScriptKind.JS);
function declaration(file: string, name: string) {
  const tree = parse(file, fs.readFileSync(path.join(source, "dist", file), "utf8"));
  const found = tree.statements.find(
    (statement) =>
      (syntax.isFunctionDeclaration(statement) && statement.name?.text === name) ||
      (syntax.isVariableStatement(statement) &&
        statement.declarationList.declarations.some((item) => item.name.getText(tree) === name)),
  );
  assert.ok(found, `The actual pinned declaration must exist: ${name}`);
  return found.getText(tree);
}
const protocol = new Function(
  declaration("schema-BuOFpc7K.js", "ErrorCodes") +
    "\n" +
    declaration("schema-BuOFpc7K.js", "errorShape") +
    "\nreturn {ErrorCodes,errorShape};",
)() as {
  ErrorCodes: { UNAVAILABLE: string; INVALID_REQUEST: string };
  errorShape: (code: string, message: string) => Record<string, unknown>;
};
const validation = new Function(
  "ErrorCodes",
  "errorShape",
  "formatValidationErrors",
  declaration("validation-BlJXIosl.js", "assertValidParams") + "\nreturn assertValidParams;",
)(protocol.ErrorCodes, protocol.errorShape, () => "controlled invalid request") as (
  ...args: unknown[]
) => boolean;
type Input = {
  params: unknown;
  respond: (...args: unknown[]) => void;
  client: unknown;
  context: unknown;
};
function handler(text: string, platform: string, valid: boolean) {
  const tree = parse("update.js", text);
  const statement = tree.statements.find(
    (node) =>
      syntax.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (item) => item.name.getText(tree) === "updateHandlers",
      ),
  );
  assert.ok(statement && syntax.isVariableStatement(statement));
  const initializer = statement.declarationList.declarations.find(
    (item) => item.name.getText(tree) === "updateHandlers",
  )?.initializer;
  assert.ok(initializer && syntax.isObjectLiteralExpression(initializer));
  const member = initializer.properties.find(
    (item) => syntax.isPropertyAssignment(item) && item.name.getText(tree) === '"update.run"',
  );
  assert.ok(member && syntax.isPropertyAssignment(member));
  const calls: string[] = [];
  let validations = 0;
  const context = {
    getRuntimeConfig: () => ({ update: {} }),
    logGateway: { info() {}, warn() {} },
  };
  const dependencies: Record<string, unknown> = {
    process: { platform, env: {}, argv: ["node", "owned-entry"] },
    assertValidParams: (...args: unknown[]) => {
      validations++;
      return validation(...args);
    },
    validateUpdateRunParams: () => valid,
    __nemoUpdateErrorShape: protocol.errorShape,
    __nemoUpdateErrorCodes: protocol.ErrorCodes,
    resolveControlPlaneActor: () => ({ actor: "owned-control" }),
    parseRestartRequestParams: () => ({}),
    extractDeliveryInfo: () => ({}),
    normalizeUpdateChannel: () => undefined,
    tryResolveProcessCwd: () => "owned-root",
    resolveOpenClawPackageRoot: async () => {
      calls.push("package-root-probe");
      return "owned-root";
    },
    resolveUpdateInstallSurface: async () => {
      calls.push("install-surface-probe");
      return { kind: "package", mode: "npm", root: "owned-root" };
    },
    detectRespawnSupervisor: () => null,
    isRestartEnabled: () => true,
    runGatewayUpdate: async () => {
      calls.push("update-mutation");
      return { status: "ok", mode: "npm", steps: [], durationMs: 0 };
    },
    runPostCoreFinalizeAfterGatewayUpdate: async () => ({ status: "ok" }),
    foldPostCoreFinalizeIntoResult: (result: unknown) => result,
    buildUpdateRestartSentinelPayload: () => ({}),
    writeRestartSentinel: async () => {
      calls.push("sentinel-mutation");
    },
    recordLatestUpdateRestartSentinel: () => {},
    scheduleGatewaySigusr1Restart: () => {
      calls.push("restart");
      return null;
    },
    formatControlPlaneActor: () => "owned-control",
  };
  const execute = new Function(
    ...Object.keys(dependencies),
    "return (" +
      member.initializer
        .getText(tree)
        .replace("import.meta.url", JSON.stringify("file:///owned/update.js")) +
      ");",
  )(...Object.values(dependencies)) as (input: Input) => Promise<void>;
  const responses: unknown[][] = [];
  return {
    calls,
    responses,
    validations: () => validations,
    run: () =>
      execute({ params: {}, client: {}, context, respond: (...args) => responses.push(args) }),
  };
}

const before = handler(original, "win32", true);
await before.run();
assert.ok(
  before.calls.includes("install-surface-probe") && before.calls.includes("update-mutation"),
);
const blocked = handler(patched, "win32", true);
await blocked.run();
assert.equal(blocked.validations(), 1);
assert.deepEqual(
  blocked.calls,
  [],
  "Refusal must precede every package probe, mutation and restart.",
);
assert.equal(blocked.responses.length, 1);
assert.equal(blocked.responses[0][0], false);
assert.equal(blocked.responses[0][1], undefined);
assert.equal(
  (blocked.responses[0][2] as Record<string, unknown>).code,
  protocol.ErrorCodes.UNAVAILABLE,
);
assert.match(
  String((blocked.responses[0][2] as Record<string, unknown>).message),
  /NemoClaw installer.*update or repair/,
);
const invalid = handler(patched, "win32", false);
await invalid.run();
assert.deepEqual(invalid.calls, []);
assert.equal(
  (invalid.responses[0][2] as Record<string, unknown>).code,
  protocol.ErrorCodes.INVALID_REQUEST,
);
const other = handler(patched, "linux", true);
await other.run();
assert.deepEqual(
  other.calls,
  before.calls,
  "Other-platform handler behavior must remain unchanged.",
);
assert.equal(guardWindowsInstallerUpdate("unrelated.js", original), original);
assert.throws(
  () => guardWindowsInstallerUpdate(relative, original + "\n"),
  /reviewed gateway update handler changed/,
);
console.log(
  JSON.stringify({
    passed: true,
    controls: 6,
    actualPinnedHandlerAndProtocol: true,
    windowsBranchRefusedBeforeProbeOrMutation: true,
    originalValidationPreserved: true,
    otherPlatformUnchanged: true,
    updaterExecuted: false,
  }),
);
