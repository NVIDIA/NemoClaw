// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishExportFile, YamlExportOutputError } from "./output";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-yaml-export-"));
  roots.push(root);
  return root;
}

function temporaryEntries(root: string): string[] {
  return fs.readdirSync(root).filter((entry) => entry.endsWith(".tmp"));
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

    expect(publishExportFile(outputPath, yaml)).toBe(outputPath);

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
        fileState: { publication: "not-published", stagingCleanup: "complete" },
        outputPath,
      }),
    );
    expect(fs.readFileSync(outputPath, "utf8")).toBe("original");
  });

  it("atomically replaces an existing regular file when force is set (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    fs.writeFileSync(outputPath, "original", { mode: 0o644 });
    const original = fs.lstatSync(outputPath);

    publishExportFile(outputPath, "replacement", true);

    const replacement = fs.lstatSync(outputPath);
    expect(fs.readFileSync(outputPath, "utf8")).toBe("replacement");
    expect(replacement.mode & 0o777).toBe(0o600);
    expect(replacement.ino).not.toBe(original.ino);
    expect(temporaryEntries(root)).toEqual([]);
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
        fileState: { publication: "not-published", stagingCleanup: "complete" },
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
          fileState: { publication: "not-published", stagingCleanup: "complete" },
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
          fileState: { publication: "not-published", stagingCleanup: "complete" },
          outputPath: "/dev/null",
        }),
      );
    },
  );

  it("retains the parent and removes staging when the parent path changes (#10938)", () => {
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
        fileState: { publication: "not-published", stagingCleanup: "complete" },
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
        fileState: { publication: "not-published", stagingCleanup: "complete" },
        outputPath,
      }),
    );
    expect(fs.readFileSync(outputPath, "utf8")).toBe("racing writer");
    expect(temporaryEntries(root)).toEqual([]);
  });

  it("reports unsafe output when a destination race leaves residual staging (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    const linkSync = fs.linkSync;
    const unlinkSync = fs.unlinkSync;
    vi.spyOn(fs, "linkSync").mockImplementationOnce((source, destination) => {
      fs.writeFileSync(outputPath, "racing writer");
      linkSync(source, destination);
    });
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("injected cleanup failure"), { code: "EIO" });
    });

    expect(() => publishExportFile(outputPath, "content")).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({
        category: "unsafe-output",
        fileState: { publication: "not-published", stagingCleanup: "incomplete" },
        outputPath,
      }),
    );
    expect(fs.readFileSync(outputPath, "utf8")).toBe("racing writer");
    expect(temporaryEntries(root)).toHaveLength(1);
    unlinkSync(path.join(root, temporaryEntries(root)[0]!));
  });

  it("recovers a committed hard link when publication reports failure (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    const linkSync = fs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementationOnce((source, destination) => {
      linkSync(source, destination);
      throw Object.assign(new Error("injected ambiguous link failure"), { code: "EIO" });
    });

    expect(publishExportFile(outputPath, "content")).toBe(outputPath);
    expect(fs.readFileSync(outputPath, "utf8")).toBe("content");
    expect(temporaryEntries(root)).toEqual([]);
  });

  it("recovers a committed rename when replacement reports failure (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    fs.writeFileSync(outputPath, "original");
    const renameSync = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementationOnce((source, destination) => {
      renameSync(source, destination);
      throw Object.assign(new Error("injected ambiguous rename failure"), { code: "EIO" });
    });

    expect(publishExportFile(outputPath, "replacement", true)).toBe(outputPath);
    expect(fs.readFileSync(outputPath, "utf8")).toBe("replacement");
    expect(temporaryEntries(root)).toEqual([]);
  });

  it("does not remove a foreign staging replacement after a recovered rename (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    fs.writeFileSync(outputPath, "original");
    const renameSync = fs.renameSync;
    const unlinkSync = fs.unlinkSync;
    let foreignPath = "";
    vi.spyOn(fs, "renameSync").mockImplementationOnce((source, destination) => {
      renameSync(source, destination);
      foreignPath = String(source);
      fs.writeFileSync(foreignPath, "foreign");
      throw Object.assign(new Error("injected ambiguous rename failure"), { code: "EIO" });
    });

    expect(publishExportFile(outputPath, "replacement", true)).toBe(outputPath);
    expect(fs.readFileSync(outputPath, "utf8")).toBe("replacement");
    expect(fs.readFileSync(foreignPath, "utf8")).toBe("foreign");
    unlinkSync(foreignPath);
  });

  it("reports the residual link when non-force cleanup fails after publication (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    const unlinkSync = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation((candidate) => {
      expect(String(candidate)).toMatch(/\.tmp$/u);
      throw Object.assign(new Error("injected cleanup failure"), { code: "EIO" });
    });

    expect(() => publishExportFile(outputPath, "content")).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({
        category: "unsafe-output",
        fileState: {
          publication: "published",
          durability: "confirmed",
          location: "confirmed",
          stagingCleanup: "incomplete",
        },
        outputPath,
        message: expect.stringContaining("temporary link could not be removed"),
      }),
    );
    expect(fs.readFileSync(outputPath, "utf8")).toBe("content");
    expect(temporaryEntries(root)).toHaveLength(1);
    unlinkSync(path.join(root, temporaryEntries(root)[0]!));
  });

  it("reports when publication succeeds but parent fsync fails (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
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

    expect(() => publishExportFile(outputPath, "content")).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({
        category: "unsafe-output",
        fileState: {
          publication: "published",
          durability: "unknown",
          location: "confirmed",
          stagingCleanup: "complete",
        },
        outputPath,
        message: expect.stringContaining("new export is published"),
      }),
    );
    expect(fs.readFileSync(outputPath, "utf8")).toBe("content");
    expect(temporaryEntries(root)).toEqual([]);
  });

  it("reports durability and cleanup independently when both fail (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    const fsyncSync = fs.fsyncSync;
    const unlinkSync = fs.unlinkSync;
    vi.spyOn(fs, "fsyncSync")
      .mockImplementationOnce((descriptor) => fsyncSync(descriptor))
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
      })
      .mockImplementation((descriptor) => fsyncSync(descriptor));
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("injected cleanup failure"), { code: "EIO" });
    });

    expect(() => publishExportFile(outputPath, "content")).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({
        category: "unsafe-output",
        fileState: {
          publication: "published",
          durability: "unknown",
          location: "confirmed",
          stagingCleanup: "incomplete",
        },
        outputPath,
      }),
    );
    expect(fs.readFileSync(outputPath, "utf8")).toBe("content");
    expect(temporaryEntries(root)).toHaveLength(1);
    unlinkSync(path.join(root, temporaryEntries(root)[0]!));
  });

  it("reports an uncertain committed location when the named parent changes after publication (#10938)", () => {
    const root = temporaryRoot();
    const outputParent = path.join(root, "output");
    const movedParent = path.join(root, "moved");
    const outputPath = path.join(outputParent, "selected.yaml");
    fs.mkdirSync(outputParent);
    const fsyncSync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync")
      .mockImplementationOnce((descriptor) => fsyncSync(descriptor))
      .mockImplementationOnce((descriptor) => {
        fsyncSync(descriptor);
        fs.renameSync(outputParent, movedParent);
        fs.mkdirSync(outputParent);
      })
      .mockImplementation((descriptor) => fsyncSync(descriptor));

    expect(() => publishExportFile(outputPath, "content")).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({
        category: "unsafe-output",
        fileState: {
          publication: "published",
          durability: "confirmed",
          location: "unknown",
          stagingCleanup: "complete",
        },
        outputPath,
      }),
    );
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.readFileSync(path.join(movedParent, "selected.yaml"), "utf8")).toBe("content");
    expect(temporaryEntries(movedParent)).toEqual([]);
  });

  it("checks the requested path during the final publication observation (#10938)", () => {
    const root = temporaryRoot();
    const outputParent = path.join(root, "output");
    const movedParent = path.join(root, "moved");
    const outputPath = path.join(outputParent, "selected.yaml");
    fs.mkdirSync(outputParent);
    const linkSync = fs.linkSync;
    const lstatSync = fs.lstatSync;
    let publicationComplete = false;
    vi.spyOn(fs, "linkSync").mockImplementationOnce((source, destination) => {
      linkSync(source, destination);
      publicationComplete = true;
    });
    vi.spyOn(fs, "lstatSync").mockImplementation((candidate) =>
      publicationComplete && String(candidate) === outputPath
        ? (() => {
            fs.renameSync(outputParent, movedParent);
            fs.mkdirSync(outputParent);
            return lstatSync(candidate);
          })()
        : lstatSync(candidate),
    );

    expect(() => publishExportFile(outputPath, "content")).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({
        category: "unsafe-output",
        fileState: {
          publication: "published",
          durability: "confirmed",
          location: "unknown",
          stagingCleanup: "complete",
        },
        outputPath,
      }),
    );
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.readFileSync(path.join(movedParent, "selected.yaml"), "utf8")).toBe("content");
  });

  it("reports an uncertain committed location when the destination changes after publication (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    const fsyncSync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync")
      .mockImplementationOnce((descriptor) => fsyncSync(descriptor))
      .mockImplementationOnce((descriptor) => {
        fsyncSync(descriptor);
        fs.unlinkSync(outputPath);
        fs.writeFileSync(outputPath, "foreign");
      })
      .mockImplementation((descriptor) => fsyncSync(descriptor));

    expect(() => publishExportFile(outputPath, "content")).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({
        category: "unsafe-output",
        fileState: {
          publication: "published",
          durability: "confirmed",
          location: "unknown",
          stagingCleanup: "complete",
        },
        outputPath,
      }),
    );
    expect(fs.readFileSync(outputPath, "utf8")).toBe("foreign");
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

    expect(() => publishExportFile(outputPath, "content")).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({
        category: "unsafe-output",
        fileState: { publication: "not-published", stagingCleanup: "complete" },
        outputPath,
      }),
    );
    expect(closed).toHaveLength(1);
  });

  it("does not retry a staged descriptor close that reports failure (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    const closeSync = fs.closeSync;
    let failedDescriptor: number | null = null;
    const closed: number[] = [];
    vi.spyOn(fs, "closeSync")
      .mockImplementationOnce((descriptor) => {
        failedDescriptor = descriptor;
        closed.push(descriptor);
        closeSync(descriptor);
        throw Object.assign(new Error("injected close failure"), { code: "EIO" });
      })
      .mockImplementation((descriptor) => {
        closed.push(descriptor);
        closeSync(descriptor);
      });

    expect(() => publishExportFile(outputPath, "content")).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({
        category: "unsafe-output",
        fileState: { publication: "not-published", stagingCleanup: "complete" },
        outputPath,
      }),
    );
    expect(closed.filter((descriptor) => descriptor === failedDescriptor)).toHaveLength(1);
    expect(temporaryEntries(root)).toEqual([]);
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

    expect(calls).toEqual(["fsync", "publish", "fsync"]);
  });
});
