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

  it("removes the temporary file when rename fails (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("injected rename failure");
    });

    expect(() => publishExportFile(outputPath, "content")).toThrow("injected rename failure");
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(temporaryEntries(root)).toEqual([]);
  });

  it("fsyncs the file before rename and then fsyncs the parent directory (#10938)", () => {
    const root = temporaryRoot();
    const outputPath = path.join(root, "selected.yaml");
    const calls: string[] = [];
    const renameSync = fs.renameSync;
    const fsyncSync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      calls.push("fsync");
      fsyncSync(descriptor);
    });
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      calls.push("rename");
      renameSync(source, destination);
    });

    publishExportFile(outputPath, "content");

    expect(calls).toEqual(["fsync", "rename", "fsync"]);
  });
});
