// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hermesBootstrapPythonSource } from "./native-hermes-bootstrap.mts";
import { renderFactory } from "../distribution/build-native-workers.mts";

const python = process.platform === "win32" ? "python" : "python3";

test("the staged factory materializes the reviewed child bootstrap", () => {
  assert.equal(
    renderFactory(
      fileURLToPath(new URL("./", import.meta.url)),
      "native-hermes-bootstrap.mts",
      "hermesBootstrapPythonSource",
    ),
    hermesBootstrapPythonSource(),
  );
});

for (const mode of [
  "inactive",
  "missing-canonical",
  "other-interpreter",
  "activation-error",
] as const) {
  test(`sourceless child bootstrap: ${mode}`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-bootstrap-test-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, "sitecustomize.py");
    fs.writeFileSync(source, hermesBootstrapPythonSource(), { flag: "wx" });
    const compiled = spawnSync(
      python,
      [
        "-I",
        "-B",
        "-c",
        "import py_compile,sys; py_compile.compile(sys.argv[1],cfile=sys.argv[2],doraise=True,invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH); print(sys.executable)",
        source,
        path.join(root, "sitecustomize.pyc"),
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    fs.unlinkSync(source);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      PYTHONPATH: root,
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    };
    if (mode !== "inactive") env.NEMOCLAW_HERMES_INFERENCE_PIPE_PORT = "8123";
    if (mode === "other-interpreter") env.HERMES_PYTHON = path.join(root, "unrelated-python");
    if (mode === "activation-error") env.HERMES_PYTHON = compiled.stdout.trim();
    const result = spawnSync(
      python,
      [
        "-B",
        "-c",
        "import sys; assert 'sitecustomize' in sys.modules; print('child-reached-main')",
      ],
      {
        env,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    if (mode === "inactive" || mode === "other-interpreter") {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "child-reached-main");
      assert.equal(result.stderr, "");
    } else {
      assert.notEqual(result.status, 0);
      assert(!result.stdout.includes("child-reached-main"));
      assert.match(result.stderr, /Hermes contained transport bootstrap failed/u);
    }
    assert.deepEqual(fs.readdirSync(root), ["sitecustomize.pyc"]);
  });
}
