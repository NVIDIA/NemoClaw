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
const relative = "dist/update-CnF_qlQo.js";
const original = fs.readFileSync(path.join(source, relative), "utf8");
const patched = guardWindowsInstallerUpdate(relative, original);
const syntax = createRequire(import.meta.url)(
  path.join(source, "node_modules/typescript"),
) as typeof import("typescript");
const tree = syntax.createSourceFile(
  "update.js",
  patched,
  syntax.ScriptTarget.Latest,
  true,
  syntax.ScriptKind.JS,
);
const statement = tree.statements.find(
  (node) =>
    syntax.isVariableStatement(node) &&
    node.declarationList.declarations.some((item) => item.name.getText(tree) === "updateHandlers"),
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

async function run(valid: boolean) {
  const responses: unknown[][] = [];
  let validations = 0;
  const execute = new Function(
    "process",
    "assertValidParams",
    "validateUpdateRunParams",
    `return (${member.initializer.getText(tree)});`,
  )(
    { platform: "win32" },
    (
      _params: unknown,
      validate: () => boolean,
      _name: string,
      respond: (...args: unknown[]) => void,
    ) => {
      validations++;
      if (validate()) return true;
      respond(false, undefined, { code: "INVALID_REQUEST", message: "invalid" });
      return false;
    },
    () => valid,
  ) as (input: Record<string, unknown>) => Promise<void>;
  await execute({
    params: {},
    client: {},
    context: {},
    respond: (...args: unknown[]) => responses.push(args),
  });
  return { responses, validations };
}

const blocked = await run(true);
assert.equal(blocked.validations, 1);
assert.deepEqual(blocked.responses[0], [
  false,
  undefined,
  {
    code: "UNAVAILABLE",
    message:
      "This Windows application is managed by the NemoClaw installer. Use the NemoClaw installer to update or repair it.",
  },
]);
const invalid = await run(false);
assert.equal(invalid.validations, 1);
assert.equal((invalid.responses[0][2] as { code: string }).code, "INVALID_REQUEST");
assert.equal(guardWindowsInstallerUpdate("unrelated.js", original), original);
assert.throws(
  () => guardWindowsInstallerUpdate(relative, original + "\n"),
  /reviewed gateway update handler changed/u,
);
console.log(JSON.stringify({ passed: true, controls: 5, updaterExecuted: false }));
