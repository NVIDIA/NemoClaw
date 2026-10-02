// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const bundle = process.env.NEMOCLAW_TEST_INFERENCE_BUNDLE;

test(
  "the supplied pinned engine is included in the final assembly seal without model weights",
  { skip: !bundle },
  () => {
    // The existing assembler fixture uses non-executable agent placeholders. Only
    // the supplied engine bytes are real; this is packaging evidence, not a launch.
    const result = spawnSync(
      process.env.NEMOCLAW_TEST_PYTHON ?? "python",
      [
        "-c",
        `
import json, sys
from pathlib import Path
from test_assemble_runtime import RuntimeAssembly, assembler
from package_runtime import availability
fixture = RuntimeAssembly()
fixture.setUp()
try:
    receipt = assembler.assemble(fixture.output, {"openclaw": fixture.source}, fixture.node,
        "22.23.2", "a" * 40, "b" * 64, fixture.namespace,
        worker_build=fixture.workers, executable_build=fixture.sea,
        inference_bundle=Path(sys.argv[1]))
    root = fixture.output / "runtimes" / receipt["runtime"]["runtimeId"]
    engine = root / "inference" / "managed"
    record = json.loads((engine / "runtime.json").read_text())
    document, references = availability(receipt, None)
    assert len(record["files"]) == 42
    assert not list(root.rglob("*.gguf"))
    assert document["bundledLocalInferenceAvailable"]
    assert not document["prebuiltLocalModelAvailable"]
    assert document["agents"][0]["status"] == "unqualified"
    assert not receipt["activationAllowed"]
    print(json.dumps({"files": len(record["files"]), "modelsBundled": False, "qualified": False}))
finally:
    fixture.doCleanups()
`,
        bundle!,
      ],
      {
        cwd: fileURLToPath(new URL("./", import.meta.url)),
        encoding: "utf8",
        timeout: 180_000,
        maxBuffer: 65536,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout), {
      files: 42,
      modelsBundled: false,
      qualified: false,
    });
  },
);
