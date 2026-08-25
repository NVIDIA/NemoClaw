// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIXED_TAR_INTEGRITY,
  FIXED_TAR_TARBALL,
  FIXED_TAR_VERSION,
  MINIMUM_SAFE_TAR_VERSION,
  patchBundledNpmTar,
  patchBundledNpmTarFromArchive,
  patchBundledNpmTarFromRegistry,
  verifyBundledNpmTar,
} from "../../scripts/patch-bundled-npm-tar.mts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-npm-tar-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeJson(file: string, value: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(npmVersion: "10.9.7" | "11.13.0" | "11.16.0" | "11.18.0", tarVersion: string) {
  const root = temporaryDirectory();
  const npmRoot = path.join(root, "npm");
  const replacementRoot = path.join(root, "replacement");
  writeJson(path.join(npmRoot, "package.json"), {
    name: "npm",
    version: npmVersion,
    dependencies: {
      tar:
        npmVersion === "11.18.0" ? "^7.5.19" : npmVersion.startsWith("10.") ? "^7.5.11" : "^7.5.13",
    },
    bundleDependencies: ["other", "tar"],
  });
  writeJson(path.join(npmRoot, "node_modules", "tar", "package.json"), {
    name: "tar",
    version: tarVersion,
  });
  fs.writeFileSync(path.join(npmRoot, "node_modules", "tar", "old.js"), "old\n");
  writeJson(path.join(replacementRoot, "package.json"), {
    name: "tar",
    version: FIXED_TAR_VERSION,
  });
  fs.mkdirSync(path.join(replacementRoot, "lib"));
  fs.writeFileSync(path.join(replacementRoot, "lib", "fixed.js"), "fixed\n");
  return { npmRoot, replacementRoot };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("npm bundled node-tar remediation", () => {
  it("binds the replacement and safety floor to the first patched tar release", () => {
    expect(FIXED_TAR_VERSION).toBe("7.5.21");
    expect(MINIMUM_SAFE_TAR_VERSION).toBe("7.5.21");
    expect(FIXED_TAR_INTEGRITY).toBe(
      "sha512-XdhtCvlMywwxpCW8YEq3lOXBJpUPTR2OHHcwLPO3HwsJqOHa2Ok/oJ7ruGzp+JrKoRPVCzJwAdEjqLW/vNRPHA==",
    );
    expect(FIXED_TAR_TARBALL).toBe("https://registry.npmjs.org/tar/-/tar-7.5.21.tgz");
  });

  it.each([
    ["Node 22 npm", "10.9.7", "7.5.11"],
    ["Node.js 24.16 npm", "11.13.0", "7.5.13"],
    ["Node.js 24.18 npm", "11.16.0", "7.5.15"],
    ["reviewed npm advisory release", "11.18.0", "7.5.19"],
    ["reviewed npm affected boundary", "11.18.0", "7.5.20"],
  ] as const)("replaces the complete affected tree for %s", (_label, npmVersion, tarVersion) => {
    const target = fixture(npmVersion, tarVersion);

    expect(() => verifyBundledNpmTar(target.npmRoot)).toThrow(`bundles affected tar@${tarVersion}`);
    expect(patchBundledNpmTar(target)).toMatchObject({
      npmVersion,
      state: "fixed",
      tarVersion: FIXED_TAR_VERSION,
    });
    expect(fs.existsSync(path.join(target.npmRoot, "node_modules", "tar", "old.js"))).toBe(false);
    expect(
      fs.readFileSync(path.join(target.npmRoot, "node_modules", "tar", "lib", "fixed.js"), "utf8"),
    ).toBe("fixed\n");
    expect(verifyBundledNpmTar(target.npmRoot).tarVersion).toBe(FIXED_TAR_VERSION);
  });

  it("does not invoke npm or npx until the affected bundled tar is replaced and verified", () => {
    const target = fixture("10.9.7", "7.5.11");
    const commands: string[] = [];
    const verifyFixedTarByCommand: Partial<Record<string, () => void>> = {
      npm: () => expect(verifyBundledNpmTar(target.npmRoot).tarVersion).toBe(FIXED_TAR_VERSION),
      npx: () => expect(verifyBundledNpmTar(target.npmRoot).tarVersion).toBe(FIXED_TAR_VERSION),
    };

    const result = patchBundledNpmTarFromRegistry(target.npmRoot, {
      commandRunner(command) {
        commands.push(command);
        verifyFixedTarByCommand[command]?.();
      },
      prepareReplacement(commandRunner) {
        commandRunner("curl", []);
        commandRunner("tar", []);
        return {
          cleanup: () => commands.push("cleanup"),
          replacementRoot: target.replacementRoot,
        };
      },
    });

    expect(result).toMatchObject({ state: "fixed", tarVersion: FIXED_TAR_VERSION });
    expect(commands).toEqual(["curl", "tar", "npm", "npx", "cleanup"]);
  });

  it("patches from the reviewed local cache seed without a registry request", () => {
    const target = fixture("11.16.0", "7.5.15");
    const archive = path.join(
      import.meta.dirname,
      "..",
      "tools",
      "mcp-tool-discovery-runtime",
      "npm-cache-seed",
      `tar-${FIXED_TAR_VERSION}.tgz`,
    );

    expect(patchBundledNpmTarFromArchive(target.npmRoot, archive)).toMatchObject({
      npmVersion: "11.16.0",
      state: "fixed",
      tarVersion: FIXED_TAR_VERSION,
    });
  });

  it("extracts the verified bytes when the caller archive changes after verification", () => {
    const target = fixture("11.16.0", "7.5.15");
    const archive = path.join(temporaryDirectory(), `tar-${FIXED_TAR_VERSION}.tgz`);
    const cacheSeed = path.join(
      import.meta.dirname,
      "..",
      "tools",
      "mcp-tool-discovery-runtime",
      "npm-cache-seed",
      `tar-${FIXED_TAR_VERSION}.tgz`,
    );
    fs.copyFileSync(cacheSeed, archive);
    const verifiedBytes = fs.readFileSync(archive);
    const commands: string[] = [];

    expect(
      patchBundledNpmTarFromArchive(target.npmRoot, archive, (command, args) => {
        commands.push(command);
        const operations: Readonly<Record<string, () => void>> = {
          npm: () => undefined,
          npx: () => undefined,
          tar: () => {
            fs.writeFileSync(archive, "replaced after verification\n");
            const fileIndex = args.indexOf("--file");
            expect(fileIndex).toBeGreaterThanOrEqual(0);
            const extractionArchive = args[fileIndex + 1]!;
            expect(extractionArchive).not.toBe(archive);
            expect(fs.readFileSync(extractionArchive)).toEqual(verifiedBytes);
            const result = spawnSync(command, [...args], { encoding: "utf8" });
            expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
          },
        };
        expect(operations[command], `unexpected command: ${command}`).toBeDefined();
        operations[command]!();
      }),
    ).toMatchObject({ state: "fixed", tarVersion: FIXED_TAR_VERSION });

    expect(commands).toEqual(["tar", "npm", "npx"]);
    expect(fs.readFileSync(archive, "utf8")).toBe("replaced after verification\n");
    expect(verifyBundledNpmTar(target.npmRoot).tarVersion).toBe(FIXED_TAR_VERSION);
  });

  it("rejects mismatched tar@7.5.21 archive bytes before extraction or npm-tree mutation (#9933)", () => {
    const target = fixture("11.18.0", "7.5.19");
    const commands: string[] = [];

    expect(() =>
      patchBundledNpmTarFromRegistry(target.npmRoot, {
        commandRunner(command, args) {
          commands.push(command);
          expect(command).toBe("curl");
          expect(args).toContain(FIXED_TAR_TARBALL);
          const outputIndex = args.indexOf("--output");
          expect(outputIndex).toBeGreaterThanOrEqual(0);
          fs.writeFileSync(args[outputIndex + 1]!, "mismatched archive bytes\n");
        },
      }),
    ).toThrow("npm bundled tar replacement integrity mismatch");

    expect(commands).toEqual(["curl"]);
    expect(fs.existsSync(path.join(target.npmRoot, "node_modules", "tar", "old.js"))).toBe(true);
    expect(
      fs.existsSync(path.join(target.npmRoot, "node_modules", "tar", "lib", "fixed.js")),
    ).toBe(false);
    expect(fs.readdirSync(path.join(target.npmRoot, "node_modules"))).toEqual(["tar"]);
    expect(() => verifyBundledNpmTar(target.npmRoot)).toThrow("bundles affected tar@7.5.19");
  });

  it("is idempotent when npm already bundles a safe release", () => {
    const target = fixture("10.9.7", FIXED_TAR_VERSION);
    expect(patchBundledNpmTar(target)).toMatchObject({ state: "fixed" });
    expect(fs.existsSync(path.join(target.npmRoot, "node_modules", "tar", "old.js"))).toBe(true);
  });

  it("restores the original bundled package when the replacement rename fails", () => {
    const target = fixture("10.9.7", "7.5.11");
    const originalRenameSync = fs.renameSync.bind(fs);
    const renameSpy = vi
      .spyOn(fs, "renameSync")
      .mockImplementationOnce(() => {
        throw new Error("injected replacement rename failure");
      })
      .mockImplementation(originalRenameSync);
    syncBuiltinESMExports();

    try {
      expect(() => patchBundledNpmTar(target)).toThrow("injected replacement rename failure");
    } finally {
      renameSpy.mockRestore();
      syncBuiltinESMExports();
    }

    expect(fs.existsSync(path.join(target.npmRoot, "node_modules", "tar", "old.js"))).toBe(true);
    expect(fs.existsSync(path.join(target.npmRoot, "node_modules", "tar", "lib", "fixed.js"))).toBe(
      false,
    );
    expect(fs.readdirSync(path.join(target.npmRoot, "node_modules"))).toEqual(["tar"]);
    expect(() => verifyBundledNpmTar(target.npmRoot)).toThrow("bundles affected tar@7.5.11");
  });

  it("preserves the verified replacement when backup cleanup fails", () => {
    const target = fixture("10.9.7", "7.5.11");
    const originalRmSync = fs.rmSync.bind(fs);
    const failBackupCleanup = (): never => {
      throw new Error("injected backup cleanup failure");
    };
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation((targetPath, options) => {
      return String(targetPath).includes(".nemoclaw-backup-")
        ? failBackupCleanup()
        : originalRmSync(targetPath, options);
    });
    syncBuiltinESMExports();

    try {
      expect(() => patchBundledNpmTar(target)).toThrow("injected backup cleanup failure");
    } finally {
      rmSpy.mockRestore();
      syncBuiltinESMExports();
    }

    expect(fs.existsSync(path.join(target.npmRoot, "node_modules", "tar", "old.js"))).toBe(false);
    expect(
      fs.readFileSync(path.join(target.npmRoot, "node_modules", "tar", "lib", "fixed.js"), "utf8"),
    ).toBe("fixed\n");
    expect(verifyBundledNpmTar(target.npmRoot).tarVersion).toBe(FIXED_TAR_VERSION);
  });

  it("fails closed on npm layout drift and unsafe replacement members", () => {
    const drifted = fixture("10.9.7", "7.5.11");
    const manifestPath = path.join(drifted.npmRoot, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.version = "12.0.0";
    writeJson(manifestPath, manifest);
    expect(() => patchBundledNpmTar(drifted)).toThrow("layout has drifted");

    const unsafe = fixture("11.13.0", "7.5.13");
    fs.symlinkSync("package.json", path.join(unsafe.replacementRoot, "unsafe-link"));
    expect(() => patchBundledNpmTar(unsafe)).toThrow("unsafe member");
  });
});
