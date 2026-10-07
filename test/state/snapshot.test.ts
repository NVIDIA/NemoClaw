// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import childProcess, { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-state-"));
process.env.HOME = TMP_HOME;

const sandboxState = await import(
  pathToFileURL(path.join(import.meta.dirname, "../..", "src", "lib", "state", "sandbox.ts")).href
);
const { backupSandboxStateWithManagedAuthority } = await import(
  pathToFileURL(
    path.join(
      import.meta.dirname,
      "../..",
      "src",
      "lib",
      "actions",
      "sandbox",
      "snapshot",
      "backup-authority.ts",
    ),
  ).href
);
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");
const PUBLIC_AWS_EXAMPLE_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const BOTO3_DOC = ".hermes/lazy-packages/boto3/examples/cloudfront.rst";
const OPENCLAW_SQLITE_WAL = ".openclaw/state/cache.sqlite-wal";
const SQLITE_CREDENTIAL_BYTES = `SQLite format 3\0ghp_${"02468ace13579bdf"}`;

afterAll(() => {
  restoreEnv("HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
});

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function restoreEnv(name: string, value: string | undefined): void {
  value === undefined
    ? Reflect.deleteProperty(process.env, name)
    : Reflect.set(process.env, name, value);
}

function tarHeader(
  entryPath: string,
  content: Buffer,
  options: { type?: string; linkTarget?: string } = {},
): Buffer {
  const header = Buffer.alloc(512, 0);
  const type = options.type ?? "0";
  header.write(entryPath, 0, Math.min(entryPath.length, 100), "utf8");
  header.write("0000644\0", 100, 8, "utf8");
  header.write("0001000\0", 108, 8, "utf8");
  header.write("0001000\0", 116, 8, "utf8");
  const size = ["0", "S", "x", "g"].includes(type) ? content.length : 0;
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  header.write(
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0")}\0`,
    136,
    12,
    "utf8",
  );
  header.write(type, 156, 1, "utf8");
  if (options.linkTarget) {
    header.write(options.linkTarget, 157, Math.min(options.linkTarget.length, 100), "utf8");
  }
  header.write("ustar\0", 257, 6, "utf8");
  header.write("00", 263, 2, "utf8");
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  return header;
}

function paddedTarPayload(content: Buffer): Buffer {
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512, 0);
  content.copy(padded);
  return padded;
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${length}${body}`) !== length) {
    length = Buffer.byteLength(`${length}${body}`);
  }
  return Buffer.from(`${length}${body}`, "utf8");
}

function buildSparseTar(kind: "old-gnu" | "pax" | "global-pax"): Buffer {
  if (kind === "old-gnu") {
    return Buffer.concat([
      tarHeader("sparse.bin", Buffer.alloc(0), { type: "S" }),
      Buffer.alloc(1024, 0),
    ]);
  }
  const metadata = paxRecord("GNU.sparse.size", "1048576");
  const file = Buffer.from("ordinary payload", "utf8");
  return Buffer.concat([
    tarHeader("PaxHeaders/sparse.bin", metadata, {
      type: kind === "pax" ? "x" : "g",
    }),
    paddedTarPayload(metadata),
    tarHeader("sparse.bin", file),
    paddedTarPayload(file),
    Buffer.alloc(1024, 0),
  ]);
}

function buildSymlinkTraversalTar(): Buffer {
  const payload = Buffer.from("must stay contained", "utf8");
  const paddedPayload = Buffer.alloc(Math.ceil(payload.length / 512) * 512, 0);
  payload.copy(paddedPayload);
  return Buffer.concat([
    tarHeader("redirect", Buffer.alloc(0), {
      type: "2",
      linkTarget: "../outside",
    }),
    tarHeader("redirect/payload.txt", payload),
    paddedPayload,
    Buffer.alloc(1024, 0),
  ]);
}

function buildSymlinkCredentialTraversalTar(): Buffer {
  const payload = Buffer.from('{"enabled":true}', "utf8");
  const paddedPayload = Buffer.alloc(Math.ceil(payload.length / 512) * 512, 0);
  payload.copy(paddedPayload);
  return Buffer.concat([
    tarHeader("redirect", Buffer.alloc(0), {
      type: "2",
      linkTarget: "../../outside-native-scan",
    }),
    tarHeader("redirect/config.json", payload),
    paddedPayload,
    Buffer.alloc(1024, 0),
  ]);
}

function writeSandboxRegistry(sandboxName: string, agent: "hermes" | null = null): void {
  fs.mkdirSync(path.join(TMP_HOME, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_HOME, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: { name: sandboxName, model: "m", provider: "p", gpuEnabled: false, agent },
      },
    }),
  );
}

function writeFakeOpenshell(binDir: string): void {
  writeExecutable(
    path.join(binDir, "openshell"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "sandbox" && args[1] === "ssh-config") {
  process.stdout.write("Host openshell-alpha\\n  HostName 127.0.0.1\\n  User sandbox\\n");
  process.exit(0);
}
process.exit(0);
`,
  );
}

