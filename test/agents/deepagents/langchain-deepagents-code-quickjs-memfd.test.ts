// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const patcherPath = path.join(
  process.cwd(),
  "agents",
  "langchain-deepagents-code",
  "patch-managed-quickjs.py",
);

const upstreamSource = `from __future__ import annotations

import threading
import wasmtime

_SHARED_ENGINE = None
_SHARED_ENGINE_LOCK = threading.Lock()


def shared_wasmtime_engine():
    global _SHARED_ENGINE
    if _SHARED_ENGINE is None:
        with _SHARED_ENGINE_LOCK:
            if _SHARED_ENGINE is None:
                _SHARED_ENGINE = wasmtime.Engine()
    return _SHARED_ENGINE
`;

function makeQuickjsFixture(version = "0.2.5", source = upstreamSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-quickjs-memfd-"));
  const packageRoot = path.join(root, "quickjs_rs");
  const metadataRoot = path.join(root, `quickjs_rs-${version}.dist-info`);
  fs.mkdirSync(packageRoot);
  fs.mkdirSync(metadataRoot);
  fs.writeFileSync(path.join(packageRoot, "__init__.py"), "", "utf8");
  fs.writeFileSync(path.join(packageRoot, "_wasmtime.py"), source, "utf8");
  fs.writeFileSync(
    path.join(metadataRoot, "METADATA"),
    `Metadata-Version: 2.1\nName: quickjs-rs\nVersion: ${version}\n`,
    "utf8",
  );
  return { root, enginePath: path.join(packageRoot, "_wasmtime.py") };
}

function runPatcher(root: string) {
  return spawnSync("python3", [patcherPath], {
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: root },
  });
}

describe("managed QuickJS Wasmtime compatibility patch", () => {
  it("disables copy-on-write memory initialization for quickjs-rs 0.2.5 (#11847)", () => {
    const fixture = makeQuickjsFixture();
    try {
      const result = runPatcher(fixture.root);
      const patched = fs.readFileSync(fixture.enginePath, "utf8");

      expect(result.status, result.stderr).toBe(0);
      expect(patched).toContain("# NemoClaw-managed OpenShell memfd compatibility.");
      expect(patched).toContain("config.memory_init_cow = False");
      expect(patched).toContain("_SHARED_ENGINE = wasmtime.Engine(config)");
      expect(patched).not.toContain("_SHARED_ENGINE = wasmtime.Engine()");
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("keeps the exact managed patch idempotent", () => {
    const fixture = makeQuickjsFixture();
    try {
      expect(runPatcher(fixture.root).status).toBe(0);
      const once = fs.readFileSync(fixture.enginePath, "utf8");
      const second = runPatcher(fixture.root);

      expect(second.status, second.stderr).toBe(0);
      expect(fs.readFileSync(fixture.enginePath, "utf8")).toBe(once);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects an unreviewed quickjs-rs version", () => {
    const fixture = makeQuickjsFixture("0.2.6");
    try {
      const result = runPatcher(fixture.root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Expected quickjs-rs==0.2.5, found 0.2.6");
      expect(fs.readFileSync(fixture.enginePath, "utf8")).toBe(upstreamSource);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects source drift at the Wasmtime engine boundary", () => {
    const fixture = makeQuickjsFixture(
      "0.2.5",
      upstreamSource.replace("wasmtime.Engine()", "wasmtime.Engine(wasmtime.Config())"),
    );
    try {
      const result = runPatcher(fixture.root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Expected one quickjs-rs 0.2.5 default Wasmtime engine constructor",
      );
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});

const validatorPath = path.join(path.dirname(patcherPath), "validate-quickjs-runtime.py");

function runValidatorFixture(scenario: string) {
  return spawnSync(
    "python3",
    [
      "-I",
      "-c",
      `
import asyncio, errno, importlib.util, os, sys, types
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("validator", sys.argv[1])
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)
scenario = sys.argv[2]
closed = []

if scenario.startswith("memfd-"):
    def memfd(*args):
        if scenario == "memfd-allowed":
            return 71
        code = errno.EPERM if scenario == "memfd-denied" else errno.ENOSYS
        raise OSError(code, "private-runtime-detail")
    with patch.object(validator.os, "memfd_create", memfd, create=True), \\
         patch.object(validator.os, "MFD_CLOEXEC", 1, create=True), \\
         patch.object(validator.os, "MFD_ALLOW_SEALING", 2, create=True), \\
         patch.object(validator.os, "close", closed.append):
        try:
            validator.require_memfd_denied()
            print("DENIAL_VERIFIED")
        except RuntimeError as error:
            print(str(error))
        print("CLOSED", closed)
    raise SystemExit(0)

class StructuredTool:
    @staticmethod
    def from_function(fn):
        return fn

class Repl:
    restored = False
    def install_tools(self, tools):
        self.tool = tools[0]
    async def eval_async(self, code):
        if scenario == "runtime-error":
            raise RuntimeError("private-runtime-detail")
        value = "42" if scenario == "no-tool-call" else self.tool()
        return types.SimpleNamespace(error_type=None, result=value)
    async def acreate_snapshot(self):
        return b"state"
    async def arestore_snapshot(self, snapshot):
        assert snapshot == b"state"
        self.restored = True
    def eval_sync(self, code):
        assert self.restored
        value = str(42 + int(self.tool()))
        return types.SimpleNamespace(
            error_type="WasmtimeError" if scenario == "restore-error" else None,
            result="wrong" if scenario == "wrong-result" else value,
        )

class Registry:
    def __init__(self, **kwargs):
        self.repl = Repl()
    def get(self, name):
        return self.repl
    async def aevict(self, name):
        self.repl = Repl()
    def close(self):
        print("REGISTRY_CLOSED")

sys.modules["langchain_core.tools"] = types.SimpleNamespace(StructuredTool=StructuredTool)
sys.modules["langchain_quickjs._repl"] = types.SimpleNamespace(_Registry=Registry)
sys.argv = [sys.argv[1]]
validator.main()
`,
      validatorPath,
      scenario,
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
}

describe("managed QuickJS runtime validation", () => {
  it("accepts tool execution across interpreter restoration", () => {
    const result = runValidatorFixture("success");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("REGISTRY_CLOSED");
    expect(result.stdout).toContain("NEMOCLAW_QUICKJS_TOOL_RUNTIME_OK");
  });

  it.each(["no-tool-call", "runtime-error", "restore-error", "wrong-result"])(
    "rejects %s and closes the interpreter without exposing exception details",
    (scenario) => {
      const result = runValidatorFixture(scenario);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("REGISTRY_CLOSED\n");
      expect(result.stderr).toContain("QuickJS/Wasmtime compatibility validation failed");
      expect(result.stderr).not.toContain("private-runtime-detail");
    },
  );

  it("accepts only EPERM as evidence of memfd denial", () => {
    const denied = runValidatorFixture("memfd-denied");
    expect(denied.status, denied.stderr).toBe(0);
    expect(denied.stdout).toBe("DENIAL_VERIFIED\nCLOSED []\n");
    const unsupported = runValidatorFixture("memfd-unsupported");
    expect(unsupported.status, unsupported.stderr).toBe(0);
    expect(unsupported.stdout).toContain("could not verify memfd denial");
    expect(unsupported.stdout).not.toContain("DENIAL_VERIFIED");
  });

  it("rejects an allowed memfd and closes the unexpected descriptor", () => {
    const result = runValidatorFixture("memfd-allowed");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("requires memfd_create to return EPERM");
    expect(result.stdout).toContain("CLOSED [71]");
    expect(result.stdout).not.toContain("DENIAL_VERIFIED");
  });
});
