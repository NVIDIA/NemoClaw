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

  it("reports the residual link when non-force cleanup fails after publication (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    const unlinkSync = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementationOnce((candidate) => {
      expect(String(candidate)).toMatch(/\.tmp$/u);
      throw Object.assign(new Error("injected cleanup failure"), { code: "EIO" });
    });

    expect(() => publishExportFile(outputPath, "content")).toThrowError(
      expect.objectContaining<Partial<YamlExportOutputError>>({
        category: "unsafe-output",
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
        outputPath,
        message: expect.stringContaining("new export is published"),
      }),
    );
    expect(fs.readFileSync(outputPath, "utf8")).toBe("content");
    expect(temporaryEntries(root)).toEqual([]);
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

    expect(calls).toEqual(["fsync", "publish", "fsync"]);
  });
});
