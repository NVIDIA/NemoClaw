// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  writeExecutable,
  writeFakeOpenshell,
  writeFakeSsh,
  writeSnapshotRegistry,
} from "../support/native-snapshot.ts";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-backslash-"));
process.env.HOME = TMP_HOME;
const sandboxState = await import(
  pathToFileURL(path.join(import.meta.dirname, "../..", "src", "lib", "state", "sandbox.ts")).href
);

function restoreEnv(name: string, value: string | undefined): void {
  value === undefined
    ? Reflect.deleteProperty(process.env, name)
    : Reflect.set(process.env, name, value);
}

function resolveBsdTar(): string | null {
  const candidates = [
    spawnSync("sh", ["-c", "command -v bsdtar"], { encoding: "utf8" }).stdout.trim(),
    "/usr/bin/bsdtar",
    "/usr/bin/tar",
  ].filter(Boolean);
  return (
    [...new Set(candidates)].find((candidate) => {
      const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
      return probe.status === 0 && /bsdtar/iu.test(`${probe.stdout ?? ""}${probe.stderr ?? ""}`);
    }) ?? null
  );
}

const BSD_TAR = resolveBsdTar();

afterAll(() => {
  restoreEnv("HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(TMP_HOME, ".nemoclaw", "rebuild-backups"), {
    recursive: true,
    force: true,
  });
});

function createBackslashEnvFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-backslash-env-"));
  const nativeRoot = path.join(fixture, "native-home");
  const relativePath = "workspace/05-\u{1F6E0}\u{FE0F}\\ Systems\\ \\&\\ Templates/.env";
  const content = "CUSTOM_MODE=enabled\n";
  fs.mkdirSync(path.dirname(path.join(nativeRoot, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(nativeRoot, relativePath), content);
  writeSnapshotRegistry(TMP_HOME, "alpha");
  const backup = sandboxState.backupSandboxState("alpha", {
    nativeStateSource: {
      root: "/sandbox",
      directory: nativeRoot,
      assertCurrent: () => undefined,
    },
  });
  return { fixture, relativePath, content, backup };
}

async function assertBackslashFallbackRoundTrip(
  installTar: (binDir: string, tarLog: string) => void,
  verifyTarLog: (tarLog: string) => void,
) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-bsdtar-fallback-"));
  const oldPath = process.env.PATH;
  const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
  const oldNativeRoot = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
  try {
    const binDir = path.join(fixture, "bin");
    const nativeRoot = path.join(fixture, "native-home");
    const tarLog = path.join(fixture, "tar-args.log");
    const relativeDir = "workspace/05-\u{1F6E0}\u{FE0F}\\ Systems\\ \\&\\ Templates";
    const relativeFile = `${relativeDir}/notes.md`;
    const relativeEnv = `${relativeDir}/.env`;
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.dirname(path.join(nativeRoot, relativeFile)), { recursive: true });
    fs.writeFileSync(path.join(nativeRoot, relativeFile), "fallback-backslash-notes");
    fs.writeFileSync(path.join(nativeRoot, relativeEnv), "CUSTOM_MODE=enabled\n");
    writeFakeOpenshell(binDir);
    writeFakeSsh(binDir);
    installTar(binDir, tarLog);
    process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
    process.env.NEMOCLAW_TEST_NATIVE_ROOT = nativeRoot;
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    writeSnapshotRegistry(TMP_HOME, "alpha");

    const backup = sandboxState.backupSandboxState("alpha");
    expect(backup.success, backup.error).toBe(true);
    verifyTarLog(tarLog);
    const fallbackValidation = sandboxState.validateTarEntries(
      { filePath: path.join(backup.manifest!.backupPath, "native-home.tar") },
      "/sandbox",
    );
    expect(fallbackValidation.safe).toBe(true);
    expect(
      fallbackValidation.entries.some((entry: string) =>
        entry.includes("\\\\ Systems\\\\ \\\\&\\\\ Templates/notes.md"),
      ),
    ).toBe(true);
    sandboxState.inspectNativeSandboxState(
      backup.manifest!.backupPath,
      (root: string) => {
        expect(fs.readFileSync(path.join(root, relativeEnv), "utf8")).toBe("CUSTOM_MODE=enabled\n");
      },
      relativeEnv,
    );
    fs.writeFileSync(path.join(nativeRoot, relativeFile), "mutated");
    fs.writeFileSync(path.join(nativeRoot, relativeEnv), "CUSTOM_MODE=disabled\n");
    const restore = await sandboxState.restoreSandboxState("alpha", backup.manifest!.backupPath);
    expect(restore.success, restore.error).toBe(true);
    expect(fs.readFileSync(path.join(nativeRoot, relativeFile), "utf8")).toBe(
      "fallback-backslash-notes",
    );
    expect(fs.readFileSync(path.join(nativeRoot, relativeEnv), "utf8")).toBe(
      "CUSTOM_MODE=enabled\n",
    );

    fs.writeFileSync(
      path.join(nativeRoot, relativeEnv),
      `OPENAI_API_KEY=${["sk-proj", "fallbackSecret1234567890abcd"].join("-")}\n`,
    );
    const rejected = sandboxState.backupSandboxState("alpha");
    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain("credential-bearing or uninspectable content");
    expect(rejected.error).toContain(relativeEnv);
    expect(sandboxState.getLatestBackup("alpha")?.backupPath).toBe(backup.manifest!.backupPath);
  } finally {
    restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
    restoreEnv("NEMOCLAW_TEST_NATIVE_ROOT", oldNativeRoot);
    restoreEnv("PATH", oldPath);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

function assertFailedFallbackCleans(
  installFailure: (marker: string) => () => void,
  expectedError: string,
): void {
  const { fixture, relativePath, backup } = createBackslashEnvFixture();
  const binDir = path.join(fixture, "bin");
  const marker = path.join(fixture, "first-extraction-failed");
  const systemTar = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
  const oldPath = process.env.PATH;
  try {
    expect(backup.success, backup.error).toBe(true);
    fs.mkdirSync(binDir);
    writeExecutable(
      path.join(binDir, "tar"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const { spawnSync } = require("node:child_process");',
        "const args = process.argv.slice(2);",
        `if (args.includes("-T")) { fs.writeFileSync(${JSON.stringify(marker)}, "1"); process.exit(1); }`,
        `process.exit(spawnSync(${JSON.stringify(systemTar)}, args, { stdio: "inherit" }).status ?? 90);`,
      ].join("\n"),
    );
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    const restoreFailure = installFailure(marker);
    try {
      expect(() =>
        sandboxState.inspectNativeSandboxState(
          backup.manifest!.backupPath,
          () => undefined,
          relativePath,
        ),
      ).toThrow(expectedError);
    } finally {
      restoreFailure();
    }
    expect(
      fs
        .readdirSync(backup.manifest!.backupPath)
        .some((name) => name.startsWith(".native-inspect-")),
    ).toBe(false);
  } finally {
    restoreEnv("PATH", oldPath);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

function throwDiskFull(): never {
  throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
}

describe("native backup of backslash paths across tar quoting modes", () => {
  it("returns a backup failure when credential extraction exhausts its deadline", () => {
    const { fixture, relativePath } = createBackslashEnvFixture();
    const binDir = path.join(fixture, "bin");
    const marker = path.join(fixture, "credential-extraction-failed");
    const systemTar = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
    const oldPath = process.env.PATH;
    const now = Date.now();
    try {
      fs.rmSync(path.join(TMP_HOME, ".nemoclaw", "rebuild-backups"), {
        recursive: true,
        force: true,
      });
      fs.mkdirSync(binDir);
      writeExecutable(
        path.join(binDir, "tar"),
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          'const { spawnSync } = require("node:child_process");',
          "const args = process.argv.slice(2);",
          `if (args.includes("-xf") && args.includes("-T") && !fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, "1"); process.exit(1); }`,
          `process.exit(spawnSync(${JSON.stringify(systemTar)}, args, { stdio: "inherit" }).status ?? 90);`,
        ].join("\n"),
      );
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      const clock = vi
        .spyOn(Date, "now")
        .mockImplementation(() =>
          fs.existsSync(marker) ? now + sandboxState.NATIVE_STATE_CAPTURE_TIMEOUT_MS + 1 : now,
        );
      try {
        const backup = sandboxState.backupSandboxState("alpha", {
          nativeStateSource: {
            root: "/sandbox",
            directory: path.join(fixture, "native-home"),
            assertCurrent: () => undefined,
          },
        });
        expect(backup.success).toBe(false);
        expect(backup.error).toContain(relativePath);
        expect(backup.error).toContain("credential scan exceeded the backup deadline");
      } finally {
        clock.mockRestore();
      }
      expect(fs.existsSync(marker)).toBe(true);
      expect(sandboxState.getLatestBackup("alpha")).toBeNull();
      expect(fs.existsSync(path.join(fixture, "native-home", relativePath))).toBe(true);
    } finally {
      restoreEnv("PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("classifies a deadline reached after a successful fallback command as a backup timeout", () => {
    const { fixture, relativePath } = createBackslashEnvFixture();
    const binDir = path.join(fixture, "bin");
    const firstPass = path.join(fixture, "first-extraction-failed");
    const fallbackComplete = path.join(fixture, "fallback-complete");
    const systemTar = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
    const oldPath = process.env.PATH;
    const now = Date.now();
    try {
      fs.rmSync(path.join(TMP_HOME, ".nemoclaw", "rebuild-backups"), {
        recursive: true,
        force: true,
      });
      fs.mkdirSync(binDir);
      writeExecutable(
        path.join(binDir, "tar"),
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          'const { spawnSync } = require("node:child_process");',
          "const args = process.argv.slice(2);",
          `if (args.includes("-xf") && args.includes("-T") && !fs.existsSync(${JSON.stringify(firstPass)})) { fs.writeFileSync(${JSON.stringify(firstPass)}, "1"); process.exit(1); }`,
          `if (args.includes("-xf") && args.includes("-T")) { fs.writeFileSync(${JSON.stringify(fallbackComplete)}, "1"); process.exit(0); }`,
          `process.exit(spawnSync(${JSON.stringify(systemTar)}, args, { stdio: "inherit" }).status ?? 90);`,
        ].join("\n"),
      );
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      const clock = vi
        .spyOn(Date, "now")
        .mockImplementation(() =>
          fs.existsSync(fallbackComplete)
            ? now + sandboxState.NATIVE_STATE_CAPTURE_TIMEOUT_MS + 1
            : now,
        );
      try {
        const backup = sandboxState.backupSandboxState("alpha", {
          nativeStateSource: {
            root: "/sandbox",
            directory: path.join(fixture, "native-home"),
            assertCurrent: () => undefined,
          },
        });
        expect(backup.success).toBe(false);
        expect(backup.error).toContain(relativePath);
        expect(backup.error).toContain("credential scan exceeded the backup deadline");
      } finally {
        clock.mockRestore();
      }
      expect(fs.existsSync(firstPass)).toBe(true);
      expect(fs.existsSync(fallbackComplete)).toBe(true);
      expect(sandboxState.getLatestBackup("alpha")).toBeNull();
    } finally {
      restoreEnv("PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("stops a backslash fallback copy at the extraction deadline and removes staging", () => {
    const now = Date.now();
    assertFailedFallbackCleans((marker) => {
      const clock = vi
        .spyOn(Date, "now")
        .mockImplementation(() =>
          fs.existsSync(marker) ? now + sandboxState.NATIVE_STATE_CAPTURE_TIMEOUT_MS + 1 : now,
        );
      return () => clock.mockRestore();
    }, "Native archive fallback staging exceeded the extraction deadline");
  });

  it("removes a partial backslash fallback copy when local disk fills", () => {
    assertFailedFallbackCleans((marker) => {
      const originalWrite = fs.writeSync;
      const originalRemove = fs.rmSync;
      const removed: string[] = [];
      const write = vi
        .spyOn(fs, "writeSync")
        .mockImplementation((...args) =>
          fs.existsSync(marker) && Buffer.isBuffer(args[1]) && args[1].byteLength >= 512
            ? throwDiskFull()
            : (Reflect.apply(originalWrite, fs, args) as number),
        );
      const remove = vi.spyOn(fs, "rmSync").mockImplementation((...args) => {
        removed.push(String(args[0]));
        Reflect.apply(originalRemove, fs, args);
      });
      syncBuiltinESMExports();
      return () => {
        write.mockRestore();
        remove.mockRestore();
        syncBuiltinESMExports();
        expect(removed.some((target) => target.endsWith("/archive-retry.tar"))).toBe(true);
      };
    }, "Native archive fallback staging has insufficient local disk space");
  });

  it("preserves an .env under a backslash directory across host tar implementations", () => {
    const { fixture, relativePath, content, backup } = createBackslashEnvFixture();
    try {
      expect(backup.success, backup.error).toBe(true);
      sandboxState.inspectNativeSandboxState(
        backup.manifest!.backupPath,
        (root: string) => {
          expect(fs.readFileSync(path.join(root, relativePath), "utf8")).toBe(content);
        },
        relativePath,
      );
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("round-trips backslash paths and rejects credential-bearing backslash paths after tar rejects --quoting-style=literal", async () => {
    const systemTar = spawnSync("sh", ["-c", "command -v tar"], {
      encoding: "utf8",
    }).stdout.trim();
    expect(systemTar).not.toBe("");
    const systemTarVersion = `${
      spawnSync(systemTar, ["--version"], { encoding: "utf8" }).stdout ?? ""
    }`;
    await assertBackslashFallbackRoundTrip(
      (binDir, tarLog) => {
        writeExecutable(
          path.join(binDir, "tar"),
          [
            "#!/usr/bin/env node",
            'const fs = require("node:fs");',
            'const { spawnSync } = require("node:child_process");',
            "const args = process.argv.slice(2);",
            `fs.appendFileSync(${JSON.stringify(tarLog)}, JSON.stringify(args) + "\\n");`,
            'if (args.includes("--quoting-style=literal") || args.includes("--hard-dereference")) { process.stderr.write("tar: Option --quoting-style=literal is not supported\\n"); process.exit(1); }',
            'const filesFromIndex = args.indexOf("-T");',
            "if (filesFromIndex >= 0 && args[filesFromIndex + 1]) {",
            "  const listFile = args[filesFromIndex + 1];",
            '  const patterns = fs.readFileSync(listFile, "utf8").split("\\0").filter(Boolean);',
            "  if (patterns.some((pattern) => /(?<!\\\\)\\\\(?!\\\\)/u.test(pattern))) {",
            '    process.stderr.write("tar: Pattern with unescaped backslash not matched in archive\\n");',
            "    process.exit(1);",
            "  }",
            `  if (!/bsdtar/iu.test(${JSON.stringify(systemTarVersion)})) {`,
            '    fs.writeFileSync(listFile, Buffer.from(patterns.map((pattern) => pattern.replaceAll("\\\\\\\\", "\\\\")).join("\\0") + "\\0"));',
            "  }",
            "}",
            `process.exit(spawnSync(${JSON.stringify(systemTar)}, args, { stdio: "inherit" }).status ?? 90);`,
          ].join("\n"),
        );
      },
      (tarLog) => {
        const loggedInvocations = fs
          .readFileSync(tarLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]);
        expect(loggedInvocations).toContainEqual(["--quoting-style=literal", "-tf", "-"]);
        expect(loggedInvocations).toContainEqual(["-tf", "-"]);
        expect(
          loggedInvocations.filter((args) => args.includes("-T")).length,
        ).toBeGreaterThanOrEqual(2);
      },
    );
  });

  it.skipIf(!BSD_TAR)(
    "round-trips backslash paths and rejects credential-bearing backslash paths with native BSD tar",
    async () => {
      await assertBackslashFallbackRoundTrip(
        (binDir) => {
          fs.symlinkSync(BSD_TAR!, path.join(binDir, "tar"));
        },
        () => undefined,
      );
    },
  );

  it
    .skipIf(!BSD_TAR)
    .each([
      "literal\\*.env",
      "literal\\?.env",
      "literal\\[ab].env",
      "literal\\safe.env",
      "literal*\\safe.env",
    ])("selects only literal backslash glob name %s with native BSD tar", (requested) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-literal-globs-"));
    const oldPath = process.env.PATH;
    try {
      const nativeRoot = path.join(fixture, "native-home");
      const binDir = path.join(fixture, "bin");
      fs.mkdirSync(nativeRoot);
      fs.mkdirSync(binDir);
      fs.symlinkSync(BSD_TAR!, path.join(binDir, "tar"));
      fs.writeFileSync(path.join(nativeRoot, "literal\\*.env"), "SAFE=value\n");
      fs.writeFileSync(path.join(nativeRoot, "literal\\?.env"), "SAFE=value\n");
      fs.writeFileSync(path.join(nativeRoot, "literal\\[ab].env"), "SAFE=value\n");
      fs.writeFileSync(path.join(nativeRoot, "literal\\a.env"), "SAFE=value\n");
      fs.writeFileSync(path.join(nativeRoot, "literal\\other.env"), "SAFE=value\n");
      fs.writeFileSync(path.join(nativeRoot, "literal\\safe.env"), "SAFE=value\n");
      fs.writeFileSync(path.join(nativeRoot, "literalsafe.env"), "SIBLING=value\n");
      fs.writeFileSync(path.join(nativeRoot, "literal*\\safe.env"), "SAFE=value\n");
      fs.writeFileSync(path.join(nativeRoot, "literalothersafe.env"), "SIBLING=value\n");
      writeSnapshotRegistry(TMP_HOME, "literal-globs");
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      const backup = sandboxState.backupSandboxState("literal-globs", {
        nativeStateSource: {
          root: "/sandbox",
          directory: nativeRoot,
          assertCurrent: () => undefined,
        },
      });
      expect(backup.success, backup.error).toBe(true);
      sandboxState.inspectNativeSandboxState(
        backup.manifest!.backupPath,
        (root: string) => {
          expect(fs.readFileSync(path.join(root, requested), "utf8")).toBe("SAFE=value\n");
          expect(fs.readdirSync(root)).toEqual([requested]);
        },
        requested,
      );
    } finally {
      restoreEnv("PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
