// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TRANSACTION = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "mcp-config-transaction.py",
);
const MANIFEST_NAME = "openshell-child-visible-credentials.v0.0.85.json";
const validManifest: Record<string, unknown> = {
  openshellVersion: "0.0.85",
  rawChildValueKeys: ["RAW_CHILD_VALUE"],
  rewrittenChildValueKeys: ["REWRITTEN_CHILD_VALUE"],
  runtimeControlKeys: ["RUNTIME_CONTROL"],
  runtimeControlPrefixes: ["RUNTIME_CONTROL_"],
};

function runEmbeddedTransactionImport(setup: (helperDir: string) => void = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mcp-manifest-"));
  const helperDir = path.join(root, "isolated", "helper");
  const helper = path.join(helperDir, "mcp-config-transaction.py");
  fs.mkdirSync(helperDir, { recursive: true });
  fs.copyFileSync(TRANSACTION, helper);
  setup(helperDir);

  try {
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("isolated_mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
try:
    spec.loader.exec_module(module)
except Exception as error:
    outcome = {"loaded": False, "type": type(error).__name__, "message": str(error)}
else:
    outcome = {"loaded": True, "type": "", "message": ""}
print(json.dumps(outcome))
`,
        helper,
      ],
      { encoding: "utf-8", timeout: 5000 },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as { loaded: boolean; type: string; message: string };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runEmbeddedTransactionImportWithManifest(manifest: Record<string, unknown>) {
  return runEmbeddedTransactionImport((helperDir) => {
    fs.writeFileSync(path.join(helperDir, MANIFEST_NAME), JSON.stringify(manifest));
  });
}

describe("Hermes MCP credential boundary manifest (#6256)", () => {
  it("fails closed when the manifest is missing", () => {
    expect(runEmbeddedTransactionImport()).toEqual({
      loaded: false,
      type: "RuntimeError",
      message: "Hermes MCP credential boundary manifest is missing",
    });
  });

  it("fails closed on a manifest for another OpenShell version", () => {
    expect(
      runEmbeddedTransactionImportWithManifest({
        ...validManifest,
        openshellVersion: "0.0.0-unreviewed",
      }),
    ).toEqual({
      loaded: false,
      type: "RuntimeError",
      message: "Hermes MCP credential boundary manifest is invalid",
    });
  });

  it.each([
    "rawChildValueKeys",
    "rewrittenChildValueKeys",
    "runtimeControlKeys",
    "runtimeControlPrefixes",
  ])("fails closed when %s is missing", (key) => {
    const incomplete = { ...validManifest };
    delete incomplete[key];
    expect(runEmbeddedTransactionImportWithManifest(incomplete)).toEqual({
      loaded: false,
      type: "RuntimeError",
      message: `Hermes MCP credential boundary manifest has invalid ${key}`,
    });
  });
});
