// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishExportFile, YamlExportOutputError } from "./output";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-yaml-export-"));
  roots.push(root);
  return root;
}

function temporaryEntries(root: string): string[] {
  return fs
    .readdirSync(root)
    .filter(
      (entry) =>
        entry.endsWith(".tmp") || entry.endsWith(".previous") || entry.endsWith(".rollback"),
    );
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("publishExportFile", () => {
  it("publishes all YAML bytes through a mode-0600 regular file (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    const yaml = `agent:
  name: nemo 🐠
`;

    expect(publishExportFile(outputPath, yaml)).toEqual({ path: outputPath });

    const stat = fs.lstatSync(outputPath);
    expect(fs.readFileSync(outputPath, "utf8")).toBe(yaml);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(temporaryEntries(root)).toEqual([]);
  });

  it("classifies an existing regular file as an output conflict without force (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    fs.writeFileSync(outputPath, "original");

    expect(() => publishExportFile(outputPath, "replacement")).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({
        category: "output-conflict",
        outputPath,
      }),
    );
    expect(fs.readFileSync(outputPath, "utf8")).toBe("original");
  });

  it("replaces only the validated regular file when force is set (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    fs.writeFileSync(outputPath, "original", { mode: 0o644 });

    publishExportFile(outputPath, "replacement", true);

    expect(fs.readFileSync(outputPath, "utf8")).toBe("replacement");
    expect(fs.lstatSync(outputPath).mode & 0o777).toBe(0o600);
  });

  it.each([
    {
      kind: "symlink",
      create: (outputPath: string, targetPath: string) => fs.symlinkSync(targetPath, outputPath),
    },
    { kind: "directory", create: (outputPath: string) => fs.mkdirSync(outputPath) },
  ])("classifies an existing $kind destination as unsafe output (#10938)", ({ create }) => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    const targetPath = path.join(root, "target.yaml");
    fs.writeFileSync(targetPath, "target");
    create(outputPath, targetPath);

    expect(() => publishExportFile(outputPath, "replacement", true)).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({
        category: "unsafe-output",
        outputPath,
      }),
    );
    expect(fs.readFileSync(targetPath, "utf8")).toBe("target");
  });

  it.runIf(process.platform !== "win32")(
    "classifies an existing FIFO as unsafe output (#10938)",
    () => {
      const root = temporaryRoot();
      const outputPath = path.join(root, "selected.yaml");
      execFileSync("mkfifo", [outputPath]);

      expect(() => publishExportFile(outputPath, "replacement", true)).toThrowError(
        expect.objectContaining<Partial<YamlExportOutputError>>({
          category: "unsafe-output",
          outputPath,
        }),
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "classifies a device destination as unsafe output (#10938)",
    () => {
      expect(() => publishExportFile("/dev/null", "replacement", true)).toThrowError(
        expect.objectContaining<Partial<YamlExportOutputError>>({
          category: "unsafe-output",
          outputPath: "/dev/null",
        }),
      );
    },
  );

  it("retains the validated parent and refuses its exchanged path (#10938)", () => {
    const root = temporaryRoot();
    const outputParent = path.join(root, "output");
    const movedParent = path.join(root, "moved");
    const outputPath = path.join(outputParent, "selected.yaml");
    fs.mkdirSync(outputParent);
    const fchmodSync = fs.fchmodSync;
    vi.spyOn(fs, "fchmodSync").mockImplementationOnce((descriptor, mode) => {
      fchmodSync(descriptor, mode);
      fs.renameSync(outputParent, movedParent);
      fs.mkdirSync(outputParent);
    });

    expect(() => publishExportFile(outputPath, "content")).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({
        category: "unsafe-output",
        outputPath,
      }),
    );
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.existsSync(path.join(movedParent, "selected.yaml"))).toBe(false);
    expect(temporaryEntries(movedParent)).toEqual([]);
  });

  it("atomically refuses a destination created during non-force publication (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    const linkSync = fs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementationOnce((source, destination) => {
      fs.writeFileSync(outputPath, "racing writer");
      linkSync(source, destination);
    });

    expect(() => publishExportFile(outputPath, "content")).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({
        category: "output-conflict",
        outputPath,
      }),
    );
    expect(fs.readFileSync(outputPath, "utf8")).toBe("racing writer");
    expect(temporaryEntries(root)).toEqual([]);
  });

  it("cleans staging when the atomic force exchange fails (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    fs.writeFileSync(outputPath, "validated");
    const movedByRacer = path.join(root, "racer.yaml");
    const expected = fs.lstatSync(outputPath);
    const linkSync = fs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementationOnce((source, destination) => {
      linkSync(source, destination);
      fs.renameSync(outputPath, movedByRacer);
    });
    expect(() => publishExportFile(outputPath, "content", true)).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({ category: "unsafe-output" }),
    );
    expect(fs.readFileSync(movedByRacer, "utf8")).toBe("validated");
    expect(fs.lstatSync(movedByRacer).ino).toBe(expected.ino);
    expect(temporaryEntries(root)).toEqual([]);
  });

  it("does not overwrite a destination exchanged during force publication (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    fs.writeFileSync(outputPath, "validated");
    const exchangedPath = path.join(root, "exchanged.yaml");
    fs.writeFileSync(exchangedPath, "exchanged");
    const exchangedStat = fs.lstatSync(exchangedPath);
    const fchmodSync = fs.fchmodSync;
    vi.spyOn(fs, "fchmodSync").mockImplementationOnce((descriptor, mode) => {
      fchmodSync(descriptor, mode);
      fs.renameSync(exchangedPath, outputPath);
    });

    expect(() => publishExportFile(outputPath, "content", true)).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({
        category: "unsafe-output",
        outputPath,
      }),
    );
    expect(fs.readFileSync(outputPath, "utf8")).toBe("exchanged");
    expect(fs.lstatSync(outputPath).ino).toBe(exchangedStat.ino);
    expect(temporaryEntries(root)).toEqual([]);
  });

  it("restores a directory exchanged before a forced move (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    fs.writeFileSync(outputPath, "validated");
    const fchmodSync = fs.fchmodSync;
    vi.spyOn(fs, "fchmodSync").mockImplementationOnce((descriptor, mode) => {
      fchmodSync(descriptor, mode);
      fs.rmSync(outputPath);
      fs.mkdirSync(outputPath);
    });
    let racedDirectoryStat: fs.Stats | undefined;
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      racedDirectoryStat = fs.lstatSync(outputPath);
    });

    expect(() => publishExportFile(outputPath, "content", true)).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({ category: "unsafe-output" }),
    );
    expect(fs.lstatSync(outputPath).isDirectory()).toBe(true);
    expect(fs.lstatSync(outputPath).ino).toBe(racedDirectoryStat?.ino);
    expect(temporaryEntries(root)).toEqual([]);
  });

  it("rolls back publication when the parent changes after publish (#10938)", () => {
    const root = temporaryRoot();
    const outputParent = path.join(root, "output");
    const movedParent = path.join(root, "moved");
    const outputPath = path.join(outputParent, "selected.yaml");
    fs.mkdirSync(outputParent);
    const linkSync = fs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementationOnce((source, destination) => {
      linkSync(source, destination);
      fs.renameSync(outputParent, movedParent);
      fs.mkdirSync(outputParent);
    });

    expect(() => publishExportFile(outputPath, "content")).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({ category: "unsafe-output" }),
    );
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.existsSync(path.join(movedParent, "selected.yaml"))).toBe(false);
  });

  it("preserves a concurrent destination during parent-change rollback (#10938)", () => {
    const root = temporaryRoot();
    const outputParent = path.join(root, "output");
    const movedParent = path.join(root, "moved");
    const outputPath = path.join(outputParent, "selected.yaml");
    const racedPath = path.join(movedParent, "selected.yaml");
    const writer = path.join(movedParent, "writer.yaml");
    fs.mkdirSync(outputParent);
    const linkSync = fs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementationOnce((source, destination) => {
      linkSync(source, destination);
      fs.renameSync(outputParent, movedParent);
      fs.mkdirSync(outputParent);
      fs.writeFileSync(writer, "writer");
      fs.renameSync(writer, racedPath);
    });

    expect(() => publishExportFile(outputPath, "content")).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({ category: "unsafe-output" }),
    );
    expect(fs.readFileSync(racedPath, "utf8")).toBe("writer");
  });

  it("preserves exact recovery paths when temporary-link cleanup fails (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    fs.writeFileSync(outputPath, "validated");
    const unlinkSync = fs.unlinkSync;
    let temporaryCleanupAttempts = 0;
    vi.spyOn(fs, "unlinkSync").mockImplementation((candidate) =>
      String(candidate).endsWith(".tmp")
        ? (() => {
            temporaryCleanupAttempts += 1;
            throw Object.assign(new Error("injected temporary cleanup failure"), { code: "EIO" });
          })()
        : unlinkSync(candidate),
    );

    let failure: unknown;
    try {
      publishExportFile(outputPath, "content", true);
    } catch (error) {
      failure = error;
    }
    const temporaryName = temporaryEntries(root).find((entry) => entry.endsWith(".tmp"));
    const previousName = temporaryEntries(root).find((entry) => entry.endsWith(".previous"));
    expect(temporaryName).toBeDefined();
    expect(previousName).toBeDefined();
    expect(temporaryCleanupAttempts).toBe(1);
    expect((failure as Error).message).toContain(path.join(root, temporaryName!));
    expect((failure as Error).message).toContain(path.join(root, previousName!));
    expect(fs.readFileSync(outputPath, "utf8")).toBe("content");
    expect(fs.readFileSync(path.join(root, previousName!), "utf8")).toBe("validated");
  });

  it("preserves prior output when post-publication durability is uncertain (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    fs.writeFileSync(outputPath, "validated");
    const fsyncSync = fs.fsyncSync;
    let calls = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      calls += 1;
      return calls === 2
        ? (() => {
            throw Object.assign(new Error("injected directory fsync failure"), { code: "EIO" });
          })()
        : fsyncSync(descriptor);
    });

    let failure: unknown;
    try {
      publishExportFile(outputPath, "content", true);
    } catch (error) {
      failure = error;
    }
    const previousName = temporaryEntries(root).find((entry) => entry.endsWith(".previous"));
    expect(previousName).toBeDefined();
    expect(calls).toBe(2);
    expect((failure as Error).message).toContain("durability could not be confirmed");
    expect((failure as Error).message).toContain(path.join(root, previousName!));
    expect(fs.readFileSync(outputPath, "utf8")).toBe("content");
    expect(fs.readFileSync(path.join(root, previousName!), "utf8")).toBe("validated");
  });

  it("classifies final prior-inode cleanup failure with the exact recovery path (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    fs.writeFileSync(outputPath, "validated");
    const calls: string[] = [];
    const fsyncSync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      calls.push("fsync");
      fsyncSync(descriptor);
    });
    const unlinkSync = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation((candidate) =>
      String(candidate).endsWith(".previous")
        ? (() => {
            calls.push("cleanup-previous");
            throw Object.assign(new Error("injected prior cleanup failure"), { code: "EIO" });
          })()
        : unlinkSync(candidate),
    );

    let failure: unknown;
    try {
      publishExportFile(outputPath, "content", true);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject<Partial<YamlExportOutputError>>({
      category: "unsafe-output",
      outputPath,
    });
    const recoveryName = temporaryEntries(root).find((entry) => entry.endsWith(".previous"));
    expect(recoveryName).toBeDefined();
    const recoveryPath = path.join(root, recoveryName!);
    expect((failure as Error).message).toContain(
      `prior output remains recoverable at: ${recoveryPath}`,
    );
    expect(fs.readFileSync(outputPath, "utf8")).toBe("content");
    expect(fs.readFileSync(recoveryPath, "utf8")).toBe("validated");
    expect(calls.slice(-2)).toEqual(["fsync", "cleanup-previous"]);
  });

  it("closes the parent descriptor when its fstat fails (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    const closeSync = fs.closeSync;
    const closed: number[] = [];
    vi.spyOn(fs, "fstatSync").mockImplementationOnce(() => {
      throw new Error("injected fstat failure");
    });
    vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
      closed.push(descriptor);
      closeSync(descriptor);
    });

    expect(() => publishExportFile(outputPath, "content")).toThrow("injected fstat failure");
    expect(closed).toHaveLength(1);
  });

  it("fsyncs the temporary file before publication and then fsyncs the parent (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    const calls: string[] = [];
    const linkSync = fs.linkSync;
    const fsyncSync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      calls.push("fsync");
      fsyncSync(descriptor);
    });
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      calls.push("publish");
      linkSync(source, destination);
    });

    publishExportFile(outputPath, "content");

    expect(calls).toEqual(["fsync", "publish", "fsync", "fsync"]);
  });
});
