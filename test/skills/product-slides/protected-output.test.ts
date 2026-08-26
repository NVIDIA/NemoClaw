// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  ancestorEntryIsProtected,
  quoteProtectedOutputPath,
  writeProtectedOutput,
} from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/protected-output.mts";

const SCRIPT_DIRECTORY = path.resolve(".agents/skills/nemoclaw-maintainer-product-slides/scripts");

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-protected-output-"));
}

function stagingEntries(directoryPath: string, outputPath: string): string[] {
  const prefix = `.${path.basename(outputPath)}.nemoclaw-stage-`;
  return fs.readdirSync(directoryPath).filter((entry) => entry.startsWith(prefix));
}

function runScript(scriptName: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(SCRIPT_DIRECTORY, scriptName), ...args],
    { encoding: "utf8", timeout: 10_000 },
  );
}

const PROTECTED_OUTPUT_CLIS = [
  {
    name: "documentation evidence collector",
    scriptName: "collect-doc-evidence.mts",
    args: (directoryPath: string, outputPath: string) => [
      "--repo-root",
      directoryPath,
      "--commit",
      "0".repeat(40),
      "--claims",
      path.join(directoryPath, "missing-claims.json"),
      "--output",
      outputPath,
    ],
  },
  {
    name: "slide model builder",
    scriptName: "build-slide-model.mts",
    args: (directoryPath: string, outputPath: string) => [
      "--repo-root",
      directoryPath,
      "--snapshot",
      path.join(directoryPath, "missing-snapshot.json"),
      "--docs",
      path.join(directoryPath, "missing-docs.json"),
      "--presentation-map",
      path.join(directoryPath, "missing-presentation-map.json"),
      "--claims",
      path.join(directoryPath, "missing-claims.json"),
      "--narrative-input",
      path.join(directoryPath, "missing-narrative.json"),
      "--template-fingerprint",
      "0".repeat(64),
      "--output",
      outputPath,
    ],
  },
] as const;

