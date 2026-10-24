// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildNativeWorkers } from "../../packaging/windows/distribution/build-native-workers.mts";
import { nativeRuntimeWorkerCommand } from "../../packaging/windows/runtime/native-runtime.mts";
import { nativeWorkerApiFixture } from "../helpers/native-worker-api-fixture.ts";

const owner = path.resolve("packaging/windows/installer/prepare-finished-host.py");
const sourceLock = JSON.parse(
  fs.readFileSync(path.resolve("packaging/windows/openshell-native-transport.lock.json"), "utf8"),
) as { baseRevision: string; patchedTree: string; patchSha256: string };
const python = process.platform === "win32" ? "python" : "python3";
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const names = [
  "openshell.exe",
  "openshell-gateway.exe",
  "openshell-supervisor.exe",
  "openshell-windows-sandbox.exe",
  "libz3.dll",
];
type FileIdentity = { file: string; bytes: number; sha256: string };
const fileIdentityMutations: readonly {
  name: string;
  apply: (files: FileIdentity[]) => void;
}[] = [
  { name: "missing", apply: (files) => void files.pop() },
  { name: "duplicate", apply: (files) => (files[1] = { ...files[0]! }) },
  { name: "traversal", apply: (files) => (files[0]!.file = "../openshell.exe") },
  { name: "hash", apply: (files) => (files[0]!.sha256 = "b".repeat(64)) },
  { name: "size", apply: (files) => void files[0]!.bytes++ },
];
const invoke = `
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("host", sys.argv[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
root = pathlib.Path(sys.argv[2])
host.verify_openshell_build(root, "a" * 40, "123", "1")
`;

