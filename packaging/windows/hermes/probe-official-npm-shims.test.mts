// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  checkResult,
  createWorkspace,
  delimitedPathExt,
  loadOfficialShim,
  officialBuildCommand,
  originalPathExt,
} from "./probe-official-npm-shims.mts";
import type { CommandResult } from "./probe-component-workload.mts";

const npm = process.env.NEMOCLAW_TEST_NPM_ROOT;
assert.ok(npm, "Tests require the verified official npm12 tool directory.");

test("actual npm12 shim source generates three unchanged entrypoint forms for the original command", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-shim-source-"));
  try {
    const bins = await createWorkspace(
      path.join(root, "workspace with spaces"),
      loadOfficialShim(npm),
    );
    assert.equal(officialBuildCommand, "tsc -b && vite build");
    assert.deepEqual(
      bins.map((bin) => bin.name),
      ["tsc", "vite"],
    );
    for (const bin of bins) {
      assert.match(bin.contents, /endLocal & goto/u);
      assert.ok(bin.contents.includes('set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"'));
      assert.ok(bin.contents.indexOf("set PATHEXT=") > bin.contents.indexOf("endLocal"));
      for (const suffix of ["", ".cmd", ".ps1"])
        assert.ok(fs.statSync(bin.cmd.slice(0, -4) + suffix).isFile());
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the proposed process environment retains exactly the existing executable extensions", () => {
  assert.equal(delimitedPathExt, originalPathExt + ";");
  assert.deepEqual(delimitedPathExt.split(";").filter(Boolean), [".COM", ".EXE", ".BAT", ".CMD"]);
});

function result(names: string[], code: number | null): CommandResult {
  return {
    executable: process.execPath,
    args: [],
    exitCode: code,
    signal: null,
    timedOut: false,
    outputExceeded: false,
    error: null,
    childClosed: true,
    elapsedMs: 1,
    stdout: names
      .map((control) =>
        JSON.stringify({
          control,
          execPath: process.execPath,
          argv: control === "tsc" ? ["-b"] : ["build"],
          pathExt: originalPathExt,
        }),
      )
      .join("\n"),
    stderr: "",
  };
}
test("successful second invocation cannot satisfy the expected negative control", () => {
  assert.throws(() => checkResult(result(["tsc", "vite"], 0), ["tsc"], false, process.execPath));
});
test("both exact fixed-path programs and their original arguments are required", () => {
  assert.equal(
    checkResult(result(["tsc", "vite"], 0), ["tsc", "vite"], true, process.execPath).length,
    2,
  );
  assert.throws(() => checkResult(result(["tsc"], 0), ["tsc", "vite"], true, process.execPath));
  assert.throws(() =>
    checkResult(
      result(["tsc", "vite"], 0),
      ["tsc", "vite"],
      true,
      path.join(os.tmpdir(), "foreign-node.exe"),
    ),
  );
});
for (const changed of [
  { timedOut: true },
  { outputExceeded: true },
  { childClosed: false },
  { exitCode: null },
]) {
  test(`incomplete process evidence is rejected: ${Object.keys(changed)[0]}`, () => {
    assert.throws(() =>
      checkResult({ ...result(["tsc"], 1), ...changed }, ["tsc"], false, process.execPath),
    );
  });
}