describe("protected product-slide JSON outputs", () => {
  it("JSON-quotes control bytes in successful output paths", () => {
    const outputPath = "/tmp/line-one\n\u001b[31mresult.json";

    expect(quoteProtectedOutputPath(outputPath)).toBe(JSON.stringify(outputPath));
    expect(quoteProtectedOutputPath(outputPath)).not.toContain("\u001b");
  });

  it.each(PROTECTED_OUTPUT_CLIS)(
    "rejects a pre-existing $name destination before reading inputs",
    (testCase) => {
      const directoryPath = temporaryDirectory();
      const outputPath = path.join(directoryPath, "line-one\n\u001b[31mresult.json");
      try {
        fs.writeFileSync(outputPath, "existing destination", { mode: 0o600 });

        const result = runScript(testCase.scriptName, testCase.args(directoryPath, outputPath));

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("output already exists and will not be overwritten");
        expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
        expect(result.stderr).toContain(
          JSON.stringify(
            path.join(fs.realpathSync.native(directoryPath), path.basename(outputPath)),
          ),
        );
        expect(result.stderr).not.toContain("\u001b");
        expect(fs.readFileSync(outputPath, "utf8")).toBe("existing destination");
        expect(stagingEntries(directoryPath, outputPath)).toEqual([]);
      } finally {
        fs.rmSync(directoryPath, { recursive: true, force: true });
      }
    },
  );

  it.each(PROTECTED_OUTPUT_CLIS)(
    "escapes control bytes and emits one $name error line when the output parent is not a directory",
    (testCase) => {
      const directoryPath = temporaryDirectory();
      const hostileParentPath = path.join(directoryPath, "line-one\n\u001b[31mparent");
      const outputPath = path.join(hostileParentPath, "result.json");
      try {
        fs.writeFileSync(hostileParentPath, "not a directory", { mode: 0o600 });

        const result = runScript(testCase.scriptName, testCase.args(directoryPath, outputPath));

        expect(result.status).toBe(1);
        expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
        expect(result.stderr).toContain("Protected directory is not a real directory");
        expect(result.stderr).not.toContain("\u001b");
        expect(result.stderr).not.toContain("line-one\n");
        expect(fs.readFileSync(hostileParentPath, "utf8")).toBe("not a directory");
      } finally {
        fs.rmSync(directoryPath, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlink destination without changing its referent",
    () => {
      const directoryPath = temporaryDirectory();
      const referentPath = path.join(directoryPath, "referent.json");
      const outputPath = path.join(directoryPath, "result.json");
      try {
        fs.writeFileSync(referentPath, "referent", { mode: 0o600 });
        fs.symlinkSync(referentPath, outputPath);

        expect(() =>
          writeProtectedOutput(outputPath, "replacement", { artifactName: "Test artifact" }),
        ).toThrow(/already exists and will not be overwritten/u);
        expect(fs.lstatSync(outputPath).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(referentPath, "utf8")).toBe("referent");
        expect(stagingEntries(directoryPath, outputPath)).toEqual([]);
      } finally {
        fs.rmSync(directoryPath, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")("rejects an output parent that is not owner-only", () => {
    const directoryPath = temporaryDirectory();
    const outputPath = path.join(directoryPath, "result.json");
    try {
      fs.chmodSync(directoryPath, 0o750);

      expect(() =>
        writeProtectedOutput(outputPath, "unpublished", { artifactName: "Test artifact" }),
      ).toThrow(/must be owned by effective UID .* with mode 0700/u);
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(stagingEntries(directoryPath, outputPath)).toEqual([]);
    } finally {
      fs.chmodSync(directoryPath, 0o700);
      fs.rmSync(directoryPath, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects an owner-only output parent whose mode is not exactly 0700",
    () => {
      const directoryPath = temporaryDirectory();
      const outputPath = path.join(directoryPath, "result.json");
      try {
        fs.chmodSync(directoryPath, 0o600);

        expect(() =>
          writeProtectedOutput(outputPath, "unpublished", { artifactName: "Test artifact" }),
        ).toThrow(/must be owned by effective UID .* with mode 0700/u);
        fs.chmodSync(directoryPath, 0o700);
        expect(fs.existsSync(outputPath)).toBe(false);
        expect(stagingEntries(directoryPath, outputPath)).toEqual([]);
      } finally {
        fs.chmodSync(directoryPath, 0o700);
        fs.rmSync(directoryPath, { recursive: true, force: true });
      }
    },
  );

  it("rejects ancestor metadata owned by an unrelated user even without group or other write bits", () => {
    const ownerUid = 501n;
    const childMetadata = { uid: ownerUid };

    expect(ancestorEntryIsProtected({ uid: 502n, mode: 0o700n }, childMetadata, ownerUid)).toBe(
      false,
    );
    expect(ancestorEntryIsProtected({ uid: 502n, mode: 0o1700n }, childMetadata, ownerUid)).toBe(
      false,
    );
  });

  it("accepts root-owned ancestor metadata when its pathname entry is protected", () => {
    const ownerUid = 501n;
    const childMetadata = { uid: ownerUid };

    expect(ancestorEntryIsProtected({ uid: 0n, mode: 0o755n }, childMetadata, ownerUid)).toBe(true);
    expect(ancestorEntryIsProtected({ uid: 0n, mode: 0o1777n }, childMetadata, ownerUid)).toBe(
      true,
    );
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic-link output-parent chain", () => {
    const directoryPath = temporaryDirectory();
    const realParentPath = path.join(directoryPath, "real-parent");
    const aliasParentPath = path.join(directoryPath, "alias-parent");
    const outputPath = path.join(aliasParentPath, "result.json");
    try {
      fs.mkdirSync(realParentPath, { mode: 0o700 });
      fs.symlinkSync(realParentPath, aliasParentPath);

      expect(() =>
        writeProtectedOutput(outputPath, "unpublished", { artifactName: "Test artifact" }),
      ).toThrow(/contains an untrusted symbolic-link path/u);
      expect(fs.existsSync(path.join(realParentPath, "result.json"))).toBe(false);
      expect(stagingEntries(realParentPath, outputPath)).toEqual([]);
    } finally {
      fs.rmSync(directoryPath, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a missing output parent without changing a symbolic-link referent",
    () => {
      const directoryPath = temporaryDirectory();
      const realParentPath = path.join(directoryPath, "real-parent");
      const aliasParentPath = path.join(directoryPath, "alias-parent");
      const missingParentPath = path.join(aliasParentPath, "missing-parent");
      const outputPath = path.join(missingParentPath, "result.json");
      try {
        fs.mkdirSync(realParentPath, { mode: 0o700 });
        fs.symlinkSync(realParentPath, aliasParentPath);

        expect(() =>
          writeProtectedOutput(outputPath, "unpublished", { artifactName: "Test artifact" }),
        ).toThrow(/Could not resolve protected output directory/u);
        expect(fs.existsSync(path.join(realParentPath, "missing-parent"))).toBe(false);
        expect(fs.readdirSync(realParentPath)).toEqual([]);
      } finally {
        fs.rmSync(directoryPath, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects an ancestor that another user could use for a pathname swap",
    () => {
      const directoryPath = temporaryDirectory();
      const mutableAncestorPath = path.join(directoryPath, "mutable-ancestor");
      const outputParentPath = path.join(mutableAncestorPath, "run");
      const outputPath = path.join(outputParentPath, "result.json");
      try {
        fs.mkdirSync(mutableAncestorPath, { mode: 0o700 });
        fs.mkdirSync(outputParentPath, { mode: 0o700 });
        fs.chmodSync(mutableAncestorPath, 0o777);

        expect(() =>
          writeProtectedOutput(outputPath, "unpublished", { artifactName: "Test artifact" }),
        ).toThrow(/ancestor permits an untrusted pathname swap/u);
        expect(fs.existsSync(outputPath)).toBe(false);
        expect(stagingEntries(outputParentPath, outputPath)).toEqual([]);
      } finally {
        fs.chmodSync(mutableAncestorPath, 0o700);
        fs.rmSync(directoryPath, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(
    process.platform !== "darwin" ||
      !fs.realpathSync.native(os.tmpdir()).startsWith("/private/var/"),
  )("canonicalizes the normal macOS /var temporary-directory alias", () => {
    const directoryPath = temporaryDirectory();
    const outputPath = path.join(directoryPath, "result.json");
    try {
      const publishedPath = writeProtectedOutput(outputPath, "published", {
        artifactName: "Test artifact",
      });

      expect(publishedPath).toBe(
        path.join(fs.realpathSync.native(directoryPath), path.basename(outputPath)),
      );
      expect(fs.readFileSync(outputPath, "utf8")).toBe("published");
    } finally {
      fs.rmSync(directoryPath, { recursive: true, force: true });
    }
  });

  it("preserves a competing publication and removes only its own staging workspace", () => {
    const directoryPath = temporaryDirectory();
    const outputPath = path.join(directoryPath, "result.json");
    try {
      expect(() =>
        writeProtectedOutput(outputPath, "invocation", {
          artifactName: "Test artifact",
          beforePublish: (_temporaryPath, destinationPath) => {
            fs.writeFileSync(destinationPath, "competitor", { flag: "wx", mode: 0o600 });
          },
        }),
      ).toThrow(/output already exists and was not changed/u);
      expect(fs.readFileSync(outputPath, "utf8")).toBe("competitor");
      expect(stagingEntries(directoryPath, outputPath)).toEqual([]);
    } finally {
      fs.rmSync(directoryPath, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "publishes a mode-0600 file from an owner-only exclusive no-follow stage",
    () => {
      const directoryPath = temporaryDirectory();
      const outputPath = path.join(directoryPath, "result.json");
      let openFlags = 0;
      let stagedFileMode = 0;
      let stagingDirectoryMode = 0;
      try {
        writeProtectedOutput(outputPath, "published", {
          artifactName: "Test artifact",
          operations: {
            open: (filePath, flags, mode) => {
              openFlags = flags;
              return fs.openSync(filePath, flags, mode);
            },
          },
          beforePublish: (temporaryPath) => {
            stagedFileMode = fs.statSync(temporaryPath).mode & 0o777;
            stagingDirectoryMode = fs.statSync(path.dirname(temporaryPath)).mode & 0o777;
          },
        });

        expect(openFlags & fs.constants.O_CREAT).toBe(fs.constants.O_CREAT);
        expect(openFlags & fs.constants.O_EXCL).toBe(fs.constants.O_EXCL);
        expect(openFlags & (fs.constants.O_NOFOLLOW ?? 0)).toBe(fs.constants.O_NOFOLLOW ?? 0);
        expect(stagedFileMode).toBe(0o600);
        expect(stagingDirectoryMode).toBe(0o700);
        expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(outputPath, "utf8")).toBe("published");
        expect(stagingEntries(directoryPath, outputPath)).toEqual([]);
      } finally {
        fs.rmSync(directoryPath, { recursive: true, force: true });
      }
    },
  );

  it("removes its exact staging workspace when synchronization fails before publication", () => {
    const directoryPath = temporaryDirectory();
    const unrelatedPath = path.join(directoryPath, "unrelated.json");
    const outputPath = path.join(directoryPath, "result.json");
    try {
      fs.writeFileSync(unrelatedPath, "preserve me", { mode: 0o600 });

      expect(() =>
        writeProtectedOutput(outputPath, "unpublished", {
          artifactName: "Test artifact",
          operations: {
            fsync: () => {
              throw Object.assign(new Error("injected synchronization failure"), {
                code: "EIO",
                syscall: "fsync",
              });
            },
          },
        }),
      ).toThrow(/This invocation did not publish the output/u);
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(fs.readFileSync(unrelatedPath, "utf8")).toBe("preserve me");
      expect(stagingEntries(directoryPath, outputPath)).toEqual([]);
    } finally {
      fs.rmSync(directoryPath, { recursive: true, force: true });
    }
  });

  it("preserves the target and hard-link witness when publication ownership is ambiguous", () => {
    const directoryPath = temporaryDirectory();
    const outputPath = path.join(directoryPath, "result.json");
    let temporaryPath = "";
    try {
      expect(() =>
        writeProtectedOutput(outputPath, "published-or-competing", {
          artifactName: "Test artifact",
          beforePublish: (candidatePath) => {
            temporaryPath = candidatePath;
          },
          operations: {
            link: (candidatePath, destinationPath) => {
              fs.linkSync(candidatePath, destinationPath);
              throw Object.assign(new Error("injected uncertain link result"), {
                code: "EIO",
                syscall: "link",
                path: candidatePath,
                dest: destinationPath,
              });
            },
          },
        }),
      ).toThrow(/Target ownership is ambiguous/u);
      expect(fs.readFileSync(outputPath, "utf8")).toBe("published-or-competing");
      expect(fs.readFileSync(temporaryPath, "utf8")).toBe("published-or-competing");
      expect(String(fs.lstatSync(outputPath).ino)).toBe(String(fs.lstatSync(temporaryPath).ino));
      expect(fs.existsSync(path.dirname(temporaryPath))).toBe(true);
    } finally {
      fs.rmSync(directoryPath, { recursive: true, force: true });
    }
  });

  it("preserves a replacement staging directory when its identity changes before cleanup", () => {
    const directoryPath = temporaryDirectory();
    const outputPath = path.join(directoryPath, "result.json");
    let temporaryPath = "";
    let movedInvocationDirectoryPath = "";
    try {
      expect(() =>
        writeProtectedOutput(outputPath, "published", {
          artifactName: "Test artifact",
          beforePublish: (candidatePath) => {
            temporaryPath = candidatePath;
          },
          beforeCleanup: (candidatePath, stagingDirectoryPath) => {
            movedInvocationDirectoryPath = `${stagingDirectoryPath}.owned-original`;
            fs.renameSync(stagingDirectoryPath, movedInvocationDirectoryPath);
            fs.mkdirSync(stagingDirectoryPath, { mode: 0o700 });
            fs.writeFileSync(candidatePath, "unowned replacement", {
              flag: "wx",
              mode: 0o600,
            });
          },
        }),
      ).toThrow(/was published.*staging cleanup failed/u);
      expect(fs.readFileSync(outputPath, "utf8")).toBe("published");
      expect(fs.readFileSync(temporaryPath, "utf8")).toBe("unowned replacement");
      const movedInvocationPath = path.join(movedInvocationDirectoryPath, "output.json");
      expect(fs.readFileSync(movedInvocationPath, "utf8")).toBe("published");
      expect(String(fs.lstatSync(outputPath).ino)).toBe(
        String(fs.lstatSync(movedInvocationPath).ino),
      );
      expect(String(fs.lstatSync(outputPath).ino)).not.toBe(
        String(fs.lstatSync(temporaryPath).ino),
      );
      expect(fs.existsSync(path.dirname(temporaryPath))).toBe(true);
      expect(fs.existsSync(movedInvocationDirectoryPath)).toBe(true);
    } finally {
      fs.rmSync(directoryPath, { recursive: true, force: true });
    }
  });
});