it.each([
  { version: "2026.9.2", exitCode: 0 },
  { version: "2026.7.1", exitCode: 1 },
])(
  "compiled OpenClaw API fixture $version uses its linked API and exits $exitCode",
  async ({ version, exitCode }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-openclaw-worker-"));
    const fixture = path.join(root, "api.mjs");
    const output = path.join(root, "compiled");
    fs.writeFileSync(
      fixture,
      `
export function registerPrebuiltPlugins() {}
export function buildNativeModelCatalog() { throw new Error("Catalog is not used by the turn fixture"); }
export function parseNativeConfiguration() { throw new Error("Configuration parsing is not used by the turn fixture"); }
export function runOpenClaw(argv) {
  if (!process.execArgv.includes("--preserve-symlinks-main")) throw new Error("Worker entry traverses denied ancestors");
  if (!process.execArgv.includes("--preserve-symlinks")) throw new Error("Worker dependencies traverse denied ancestors");
  process.stdout.write(argv[2] === "--version" ? ${JSON.stringify(version)} : JSON.stringify({payloads:[{text:"CHAT_OK"}]}));
}
`,
    );
    try {
      const mockPort = 20000 + (process.pid % 40000);
      const runtime = nativeWorkerApiFixture(root, mockPort);
      await buildNativeWorkers(runtime, output, fixture);
      fs.unlinkSync(fixture);
      const result = path.join(root, "result.json");
      const invocation = spawnSync(
        process.execPath,
        [
          "--preserve-symlinks",
          "--preserve-symlinks-main",
          path.join(output, "native-runtime.cjs"),
        ],
        {
          env: {
            ...process.env,
            NEMOCLAW_WORKER_ROOT: output,
            NEMOCLAW_WORKER_MODE: "openclaw-turn",
            NEMOCLAW_MXC_OPENCLAW_ENTRY: path.join(root, "absent-installed-entry.cjs"),
            NEMOCLAW_MXC_HOME: path.join(root, "home"),
            NEMOCLAW_MXC_RESULT: result,
            NEMOCLAW_MXC_MOCK_PORT: String(mockPort),
          },
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      expect(invocation.error).toBeUndefined();
      expect(invocation.status, invocation.stderr).toBe(exitCode);
      expect(JSON.parse(fs.readFileSync(result, "utf8"))).toEqual({
        executionMode: "embedded-worker",
        version,
        versionExitCode: 0,
        versionError: "",
        chatExitCode: 0,
        chatError: "",
        exactReply: true,
        reply: "CHAT_OK",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

it("packaged OpenClaw workers load dependencies without canonicalizing ungranted ancestors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-openclaw-resolver-"));
  const entry = path.join(root, "app.cjs");
  const output = path.join(root, "compiled");
  try {
    fs.writeFileSync(
      entry,
      `exports.runOpenClaw = argv => {
  require("node:assert/strict").throws(() => require("node:fs").realpathSync(__filename), /ungranted ancestor/);
  process.stdout.write(argv[2] === "--version" ? "2026.9.2" : JSON.stringify({payloads:[{text:"CHAT_OK"}]}));
};`,
    );
    const mockPort = 20000 + (process.pid % 40000);
    await buildNativeWorkers(nativeWorkerApiFixture(root, mockPort), output);
    const worker = path.join(output, "openclaw-invoke.cjs");
    // Model the denied lookup before the actual generated packaged API is loaded.
    fs.writeFileSync(
      worker,
      `require("node:fs").realpathSync = () => { throw new Error("ungranted ancestor"); };\n` +
        fs.readFileSync(worker, "utf8"),
    );
    const [node, ...args] = nativeRuntimeWorkerCommand(
      {
        purpose: "openclaw",
        node: process.execPath,
        runtimeRoot: output,
        runtimeId: "a".repeat(64),
        agentRoot: root,
        assertHeld() {},
      },
      path.join(output, "native-runtime.cjs"),
    );
    const result = path.join(root, "result.json");
    const invocation = spawnSync(node!, args, {
      env: {
        ...process.env,
        NEMOCLAW_WORKER_ROOT: output,
        NEMOCLAW_WORKER_MODE: "openclaw-turn",
        NEMOCLAW_MXC_OPENCLAW_ENTRY: entry,
        NEMOCLAW_MXC_HOME: path.join(root, "home"),
        NEMOCLAW_MXC_RESULT: result,
        NEMOCLAW_MXC_MOCK_PORT: String(mockPort),
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(invocation.error).toBeUndefined();
    expect(invocation.status, invocation.stderr + fs.readFileSync(result, "utf8")).toBe(0);
    expect(JSON.parse(fs.readFileSync(result, "utf8"))).toEqual({
      executionMode: "embedded-worker",
      version: "2026.9.2",
      versionExitCode: 0,
      versionError: "",
      chatExitCode: 0,
      chatError: "",
      exactReply: true,
      reply: "CHAT_OK",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  { agent: "openclaw", lockFile: "app/windows-app-build.lock.json", linkedTools: ["typescript"] },
  { agent: "hermes", lockFile: "distribution/native-build-tools.lock.json", linkedTools: [] },
])(
  "$agent worker builds resolve policy validation from only the declared build tools",
  ({ agent, lockFile, linkedTools }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-build-tools-"));
    try {
      const windows = path.join(root, "packaging/windows");
      const source = path.resolve("packaging/windows");
      fs.cpSync(source, windows, {
        recursive: true,
        filter: (file) =>
          ["", "distribution", "runtime", "onboarding"].includes(
            path.relative(source, file).split(path.sep)[0],
          ),
      });
      fs.mkdirSync(path.join(root, "nemoclaw-blueprint"));
      fs.copyFileSync(
        path.resolve("nemoclaw-blueprint/private-networks.yaml"),
        path.join(root, "nemoclaw-blueprint/private-networks.yaml"),
      );
      const lock = JSON.parse(fs.readFileSync(path.resolve("packaging/windows", lockFile), "utf8"));
      const pins = (agent === "openclaw" ? lock.compilerPackages : lock.packages) as {
        package: string;
      }[];
      const packages = new Set(
        pins
          .map((pin) => pin.package)
          .filter((name) => !name.startsWith("@esbuild/") && name !== "playwright-core"),
      );
      // CI links OpenClaw's pinned TypeScript into the build tools directory.
      const selected = [
        ...packages,
        ...linkedTools,
        `@esbuild/${process.platform}-${process.arch}`,
      ];
      const installed = path.resolve("node_modules");
      fs.cpSync(installed, path.join(root, "node_modules"), {
        recursive: true,
        dereference: true,
        filter: (file) => {
          const relative = path.relative(installed, file).split(path.sep).join("/");
          return (
            relative === "" ||
            selected.some(
              (name) =>
                relative === name ||
                relative.startsWith(name + "/") ||
                name.startsWith(relative + "/"),
            )
          );
        },
      });
      const result = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          `
import { buildNativeWorkers } from './packaging/windows/distribution/build-native-workers.mts';
import { prepareRuntimeSource } from './packaging/windows/distribution/prepare-runtime-source.mts';
const staged = prepareRuntimeSource('./packaging/windows/runtime');
try {
  await buildNativeWorkers(staged.runtime, './workers', undefined, {
    sourceRevision: '${"a".repeat(40)}', onboardingSource: './packaging/windows/onboarding'
  });
} finally { staged.close(); }
`,
        ],
        { cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_PATH: "" } },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const description = spawnSync(
        process.execPath,
        [path.join(root, "workers/native-runtime.cjs"), "--describe-runtime"],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(description.status, description.stderr).toBe(0);
      expect(JSON.parse(description.stdout).guestModes).toEqual([
        "openclaw-turn",
        "openclaw-web",
        "hermes-turn",
        "interactive",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

describe("current OpenShell installer build evidence", () => {
  let root: string;
  let receipt: Record<string, unknown>;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-build-"));
    // Minimal PE headers exercise identity checks; these files are never executed.
    const binary = Buffer.alloc(128);
    binary.write("MZ");
    binary.writeUInt32LE(64, 60);
    binary.write("PE\0\0", 64);
    binary.writeUInt16LE(0xaa64, 68);
    for (const name of names) fs.writeFileSync(path.join(root, name), binary);
    receipt = {
      schemaVersion: 1,
      classification: "ci-built-openshell-host-binaries",
      requestedSourceRevision: "a".repeat(40),
      openshellRevision: sourceLock.baseRevision,
      derivativePatchSha256: sourceLock.patchSha256,
      sourceTree: sourceLock.patchedTree,
      sourceUnchanged: true,
      rustToolchain: "1.95.0-aarch64-pc-windows-msvc",
      rustTarget: "aarch64-pc-windows-msvc",
      workflowRunId: "123",
      workflowRunAttempt: "1",
      currentPackageQualification: false,
      files: names.map((file) => ({ file, bytes: binary.length, sha256: hash(binary) })),
    };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function verify() {
    fs.writeFileSync(path.join(root, "openshell-build.json"), JSON.stringify(receipt));
    const result = spawnSync(python, ["-B", "-c", invoke, owner, root], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return result;
  }

  it("accepts all five same-run ARM64 host components without claiming qualification", () => {
    const result = verify();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each([
    ["classification", "ci-reused-openshell-host-binaries"],
    ["requestedSourceRevision", "b".repeat(40)],
    ["openshellRevision", "b".repeat(40)],
    ["derivativePatchSha256", "b".repeat(64)],
    ["derivativePatchSha256", null],
    ["sourceTree", "b".repeat(40)],
    ["sourceTree", undefined],
    ["sourceUnchanged", false],
    ["workflowRunId", "122"],
    ["workflowRunAttempt", "2"],
    ["rustToolchain", "stable"],
    ["rustTarget", "x86_64-pc-windows-msvc"],
    ["currentPackageQualification", true],
  ])("rejects mismatched %s", (field, value) => {
    receipt[field as string] = value;
    expect(verify().status).not.toBe(0);
  });

  it.each(fileIdentityMutations)("rejects a $name file identity", ({ apply }) => {
    apply(receipt.files as FileIdentity[]);
    expect(verify().status).not.toBe(0);
  });

  it("rejects changed bytes even with an otherwise valid receipt", () => {
    fs.appendFileSync(path.join(root, names[0]), "changed");
    expect(verify().status).not.toBe(0);
  });

  it("rejects x64 executables even when their content hashes match", () => {
    const binary = fs.readFileSync(path.join(root, names[0]));
    binary.writeUInt16LE(0x8664, 68);
    fs.writeFileSync(path.join(root, names[0]), binary);
    const files = receipt.files as { sha256: string }[];
    files[0].sha256 = hash(binary);
    expect(verify().status).not.toBe(0);
  });
});
