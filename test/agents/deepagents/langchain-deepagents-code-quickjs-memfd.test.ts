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