function writeFakeSsh(binDir: string): void {
  writeExecutable(
    path.join(binDir, "ssh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const command = process.argv.at(-1) || "";
const root = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
const remoteRoot = process.env.NEMOCLAW_TEST_NATIVE_HOME || "/sandbox";
const remoteWorkspace = process.env.NEMOCLAW_TEST_NATIVE_WORKSPACE || remoteRoot;
const commandLog = process.env.NEMOCLAW_TEST_SSH_COMMAND_LOG;
const copyTree = (source, destination) => {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      copyTree(path.join(source, name), path.join(destination, name));
    }
    return;
  }
  fs.copyFileSync(source, destination);
};
if (commandLog) fs.appendFileSync(commandLog, command + "\\n---\\n");
if (!root) process.exit(90);
if (command.includes("printf '%s\\\\0%s\\\\0'")) {
  process.stdout.write(Buffer.from(remoteRoot + "\\0" + remoteWorkspace + "\\0"));
  process.exit(0);
}
if (command.includes("tar -C")) {
  const captureBytes = process.env.NEMOCLAW_TEST_CAPTURE_BYTES;
  if (captureBytes) {
    process.stdout.write(Buffer.alloc(Number(captureBytes), 120));
    process.exit(0);
  }
  const copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-capture-test-"));
  try {
    for (const name of fs.readdirSync(root)) {
      copyTree(path.join(root, name), path.join(copyRoot, name));
    }
    fs.rmSync(path.join(copyRoot, ".nemoclaw", "config.json"), { force: true });
    fs.rmSync(path.join(copyRoot, ".nemoclaw", "blueprints"), { recursive: true, force: true });
    fs.rmSync(path.join(copyRoot, ".openclaw", ".nemoclaw-post-upgrade-doctor"), { force: true });
    const sessionDirectory = path.join(copyRoot, ".openclaw", "agents", "main", "sessions");
    if (fs.existsSync(sessionDirectory)) {
      for (const name of fs.readdirSync(sessionDirectory)) {
        if (name.startsWith("nemoclaw-onboard-warmup-")) {
          fs.rmSync(path.join(sessionDirectory, name), { recursive: true, force: true });
        }
      }
    }
    const hardDereferenceSupported = spawnSync("tar", ["--hard-dereference", "-cf", "-", "--files-from", "/dev/null"], { stdio: "ignore" }).status === 0;
    const tarArgs = hardDereferenceSupported
      ? ["-C", copyRoot, "--hard-dereference", "-cf", "-", "--", "."]
      : ["-C", copyRoot, "-cf", "-", "--", "."];
    process.exit(spawnSync("tar", tarArgs, { stdio: ["ignore", "inherit", "inherit"] }).status ?? 91);
  } finally {
    fs.rmSync(copyRoot, { recursive: true, force: true });
  }
}
if (command.includes("nemoclaw-native-restore")) {
  if (process.env.NEMOCLAW_TEST_EXECUTE_RESTORE_SCRIPT === "1") {
    const restored = spawnSync("sh", ["-c", command], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    process.exit(restored.status ?? 94);
  }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-restore-test-"));
  try {
    const extracted = spawnSync("tar", ["--no-same-owner", "-xf", "-", "-C", stage], { stdio: ["inherit", "inherit", "inherit"] });
    if (extracted.status !== 0) process.exit(extracted.status ?? 92);
    const walk = (current) => {
      for (const name of fs.readdirSync(current)) {
        const full = path.join(current, name);
        const stat = fs.lstatSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (stat.isFile() && stat.nlink > 1) {
          process.exit(21);
        }
      }
    };
    walk(stage);
    for (const entry of fs.readdirSync(root)) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    for (const entry of fs.readdirSync(stage)) {
      copyTree(path.join(stage, entry), path.join(root, entry));
    }
    process.exit(0);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
process.exit(93);
`,
  );
}

describe("complete native home persistence", () => {
  it("rejects credential-bearing stopped-state handoff before publication", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-credential-state-"));
    try {
      const nativeRoot = path.join(fixture, "native-home");
      const credentialPath = path.join(nativeRoot, ".openclaw", ".env");
      const sourceCredential = ["COMPATIBLE_API_KEY=ghp", "_", "0123456789abcdef", "\n"].join("");
      fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
      fs.writeFileSync(credentialPath, sourceCredential);
      writeSandboxRegistry("alpha");
      const assertCurrent = vi.fn();

      const backup = backupSandboxStateWithManagedAuthority(
        "alpha",
        {
          getSandbox: () => ({
            name: "alpha",
            agent: "openclaw",
            openshellDriver: "docker",
          }),
          backup: sandboxState.backupSandboxState,
        },
        {
          sandboxName: "alpha",
          agentName: "openclaw",
          nativeDirectory: nativeRoot,
          directory: path.join(nativeRoot, ".openclaw"),
          cleanupDirectory: fixture,
          assertCurrent,
          dispose: vi.fn(),
        },
      );

      expect(backup.success).toBe(false);
      expect(backup.manifest).toBeUndefined();
      expect(backup.error).toContain("credential-bearing or uninspectable content");
      expect(assertCurrent).toHaveBeenCalledOnce();
      expect(fs.readFileSync(credentialPath, "utf8")).toBe(sourceCredential);
      const sandboxBackups = path.join(BACKUPS_ROOT, "alpha");
      expect(fs.existsSync(sandboxBackups) ? fs.readdirSync(sandboxBackups) : []).toEqual([]);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
  it("captures a prepared stopped tree without SSH and inspects only a requested subtree", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-native-state-"));
    try {
      const nativeRoot = path.join(fixture, "native-home");
      const writeNative = (relativePath: string, content: string): void =>
        fs.writeFileSync(path.join(nativeRoot, relativePath), content);
      const inspectionMarker = "not-part-of-hermes-inspection";
      fs.mkdirSync(path.join(nativeRoot, ".hermes"), { recursive: true });
      fs.mkdirSync(path.join(nativeRoot, ".hermes", "runtime"), { recursive: true });
      fs.mkdirSync(path.join(nativeRoot, ".openclaw"), { recursive: true });
      fs.mkdirSync(path.join(nativeRoot, ".openclaw", "state"));
      fs.mkdirSync(path.join(nativeRoot, "node_modules", "example"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(nativeRoot, "schemas"), { recursive: true });
      fs.mkdirSync(path.join(nativeRoot, ".nemoclaw", "blueprints", "0.1.0", "provider-profiles"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(nativeRoot, ".pi", "agent"), { recursive: true });
      fs.mkdirSync(path.join(nativeRoot, ".openclaw", "agents", "main", "sessions"), {
        recursive: true,
      });
      writeNative(".nemoclaw/config.json", "managed-config");
      writeNative(
        ".openclaw/.nemoclaw-post-upgrade-doctor",
        "nemoclaw-openclaw-backup-quiesce-v1\n",
      );
      writeNative(
        ".openclaw/agents/main/sessions/nemoclaw-onboard-warmup-1.trajectory.jsonl",
        "managed-warmup",
      );
      writeNative(".openclaw/state/openclaw.sqlite-wal", "transient-wal");
      const hermesManagedConfig = "model:\n  api_key: sk-OPENSHELL-PROXY-REWRITE\n";
      writeNative(".hermes/config.yaml", hermesManagedConfig);
      writeNative(".hermes/gateway.pid", "legacy-pid");
      writeNative(".hermes/runtime/gateway.pid", "pid");
      writeNative(".hermes/runtime/gateway.lock", "lock");
      fs.mkdirSync(path.join(nativeRoot, ".hermes", "backups", "config"), {
        recursive: true,
      });
      writeNative(".hermes/backups/config/config.yaml.good.20260928-091702", hermesManagedConfig);
      const payloadPath = path.join(nativeRoot, "payload.txt");
      const payloadCopyPath = path.join(nativeRoot, "payload-copy.txt");
      fs.writeFileSync(payloadPath, "payload");
      fs.linkSync(payloadPath, payloadCopyPath);
      const sourceInode = fs.statSync(payloadPath).ino;
      fs.writeFileSync(
        path.join(nativeRoot, "node_modules", "example", "package.json"),
        JSON.stringify({ apiKey: "dependency-metadata-is-not-runtime-config" }),
      );
      const dependencySource = path.join(
        nativeRoot,
        ".openclaw/extensions/nemoclaw/node_modules/execa/lib/stdio/type.js",
      );
      fs.mkdirSync(path.dirname(dependencySource), { recursive: true });
      fs.writeFileSync(
        dependencySource,
        "export const FILE_PATH_KEYS = new Set(['file', 'append']);\n",
      );
      fs.writeFileSync(
        path.join(nativeRoot, "schemas", "config.schema.json"),
        JSON.stringify({ apiKey: { type: "string" } }),
      );
      fs.copyFileSync(
        path.join(
          import.meta.dirname,
          "../..",
          "nemoclaw-blueprint/provider-profiles/entra-runtime-v1.yaml",
        ),
        path.join(
          nativeRoot,
          ".nemoclaw",
          "blueprints",
          "0.1.0",
          "provider-profiles",
          "entra-runtime-v1.yaml",
        ),
      );
      fs.writeFileSync(
        path.join(nativeRoot, ".pi", "agent", "models.json"),
        JSON.stringify({
          defaultModel: "nvidia/nemotron-3-super-120b-a12b",
          providers: {
            openshell: {
              api: "openai-completions",
              apiKey: "nemoclaw-managed-inference",
              baseUrl: "https://inference.local/v1",
            },
          },
        }),
      );
      const piTrust = path.join(nativeRoot, ".pi", "agent", "trust.json");
      fs.writeFileSync(piTrust, '{"project":"trusted-before-rebuild"}');
      const bundledCredentialBoundary = path.join(
        import.meta.dirname,
        "../..",
        "nemoclaw/dist/shared/credential-filter-boundary.cjs",
      );
      const bundledCredentialBoundaryCopy = path.join(
        nativeRoot,
        ".openclaw/extensions/nemoclaw/dist/shared/credential-filter-boundary.cjs",
      );
      fs.mkdirSync(path.dirname(bundledCredentialBoundaryCopy), {
        recursive: true,
      });
      fs.copyFileSync(bundledCredentialBoundary, bundledCredentialBoundaryCopy);
      const bundledRuntimeCode = path.join(
        import.meta.dirname,
        "../..",
        "nemoclaw/dist/blueprint/runner.js",
      );
      const bundledRuntimeCodeCopy = path.join(
        nativeRoot,
        ".openclaw/extensions/nemoclaw/dist/blueprint/runner.js",
      );
      fs.mkdirSync(path.dirname(bundledRuntimeCodeCopy), { recursive: true });
      fs.copyFileSync(bundledRuntimeCode, bundledRuntimeCodeCopy);
      fs.writeFileSync(path.join(nativeRoot, inspectionMarker), "unrelated");
      fs.writeFileSync(
        path.join(nativeRoot, ".openclaw", "unknown-state.json"),
        Buffer.alloc(16 * 1024 * 1024 + 1, 120),
      );
      const arbitraryConfig = path.join(
        nativeRoot,
        ".deepagents",
        "nemoclaw-dcode-config",
        "config.json",
      );
      fs.mkdirSync(path.dirname(arbitraryConfig), { recursive: true });
      fs.writeFileSync(arbitraryConfig, "configuration");
      const assertCurrent = vi.fn();
      writeSandboxRegistry("alpha");
      const backup = sandboxState.backupSandboxState("alpha", {
        nativeStateSource: {
          root: "/sandbox",
          directory: nativeRoot,
          assertCurrent,
        },
      });
      expect(backup.success, backup.error).toBe(true);
      const archivedPaths = spawnSync("tar", [
        "-tf",
        path.join(backup.manifest!.backupPath, "native-home.tar"),
      ]).stdout.toString();
      expect(archivedPaths).not.toContain(".nemoclaw/config.json");
      expect(archivedPaths).not.toContain(".openclaw/.nemoclaw-post-upgrade-doctor");
      expect(archivedPaths).not.toContain("nemoclaw-onboard-warmup-1.trajectory.jsonl");
      expect(archivedPaths).not.toContain(".openclaw/state/openclaw.sqlite-wal");
      expect(archivedPaths).not.toContain(".hermes/gateway.pid");
      expect(archivedPaths).not.toContain(".hermes/runtime/gateway.pid");
      expect(archivedPaths).not.toContain(".hermes/runtime/gateway.lock");
      expect(archivedPaths).toContain(".pi/agent/trust.json");
      expect(archivedPaths).not.toContain(".nemoclaw/blueprints/");
      expect(assertCurrent).toHaveBeenCalledTimes(2);
      expect(fs.statSync(payloadPath)).toMatchObject({
        ino: sourceInode,
        nlink: 2,
      });
      expect(fs.statSync(payloadCopyPath)).toMatchObject({
        ino: sourceInode,
        nlink: 2,
      });
      const inspected = sandboxState.inspectNativeSandboxState(
        backup.manifest!.backupPath,
        (root: string) => ({
          hermesPresent: fs.existsSync(path.join(root, ".hermes", "config.yaml")),
          unrelatedPresent: fs.existsSync(path.join(root, inspectionMarker)),
        }),
        ".hermes",
      );
      expect(inspected.hermesPresent).toBe(true);
      expect(inspected.unrelatedPresent).toBe(false);
      expect(
        fs
          .readdirSync(backup.manifest!.backupPath)
          .some((entry: string) => entry.startsWith(".native-inspect-")),
      ).toBe(false);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
  it("removes only OpenClaw machine-local gateway authority from the archive copy", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-gateway-state-"));
    try {
      const nativeRoot = path.join(fixture, "native-home");
      const configPath = path.join(nativeRoot, ".openclaw", "openclaw.json");
      const config = {
        gateway: {
          auth: { token: "gateway-token" },
          port: 18789,
        },
        agents: { defaults: { model: "nvidia/test-model" } },
      };
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      writeSandboxRegistry("alpha");

      const backup = sandboxState.backupSandboxState("alpha", {
        nativeStateSource: {
          root: "/sandbox",
          directory: nativeRoot,
          assertCurrent: vi.fn(),
        },
      });

      expect(backup.success, backup.error).toBe(true);
      sandboxState.inspectNativeSandboxState(
        backup.manifest!.backupPath,
        (root: string) => {
          const archivedConfig = JSON.parse(
            fs.readFileSync(path.join(root, ".openclaw", "openclaw.json"), "utf8"),
          );
          if (
            archivedConfig.gateway?.port !== 18789 ||
            Object.hasOwn(archivedConfig.gateway ?? {}, "auth") ||
            archivedConfig.agents?.defaults?.model !== "nvidia/test-model"
          ) {
            throw new Error("archived OpenClaw configuration was not narrowly sanitized");
          }
        },
        ".openclaw/openclaw.json",
      );
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual(config);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("sanitizes Hermes backup without host Python and preserves live state (#11174)", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-api-state-"));
    const run = childProcess.spawnSync;
    const hostSpawn = vi.spyOn(childProcess, "spawnSync").mockImplementation((...args) => {
      expect(path.basename(args[0]), "backup must not require host Python").not.toMatch(
        /^python(?:\d+(?:\.\d+)*)?$/u,
      );
      return Reflect.apply(run, childProcess, args);
    });
    syncBuiltinESMExports();
    try {
      const nativeRoot = path.join(fixture, "native-home");
      const envPath = path.join(nativeRoot, ".hermes", ".env");
      const source = `API_SERVER_KEY=${"a".repeat(64)}
OPENAI_API_KEY=sk-OPENSHELL-PROXY-REWRITE
LOG_LEVEL=info
`;
      fs.mkdirSync(path.dirname(envPath), { recursive: true });
      fs.writeFileSync(envPath, source);
      writeSandboxRegistry("alpha", "hermes");
      const backup = sandboxState.backupSandboxState("alpha", {
        nativeStateSource: { root: "/sandbox", directory: nativeRoot, assertCurrent: vi.fn() },
      });
      expect(backup.success, backup.error).toBe(true);
      sandboxState.inspectNativeSandboxState(
        backup.manifest!.backupPath,
        (root: string) => {
          const archivedEnv = fs.readFileSync(path.join(root, ".hermes", ".env"), "utf8");
          if (
            archivedEnv.includes("API_SERVER_KEY=") ||
            !archivedEnv.includes("OPENAI_API_KEY=sk-OPENSHELL-PROXY-REWRITE") ||
            !archivedEnv.includes("LOG_LEVEL=info")
          ) {
            throw new Error("archived Hermes environment was not narrowly sanitized");
          }
        },
        ".hermes/.env",
      );
      expect(fs.readFileSync(envPath, "utf8")).toBe(source);
      expect(hostSpawn).toHaveBeenCalled();
    } finally {
      hostSpawn.mockRestore();
      syncBuiltinESMExports();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("scrubs generated native authority while preserving benign rotated state", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-generated-authority-state-"));
    try {
      const nativeRoot = path.join(fixture, "native-home");
      const files = new Map<string, unknown>([
        [
          ".openclaw/openclaw.json.bak.1",
          {
            gateway: { auth: { token: "gateway-token" }, port: 18789 },
            agents: { defaults: { model: "nvidia/test-model" } },
          },
        ],
        [
          ".openclaw/openclaw.json.last-good",
          {
            gateway: { auth: { token: "last-good-gateway-token" }, port: 18789 },
            agents: { defaults: { model: "nvidia/test-model" } },
          },
        ],
        [
          ".openclaw/devices/paired.json",
          {
            device: {
              deviceId: "device-1",
              publicKey: "public-verification-material",
              tokens: { operator: { token: "rotated-device-token", scopes: ["operator.read"] } },
            },
          },
        ],
        [
          ".openclaw/identity/device-auth.json",
          {
            deviceId: "device-1",
            tokens: { operator: { token: "identity-device-token" } },
          },
        ],
        [
          ".openclaw/credentials/whatsapp/default/creds.json",
          { registrationId: 42, authToken: "whatsapp-session-authority" },
        ],
        [
          ".pi/agent/auth.json",
          { account: "managed-inference", apiKey: `nvapi-${"a".repeat(24)}` },
        ],
        [
          ".hermes/backups/config/config.yaml.good.20260928-213216",
          { model: "nvidia/test-model", api_key: `nvapi-${"b".repeat(24)}` },
        ],
      ]);
      for (const [relativePath, value] of files) {
        const target = path.join(nativeRoot, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(value, null, 2));
      }
      writeSandboxRegistry("alpha");

      const backup = sandboxState.backupSandboxState("alpha", {
        nativeStateSource: {
          root: "/sandbox",
          directory: nativeRoot,
          assertCurrent: vi.fn(),
        },
      });

      expect(backup.success, backup.error).toBe(true);
      sandboxState.inspectNativeSandboxState(backup.manifest!.backupPath, (root: string) => {
        const read = (relativePath: string): any =>
          JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
        const openClawBackup = read(".openclaw/openclaw.json.bak.1");
        expect(openClawBackup.gateway).toEqual({ port: 18789 });
        expect(openClawBackup.agents.defaults.model).toBe("nvidia/test-model");
        const openClawLastGood = read(".openclaw/openclaw.json.last-good");
        expect(openClawLastGood.gateway).toEqual({ port: 18789 });
        expect(openClawLastGood.agents.defaults.model).toBe("nvidia/test-model");

        const paired = read(".openclaw/devices/paired.json");
        expect(paired.device.deviceId).toBe("device-1");
        expect(paired.device.publicKey).toBe("public-verification-material");
        expect(paired.device.tokens.operator.token).toBe("[STRIPPED_BY_MIGRATION]");
        expect(paired.device.tokens.operator.scopes).toEqual(["operator.read"]);

        const identity = read(".openclaw/identity/device-auth.json");
        expect(identity.deviceId).toBe("device-1");
        expect(identity.tokens.operator.token).toBe("[STRIPPED_BY_MIGRATION]");

        const whatsapp = read(".openclaw/credentials/whatsapp/default/creds.json");
        expect(whatsapp).toEqual({
          registrationId: 42,
          authToken: "[STRIPPED_BY_MIGRATION]",
        });
        expect(read(".pi/agent/auth.json")).toEqual({
          account: "managed-inference",
          apiKey: "[STRIPPED_BY_MIGRATION]",
        });
        expect(read(".hermes/backups/config/config.yaml.good.20260928-213216")).toEqual({
          model: "nvidia/test-model",
          api_key: "[STRIPPED_BY_MIGRATION]",
        });
      });
      for (const [relativePath, value] of files) {
        expect(JSON.parse(fs.readFileSync(path.join(nativeRoot, relativePath), "utf8"))).toEqual(
          value,
        );
      }
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("allows the canonical public JWT documentation vector in dependency tests", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-public-jwt-fixture-"));
    try {
      const nativeRoot = path.join(fixture, "native-home");
      const fixturePath = path.join(nativeRoot, "node_modules", "zod", "tests", "string.test.ts");
      const publicJwt = [
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
        "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ",
        "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      ].join(".");
      fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
      fs.writeFileSync(fixturePath, `expect(parse(${JSON.stringify(publicJwt)})).toBe(true);\n`);
      writeSandboxRegistry("alpha");

      const backup = sandboxState.backupSandboxState("alpha", {
        nativeStateSource: {
          root: "/sandbox",
          directory: nativeRoot,
          assertCurrent: vi.fn(),
        },
      });

      expect(backup.success, backup.error).toBe(true);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("allows dependency source format markers and binary token-like noise", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dependency-fixture-"));
    try {
      const nativeRoot = path.join(fixture, "native-home");
      const sourcePath = path.join(nativeRoot, "node_modules", "jose", "key", "import.js");
      const binaryPath = path.join(nativeRoot, "node_modules", "image", "lib", "libimage.so");
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
      fs.writeFileSync(
        sourcePath,
        `if (!value.startsWith('-----BEGIN ${"PRIVATE KEY-----"}')) throw new TypeError();\n`,
      );
      fs.writeFileSync(
        binaryPath,
        Buffer.concat([
          Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]),
          Buffer.from(`sk-${"x".repeat(64)}`),
        ]),
      );
      writeSandboxRegistry("alpha");

      const backup = sandboxState.backupSandboxState("alpha", {
        nativeStateSource: {
          root: "/sandbox",
          directory: nativeRoot,
          assertCurrent: vi.fn(),
        },
      });

      expect(backup.success, backup.error).toBe(true);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("round-trips unknown home, workspace, package, plugin, hook, cron, and child-agent state", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-home-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldNativeRoot = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
    try {
      const binDir = path.join(fixture, "bin");
      const nativeRoot = path.join(fixture, "native-home");
      const openshellPrivate = path.join(fixture, ".openshell");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(nativeRoot, { recursive: true });
      fs.mkdirSync(openshellPrivate, { recursive: true });
      fs.writeFileSync(path.join(openshellPrivate, "credential"), "host-only-secret");
      writeFakeOpenshell(binDir);
      writeFakeSsh(binDir);
      process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
      process.env.NEMOCLAW_TEST_NATIVE_ROOT = nativeRoot;
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      writeSandboxRegistry("alpha");

      const expected = new Map([
        ["unknown.txt", "undeclared"],
        ["workspace/project.txt", "workspace"],
        [".openclaw/openclaw.json", '{"native":true}'],
        [".local/share/packages/tool.txt", "package"],
        [".openclaw/plugins/custom/index.js", "plugin"],
        [".openclaw/hooks/preflight.sh", "hook"],
        [".openclaw/cron/jobs.json", '{"jobs":[]}'],
        [".openclaw/agents/child/history.jsonl", "child-agent"],
        [".nemoclaw/agent-owned-sibling.txt", "preserved-sibling"],
        [
          "node_modules/combined-stream/yarn.lock",
          '# yarn lockfile v1\n\ndelayed-stream@~1.0.0:\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/delayed-stream/-/delayed-stream-1.0.0.tgz#df3ae199acadfb7d440aaae0b29e2272b24ec619"\n\nfar@~0.0.7:\n  version "0.0.7"\n  dependencies:\n    oop "0.0.3"\n',
        ],
        [
          "node_modules/example/package-lock.json",
          JSON.stringify({
            lockfileVersion: 3,
            packages: {
              "node_modules/cookie": {
                version: "1.0.0",
                resolved: "https://registry.example.test/cookie.tgz",
                integrity: "sha512-cHVibGljLXBhY2thZ2UtaW50ZWdyaXR5",
              },
            },
          }),
        ],
      ]);
      for (const [relativePath, contents] of expected) {
        const target = path.join(nativeRoot, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
      }
      const managedConfigPath = ".nemoclaw/config.json";
      const warmupSessionPath = ".openclaw/agents/main/sessions/nemoclaw-onboard-warmup-1.jsonl";
      const warmupTrajectoryPath =
        ".openclaw/agents/main/sessions/nemoclaw-onboard-warmup-1.trajectory.jsonl";
      fs.mkdirSync(path.dirname(path.join(nativeRoot, managedConfigPath)), { recursive: true });
      fs.mkdirSync(path.dirname(path.join(nativeRoot, warmupSessionPath)), { recursive: true });
      fs.writeFileSync(path.join(nativeRoot, managedConfigPath), "nemoclaw-owned-ephemeral-state");
      fs.writeFileSync(path.join(nativeRoot, warmupSessionPath), "nemoclaw-owned-ephemeral-state");
      fs.writeFileSync(
        path.join(nativeRoot, warmupTrajectoryPath),
        "nemoclaw-owned-ephemeral-state",
      );
      fs.linkSync(
        path.join(nativeRoot, ".local/share/packages/tool.txt"),
        path.join(nativeRoot, ".local/share/packages/tool-copy.txt"),
      );
      expected.set(".local/share/packages/tool-copy.txt", "package");
      fs.symlinkSync("unknown.txt", path.join(nativeRoot, "unknown-link"));
      fs.symlinkSync("/usr/bin/python3", path.join(nativeRoot, "python-link"));

      const backup = sandboxState.backupSandboxState("alpha");
      expect(backup.success, backup.error).toBe(true);
      expect(backup.manifest).not.toHaveProperty("stateDirs");
      expect(backup.manifest).not.toHaveProperty("stateFiles");
      expect(backup.manifest).not.toHaveProperty("dir");
      expect(backup.manifest?.nativeState).toMatchObject({
        root: "/sandbox",
        archive: "native-home.tar",
      });
      const archivedPaths = spawnSync("tar", [
        "-tf",
        path.join(backup.manifest!.backupPath, "native-home.tar"),
      ]);
      expect(archivedPaths.status).toBe(0);
      expect(archivedPaths.stdout.toString()).not.toContain(".openshell");
      expect(archivedPaths.stdout.toString()).not.toContain("credential");
      expect(archivedPaths.stdout.toString()).not.toContain(managedConfigPath);
      expect(archivedPaths.stdout.toString()).not.toContain(warmupSessionPath);
      expect(archivedPaths.stdout.toString()).not.toContain(warmupTrajectoryPath);

      fs.writeFileSync(path.join(nativeRoot, "unknown.txt"), "changed");
      fs.rmSync(path.join(nativeRoot, ".openclaw"), { recursive: true, force: true });
      fs.writeFileSync(path.join(nativeRoot, "stale.txt"), "remove-me");

      let archiveMutatedAfterValidation = false;
      const restore = await sandboxState.restoreSandboxState("alpha", backup.manifest!.backupPath, {
        validateBeforeMutation: () => {
          fs.writeFileSync(
            path.join(backup.manifest!.backupPath, "native-home.tar"),
            "changed after validation",
          );
          archiveMutatedAfterValidation = true;
        },
      });
      expect(archiveMutatedAfterValidation).toBe(true);
      expect(restore).toEqual({
        success: true,
        restoredDirs: ["."],
        failedDirs: [],
        restoredFiles: [],
        failedFiles: [],
      });
      for (const [relativePath, contents] of expected) {
        expect(fs.readFileSync(path.join(nativeRoot, relativePath), "utf8")).toBe(contents);
      }
      expect(fs.readlinkSync(path.join(nativeRoot, "unknown-link"))).toBe("unknown.txt");
      expect(fs.readlinkSync(path.join(nativeRoot, "python-link"))).toBe("/usr/bin/python3");
      expect(fs.existsSync(path.join(nativeRoot, "stale.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(openshellPrivate, "credential"), "utf8")).toBe(
        "host-only-secret",
      );
    } finally {
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      restoreEnv("NEMOCLAW_TEST_NATIVE_ROOT", oldNativeRoot);
      restoreEnv("PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects the OpenShell credential root before archive creation", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-credential-root-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldNativeRoot = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
    const oldNativeHome = process.env.NEMOCLAW_TEST_NATIVE_HOME;
    const oldNativeWorkspace = process.env.NEMOCLAW_TEST_NATIVE_WORKSPACE;
    try {
      const binDir = path.join(fixture, "bin");
      const credentialRoot = path.join(fixture, ".openshell");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(credentialRoot, { recursive: true });
      fs.writeFileSync(path.join(credentialRoot, "credential"), "host-only-secret");
      writeFakeOpenshell(binDir);
      writeFakeSsh(binDir);
      process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
      process.env.NEMOCLAW_TEST_NATIVE_ROOT = credentialRoot;
      process.env.NEMOCLAW_TEST_NATIVE_HOME = "/.openshell";
      process.env.NEMOCLAW_TEST_NATIVE_WORKSPACE = "/.openshell/workspace";
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      writeSandboxRegistry("alpha");

      const backup = sandboxState.backupSandboxState("alpha");

      expect(backup.success).toBe(false);
      expect(backup.error).toContain("outside '/.openshell'");
      expect(fs.readFileSync(path.join(credentialRoot, "credential"), "utf8")).toBe(
        "host-only-secret",
      );
      const sandboxBackups = path.join(BACKUPS_ROOT, "alpha");
      expect(fs.existsSync(sandboxBackups) ? fs.readdirSync(sandboxBackups) : []).toEqual([]);
    } finally {
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      restoreEnv("NEMOCLAW_TEST_NATIVE_ROOT", oldNativeRoot);
      restoreEnv("NEMOCLAW_TEST_NATIVE_HOME", oldNativeHome);
      restoreEnv("NEMOCLAW_TEST_NATIVE_WORKSPACE", oldNativeWorkspace);
      restoreEnv("PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("removes an incomplete archive when capture exceeds available backup space", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-limit-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldNativeRoot = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
    const oldCaptureBytes = process.env.NEMOCLAW_TEST_CAPTURE_BYTES;
    try {
      const binDir = path.join(fixture, "bin");
      const nativeRoot = path.join(fixture, "native-home");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(nativeRoot, { recursive: true });
      writeFakeOpenshell(binDir);
      writeFakeSsh(binDir);
      process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
      process.env.NEMOCLAW_TEST_NATIVE_ROOT = nativeRoot;
      process.env.NEMOCLAW_TEST_CAPTURE_BYTES = "4096";
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      writeSandboxRegistry("alpha");
      const backup = sandboxState.backupSandboxState("alpha", {
        nativeStateCaptureMaxBytes: 1024,
      });
      expect(backup.success).toBe(false);
      expect(backup.error).toContain("exceeded the 1024-byte backup-space limit");
      const sandboxBackups = path.join(BACKUPS_ROOT, "alpha");
      expect(fs.existsSync(sandboxBackups) ? fs.readdirSync(sandboxBackups) : []).toEqual([]);
    } finally {
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      restoreEnv("NEMOCLAW_TEST_NATIVE_ROOT", oldNativeRoot);
      restoreEnv("NEMOCLAW_TEST_CAPTURE_BYTES", oldCaptureBytes);
      restoreEnv("PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("reserves capacity for every concurrent stopped-state copy", () => {
    expect(sandboxState.nativeStateCaptureMaxBytes(TMP_HOME, 1024, 2)).toBe(512);
    expect(() => sandboxState.nativeStateCaptureMaxBytes(TMP_HOME, 1024, 0)).toThrow(
      "concurrent-copy count must be a positive integer",
    );
  });
  it.each([
    ["a short assignment in an ordinary note", "workspace/notes.txt", "password=abc"],
    [
      "an assignment-like compiler option",
      "workspace/project/tsconfig.json",
      JSON.stringify({ compilerOptions: { sessionToken: "opaqueCredentialPayloadZ1234567890" } }),
    ],
    [
      "OpenClaw session metadata",
      ".openclaw/agents/main/sessions/sessions.json",
      '{"sessions":{"main":{"sessionToken":"opaqueSessionIdentifierZ1234567890"}}}',
    ],
    ["dependency source map", "node_modules/example.mjs.map", '{"version":3,"sources":[]}'],
    [
      "dependency metadata",
      "node_modules/jsonwebtoken/package.json",
      '{"description":"JSON Web Token implementation","repository":"https://jimmywarting@github.com/example/repo.git"}',
    ],
    ["Hermes lazy docs", BOTO3_DOC, PUBLIC_AWS_EXAMPLE_KEY],
    [
      "Hermes lazy dependency data",
      ".hermes/lazy-packages/botocore/data/sts/2011-06-15/examples-1.json",
      JSON.stringify({ requestId: "example-request" }),
    ],
    ["OpenClaw database", OPENCLAW_SQLITE_WAL, "SQLite format 3\0binary state"],
  ])(
    "preserves %s without treating it as credential configuration",
    (_case, relativePath, content) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-noncredential-"));
      try {
        const nativeRoot = path.join(fixture, "native-home");
        fs.mkdirSync(path.dirname(path.join(nativeRoot, relativePath)), { recursive: true });
        fs.writeFileSync(path.join(nativeRoot, relativePath), content);
        writeSandboxRegistry("alpha");
        const backup = sandboxState.backupSandboxState("alpha", {
          nativeStateSource: {
            root: "/sandbox",
            directory: nativeRoot,
            assertCurrent: vi.fn(),
          },
        });
        expect(backup.success, backup.error).toBe(true);
        sandboxState.inspectNativeSandboxState(
          backup.manifest!.backupPath,
          (root: string) => {
            if (fs.readFileSync(path.join(root, relativePath), "utf8") !== content) {
              throw new Error("ordinary native state was not preserved exactly");
            }
          },
          relativePath,
        );
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
  it.each([
    ["an arbitrary native file", "notes.txt", `ghp_${"0123456789abcdef"}`],
    ["a credential after a binary SQLite header", OPENCLAW_SQLITE_WAL, SQLITE_CREDENTIAL_BYTES],
    [
      "an opaque bearer credential in a history file",
      ".openclaw/agents/child/history.log",
      "request failed: Authorization: Bearer opaqueCredentialPayloadZ1234567890",
    ],
    [
      "an opaque credential assignment in a session file",
      ".openclaw/agents/child/session.log",
      "sessionToken=opaqueCredentialPayloadZ1234567890",
    ],
    [
      "a malformed Slack placeholder-shaped credential",
      "workspace/slack.txt",
      "botToken=xoxb-OPENSHELL-RESOLVE-ENV-SLACK-BOT-TOKEN",
    ],
    [
      "an opaque npm registry credential",
      ".npmrc",
      "//registry.example/:_authToken=opaqueCredentialPayloadZ1234567890",
    ],
    [
      "an opaque credential in a JSON schema",
      "schemas/config.schema.json",
      JSON.stringify({ default: { authorization: "Bearer opaqueCredentialPayloadZ1234567890" } }),
    ],
    ["a schema directory file", "schemas/token.txt", `ghp_${"02468ace13579bdf"}`],
    [
      "a concrete token in the Pi managed model registry",
      ".pi/agent/models.json",
      JSON.stringify({ apiKey: `ghp_${"97531bdf2468ace0"}` }),
    ],
    [
      "an agent-owned package manifest",
      "workspace/project/package.json",
      JSON.stringify({ apiKey: `ghp_${"2468ace013579bdf"}` }),
    ],
    ["an arbitrary dependency file", "node_modules/example/token.txt", `ghp_${"fedcba9876543210"}`],
    ["dependency source code", "node_modules/example/token.js", `ghp_${"fedcba9876543210"}`],
    [
      "a concrete token in bundled NemoClaw runtime code",
      ".openclaw/extensions/nemoclaw/dist/injected.js",
      `export const token = "ghp_${"abcdef1357902468"}";`,
    ],
    [
      "a dependency package manifest",
      "node_modules/example/package.json",
      JSON.stringify({ config: { apiKey: `ghp_${"0123fedcba987654"}` } }),
    ],
    [
      "a Python virtual-environment file",
      ".venv/lib/python3.13/site-packages/example/token.txt",
      `ghp_${"13579bdf2468ace0"}`,
    ],
    [
      "a dependency lockfile",
      "node_modules/example/yarn.lock",
      `# yarn lockfile v1\n\nexample@1.0.0:\n  version "1.0.0"\n  resolved "https://build-user:ghp_${"abcdef0123456789"}@registry.example.test/example.tgz"\n`,
    ],
    [
      "an OpenClaw config credential outside machine-local gateway authority",
      ".openclaw/openclaw.json",
      JSON.stringify({
        gateway: { auth: { token: "gateway-token" } },
        models: {
          providers: { private: { apiKey: `ghp_${"abcdef0123456789"}` } },
        },
      }),
    ],
  ])("removes a native archive containing a credential in %s", (_case, relativePath, content) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-credential-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldNativeRoot = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
    try {
      const binDir = path.join(fixture, "bin");
      const nativeRoot = path.join(fixture, "native-home");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(nativeRoot, { recursive: true });
      fs.mkdirSync(path.dirname(path.join(nativeRoot, relativePath)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(nativeRoot, relativePath), content);
      writeFakeOpenshell(binDir);
      writeFakeSsh(binDir);
      process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
      process.env.NEMOCLAW_TEST_NATIVE_ROOT = nativeRoot;
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      writeSandboxRegistry("alpha");
      const backup = sandboxState.backupSandboxState("alpha");
      expect(backup.success).toBe(false);
      expect(backup.error).toContain("credential-bearing or uninspectable content");
      expect(backup.error).toContain(`./${relativePath}`);
      const sandboxBackups = path.join(BACKUPS_ROOT, "alpha");
      expect(fs.existsSync(sandboxBackups) ? fs.readdirSync(sandboxBackups) : []).toEqual([]);
    } finally {
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      restoreEnv("NEMOCLAW_TEST_NATIVE_ROOT", oldNativeRoot);
      restoreEnv("PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
  it("removes an incomplete archive when manifest publication fails", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-manifest-failure-"));
    try {
      const nativeRoot = path.join(fixture, "native-home");
      fs.mkdirSync(nativeRoot, { recursive: true });
      fs.writeFileSync(path.join(nativeRoot, "payload.txt"), "payload");
      writeSandboxRegistry("alpha");
      const backup = sandboxState.backupSandboxState("alpha", {
        nativeStateSource: {
          root: "/sandbox",
          directory: nativeRoot,
          assertCurrent: () => undefined,
        },
        validateBeforePublish: () => {
          const sandboxBackups = path.join(BACKUPS_ROOT, "alpha");
          const [timestamp] = fs.readdirSync(sandboxBackups);
          fs.mkdirSync(path.join(sandboxBackups, timestamp!, "rebuild-manifest.json"));
        },
      });
      expect(backup.success).toBe(false);
      expect(backup.error).toContain("Could not publish the native home/workspace backup manifest");
      const sandboxBackups = path.join(BACKUPS_ROOT, "alpha");
      expect(fs.existsSync(sandboxBackups) ? fs.readdirSync(sandboxBackups) : []).toEqual([]);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
  it("restores an escaping symlink without following it outside the target root", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-link-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldNativeRoot = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
    const oldCommandLog = process.env.NEMOCLAW_TEST_SSH_COMMAND_LOG;
    try {
      const binDir = path.join(fixture, "bin");
      const nativeRoot = path.join(fixture, "native-home");
      const commandLog = path.join(fixture, "ssh-commands.log");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(nativeRoot, { recursive: true });
      fs.writeFileSync(path.join(nativeRoot, "original.txt"), "payload");
      fs.symlinkSync("../../outside", path.join(nativeRoot, "unsafe-link"));
      writeFakeOpenshell(binDir);
      writeFakeSsh(binDir);
      process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
      process.env.NEMOCLAW_TEST_NATIVE_ROOT = nativeRoot;
      process.env.NEMOCLAW_TEST_SSH_COMMAND_LOG = commandLog;
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      writeSandboxRegistry("alpha");
      const backup = sandboxState.backupSandboxState("alpha");
      expect(backup.success, backup.error).toBe(true);
      for (const entry of fs.readdirSync(nativeRoot)) {
        fs.rmSync(path.join(nativeRoot, entry), {
          recursive: true,
          force: true,
        });
      }
      const restore = await sandboxState.restoreSandboxState("alpha", backup.manifest!.backupPath);
      expect(restore.success, restore.error).toBe(true);
      expect(fs.readFileSync(path.join(nativeRoot, "original.txt"), "utf8")).toBe("payload");
      expect(fs.readlinkSync(path.join(nativeRoot, "unsafe-link"))).toBe("../../outside");
      const commands = fs.readFileSync(commandLog, "utf8");
      expect(commands).toContain('kill -STOP "$pid"');
      expect(commands).toContain("quiesce_pass=$((quiesce_pass + 1))");
      expect(commands).toContain("trap resume EXIT HUP INT TERM");
      expect(commands).toContain('2>/dev/null < "$proc/status"');
      expect(commands).toContain('2>/dev/null < "/proc/$pid/status"');
      expect(commands).not.toContain('< "$proc/status" 2>/dev/null');
      expect(commands).toContain("-links +1");
      expect(commands).toContain('mktemp -d "$root/.nemoclaw-native-restore.XXXXXX"');
      expect(commands).toContain('owner="$(stat -c %u -- "$target_item")"');
      expect(commands).toContain('[ "$owner" = "$uid" ] && [ -w "$target_dir" ]');
      expect(commands).toContain('restore_dir "$source_item" "$target_item"');
      expect(commands.indexOf('if [ -d "$target_item" ]')).toBeLessThan(
        commands.indexOf('elif [ "$owner" = "$uid" ]'),
      );
      expect(commands).toContain('mv -- "$source_item" "$target_dir"/');
      expect(commands).not.toContain("native restore symlink escapes root");
    } finally {
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      restoreEnv("NEMOCLAW_TEST_NATIVE_ROOT", oldNativeRoot);
      restoreEnv("NEMOCLAW_TEST_SSH_COMMAND_LOG", oldCommandLog);
      restoreEnv("PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each(["directory-child", "regular-file", "identical-file", "replacement-only"] as const)(
    "handles archived state at an image-owned %s without data loss",
    async (collisionKind) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-image-owned-"));
      const oldPath = process.env.PATH;
      const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
      const oldNativeRoot = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
      const oldNativeHome = process.env.NEMOCLAW_TEST_NATIVE_HOME;
      const oldNativeWorkspace = process.env.NEMOCLAW_TEST_NATIVE_WORKSPACE;
      const oldExecuteRestore = process.env.NEMOCLAW_TEST_EXECUTE_RESTORE_SCRIPT;
      try {
        const binDir = path.join(fixture, "bin");
        const nativeRoot = path.join(fixture, "native-home");
        const imageOwned = path.join(nativeRoot, "image-owned");
        const receipt = path.join(nativeRoot, ".hermes/runtime/gateway.pid");
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(nativeRoot, { recursive: true });
        if (collisionKind === "directory-child") {
          fs.mkdirSync(imageOwned);
          fs.writeFileSync(path.join(imageOwned, "archived-child.txt"), "must not be dropped");
        } else if (collisionKind !== "replacement-only") {
          fs.writeFileSync(imageOwned, "archived file must not be dropped");
        }
        writeFakeOpenshell(binDir);
        writeFakeSsh(binDir);
        writeExecutable(
          path.join(binDir, "stat"),
          `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const target = process.argv.at(-1);
if (process.argv[2] !== "-c" || process.argv[3] !== "%u" || !target) process.exit(95);
const uid = path.basename(target) === "image-owned" && (!fs.lstatSync(target).isFile() || fs.readFileSync(target, "utf8") !== "must be removed") ? (process.getuid?.() ?? 1000) + 1 : fs.lstatSync(target).uid;
process.stdout.write(String(uid) + "\\n");
`,
        );
        process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
        process.env.NEMOCLAW_TEST_NATIVE_ROOT = nativeRoot;
        process.env.NEMOCLAW_TEST_NATIVE_HOME = nativeRoot;
        process.env.NEMOCLAW_TEST_NATIVE_WORKSPACE = nativeRoot;
        process.env.NEMOCLAW_TEST_EXECUTE_RESTORE_SCRIPT = "1";
        process.env.PATH = `${binDir}:${oldPath ?? ""}`;
        writeSandboxRegistry("alpha");
        const backup = sandboxState.backupSandboxState("alpha");
        expect(backup.success, backup.error).toBe(true);
        const backupPath = backup.manifest!.backupPath;
        if (collisionKind === "replacement-only") {
          fs.writeFileSync(imageOwned, "must be removed");
          fs.mkdirSync(path.dirname(receipt), { recursive: true });
          fs.writeFileSync(receipt, "replacement-pid");
        } else if (collisionKind === "directory-child") {
          fs.rmSync(imageOwned, { recursive: true, force: true });
          fs.mkdirSync(imageOwned, { mode: 0o555 });
        } else if (collisionKind === "regular-file") {
          fs.rmSync(imageOwned, { recursive: true, force: true });
          fs.writeFileSync(imageOwned, "replacement image authority");
        }
        const restore = await sandboxState.restoreSandboxState("alpha", backupPath);

        if (collisionKind === "replacement-only") {
          expect(restore.success, restore.error).toBe(true);
          expect(fs.existsSync(imageOwned)).toBe(false);
          expect(fs.readFileSync(receipt, "utf8")).toBe("replacement-pid");
        } else if (collisionKind === "identical-file") {
          expect(restore.success, restore.error).toBe(true);
          expect(fs.readFileSync(imageOwned, "utf8")).toBe("archived file must not be dropped");
        } else {
          expect(restore.success).toBe(false);
          expect(restore.error).toContain("native restore could not preserve archived state");
          if (collisionKind === "directory-child") {
            expect(fs.existsSync(path.join(imageOwned, "archived-child.txt"))).toBe(false);
          } else {
            expect(fs.readFileSync(imageOwned, "utf8")).toBe("replacement image authority");
          }
        }
      } finally {
        restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
        restoreEnv("NEMOCLAW_TEST_NATIVE_ROOT", oldNativeRoot);
        restoreEnv("NEMOCLAW_TEST_NATIVE_HOME", oldNativeHome);
        restoreEnv("NEMOCLAW_TEST_NATIVE_WORKSPACE", oldNativeWorkspace);
        restoreEnv("NEMOCLAW_TEST_EXECUTE_RESTORE_SCRIPT", oldExecuteRestore);
        restoreEnv("PATH", oldPath);
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it.each(["old-gnu", "pax", "global-pax"] as const)(
    "rejects a %s sparse archive before inspection or publication",
    (kind) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-sparse-"));
      const oldPath = process.env.PATH;
      const oldCraftedArchive = process.env.NEMOCLAW_TEST_CRAFTED_ARCHIVE;
      const oldTarLog = process.env.NEMOCLAW_TEST_TAR_LOG;
      try {
        const binDir = path.join(fixture, "bin");
        const nativeRoot = path.join(fixture, "native-home");
        const craftedArchive = path.join(fixture, "crafted.tar");
        const tarLog = path.join(fixture, "tar.log");
        const systemTar = spawnSync("sh", ["-c", "command -v tar"], {
          encoding: "utf8",
        }).stdout.trim();
        expect(systemTar).not.toBe("");
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(nativeRoot, { recursive: true });
        fs.writeFileSync(craftedArchive, buildSparseTar(kind));
        writeExecutable(
          path.join(binDir, "tar"),
          `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NEMOCLAW_TEST_TAR_LOG, JSON.stringify(args) + "\\n");
if (args.includes("-C")) {
  process.stdout.write(fs.readFileSync(process.env.NEMOCLAW_TEST_CRAFTED_ARCHIVE));
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(systemTar)}, args, { stdio: "inherit" });
process.exit(result.status ?? 90);
`,
        );
        process.env.NEMOCLAW_TEST_CRAFTED_ARCHIVE = craftedArchive;
        process.env.NEMOCLAW_TEST_TAR_LOG = tarLog;
        process.env.PATH = `${binDir}:${oldPath ?? ""}`;
        writeSandboxRegistry("alpha");

        const backup = sandboxState.backupSandboxState("alpha", {
          nativeStateSource: {
            root: "/sandbox",
            directory: nativeRoot,
            assertCurrent: () => undefined,
          },
        });

        expect(backup.success).toBe(false);
        expect(backup.error).toContain("native state sparse archive entry");
        const sandboxBackups = path.join(BACKUPS_ROOT, "alpha");
        expect(fs.existsSync(sandboxBackups) ? fs.readdirSync(sandboxBackups) : []).toEqual([]);
      } finally {
        restoreEnv("NEMOCLAW_TEST_CRAFTED_ARCHIVE", oldCraftedArchive);
        restoreEnv("NEMOCLAW_TEST_TAR_LOG", oldTarLog);
        restoreEnv("PATH", oldPath);
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it("rejects symlink write-through before credential-scan extraction", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-scan-traversal-"));
    const oldPath = process.env.PATH;
    const oldCraftedArchive = process.env.NEMOCLAW_TEST_CRAFTED_ARCHIVE;
    const oldTarLog = process.env.NEMOCLAW_TEST_TAR_LOG;
    try {
      const binDir = path.join(fixture, "bin");
      const nativeRoot = path.join(fixture, "native-home");
      const craftedArchive = path.join(fixture, "crafted.tar");
      const tarLog = path.join(fixture, "tar.log");
      const systemTar = spawnSync("sh", ["-c", "command -v tar"], {
        encoding: "utf8",
      }).stdout.trim();
      expect(systemTar).not.toBe("");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(nativeRoot, { recursive: true });
      fs.writeFileSync(path.join(nativeRoot, "original.txt"), "payload");
      fs.writeFileSync(craftedArchive, buildSymlinkCredentialTraversalTar());
      writeExecutable(
        path.join(binDir, "tar"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NEMOCLAW_TEST_TAR_LOG, JSON.stringify(args) + "\\n");
if (args.includes("-C")) {
  process.stdout.write(fs.readFileSync(process.env.NEMOCLAW_TEST_CRAFTED_ARCHIVE));
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(systemTar)}, args, { stdio: "inherit" });
process.exit(result.status ?? 90);
`,
      );
      process.env.NEMOCLAW_TEST_CRAFTED_ARCHIVE = craftedArchive;
      process.env.NEMOCLAW_TEST_TAR_LOG = tarLog;
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      writeSandboxRegistry("alpha");

      const backup = sandboxState.backupSandboxState("alpha", {
        nativeStateSource: {
          root: "/sandbox",
          directory: nativeRoot,
          assertCurrent: () => undefined,
        },
      });

      expect(backup.success).toBe(false);
      expect(backup.error).toContain(
        "archive member 'redirect/config.json' would extract through symlink 'redirect'",
      );
      expect(fs.readFileSync(tarLog, "utf8")).not.toContain("--no-recursion");
    } finally {
      restoreEnv("NEMOCLAW_TEST_CRAFTED_ARCHIVE", oldCraftedArchive);
      restoreEnv("NEMOCLAW_TEST_TAR_LOG", oldTarLog);
      restoreEnv("PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects a symlink write-through archive before SSH extraction", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-link-traversal-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldNativeRoot = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
    const oldCommandLog = process.env.NEMOCLAW_TEST_SSH_COMMAND_LOG;
    try {
      const binDir = path.join(fixture, "bin");
      const nativeRoot = path.join(fixture, "native-home");
      const commandLog = path.join(fixture, "ssh-commands.log");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(nativeRoot, { recursive: true });
      fs.writeFileSync(path.join(nativeRoot, "original.txt"), "payload");
      writeFakeOpenshell(binDir);
      writeFakeSsh(binDir);
      process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
      process.env.NEMOCLAW_TEST_NATIVE_ROOT = nativeRoot;
      process.env.NEMOCLAW_TEST_SSH_COMMAND_LOG = commandLog;
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      writeSandboxRegistry("alpha");

      const backup = sandboxState.backupSandboxState("alpha", {
        nativeStateSource: {
          root: "/sandbox",
          directory: nativeRoot,
          assertCurrent: () => undefined,
        },
      });
      expect(backup.success, backup.error).toBe(true);
      const archivePath = path.join(backup.manifest!.backupPath, "native-home.tar");
      const archive = buildSymlinkTraversalTar();
      fs.writeFileSync(archivePath, archive);
      const manifestPath = path.join(backup.manifest!.backupPath, "rebuild-manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        nativeState: { sha256: string };
      };
      manifest.nativeState.sha256 = createHash("sha256").update(archive).digest("hex");
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const restore = await sandboxState.restoreSandboxState("alpha", backup.manifest!.backupPath);

      expect(restore.success).toBe(false);
      expect(restore.error).toContain(
        "archive member 'redirect/payload.txt' would extract through symlink 'redirect'",
      );
      expect(fs.existsSync(commandLog)).toBe(false);
      expect(fs.readFileSync(path.join(nativeRoot, "original.txt"), "utf8")).toBe("payload");
    } finally {
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      restoreEnv("NEMOCLAW_TEST_NATIVE_ROOT", oldNativeRoot);
      restoreEnv("NEMOCLAW_TEST_SSH_COMMAND_LOG", oldCommandLog);
      restoreEnv("PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
