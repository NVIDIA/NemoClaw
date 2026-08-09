// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadBootstrapQualificationContractFromRoot,
  parseBoundedJson,
  readBoundedRegularFileBytes,
} from "../scripts/checks/openshell-qualification-io.mts";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openshell-qualification-io-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("OpenShell qualification descriptor-pinned reads", () => {
  it("rejects links, directories, empty input, and oversized input (#8590)", () => {
    const root = tempRoot();
    const source = path.join(root, "source.txt");
    const linked = path.join(root, "linked.txt");
    const empty = path.join(root, "empty.txt");
    const oversized = path.join(root, "oversized.txt");
    fs.writeFileSync(source, "trusted");
    fs.symlinkSync(source, linked);
    fs.writeFileSync(empty, "");
    fs.writeFileSync(oversized, "12345");

    expect(() =>
      readBoundedRegularFileBytes(linked, "linked input", {
        maximumBytes: 7,
        minimumBytes: 1,
      }),
    ).toThrow("regular non-link file");
    expect(() =>
      readBoundedRegularFileBytes(root, "directory input", {
        maximumBytes: 7,
        minimumBytes: 1,
      }),
    ).toThrow("bounded regular non-link file");
    expect(() =>
      readBoundedRegularFileBytes(empty, "empty input", {
        maximumBytes: 7,
        minimumBytes: 1,
      }),
    ).toThrow("bounded regular non-link file");
    expect(() =>
      readBoundedRegularFileBytes(oversized, "oversized input", {
        maximumBytes: 4,
        minimumBytes: 1,
      }),
    ).toThrow("bounded regular non-link file");
  });

  it("keeps bytes pinned to the opened descriptor when the path is swapped (#8590)", () => {
    const root = tempRoot();
    const source = path.join(root, "source.txt");
    const opened = path.join(root, "opened.txt");
    fs.writeFileSync(source, "trusted");
    const openSync = fs.openSync.bind(fs);
    vi.spyOn(fs, "openSync").mockImplementation((filePath, flags, mode) => {
      const descriptor = openSync(filePath, flags, mode);
      fs.renameSync(source, opened);
      fs.writeFileSync(source, "replacement");
      return descriptor;
    });

    expect(
      readBoundedRegularFileBytes(source, "swapped input", {
        maximumBytes: 32,
        minimumBytes: 1,
      }).toString("utf8"),
    ).toBe("trusted");
    expect(fs.readFileSync(source, "utf8")).toBe("replacement");
  });

  it("rejects input that grows beyond the bound after descriptor authentication (#8590)", () => {
    const root = tempRoot();
    const source = path.join(root, "source.txt");
    fs.writeFileSync(source, "1234");
    const fstatSync = fs.fstatSync.bind(fs);
    vi.spyOn(fs, "fstatSync")
      .mockImplementationOnce((descriptor, options) => {
        const stats = fstatSync(descriptor, options as { bigint: true });
        fs.appendFileSync(source, "5");
        return stats;
      })
      .mockImplementation((descriptor, options) =>
        fstatSync(descriptor, options as { bigint: true }),
      );

    expect(() =>
      readBoundedRegularFileBytes(source, "growing input", {
        maximumBytes: 4,
        minimumBytes: 1,
      }),
    ).toThrow("changed while it was being read");
  });

  it("rejects same-size input overwritten after descriptor authentication (#8590)", () => {
    const root = tempRoot();
    const source = path.join(root, "source.txt");
    fs.writeFileSync(source, "SAFE");
    const fstatSync = fs.fstatSync.bind(fs);
    vi.spyOn(fs, "fstatSync")
      .mockImplementationOnce((descriptor, options) => {
        const stats = fstatSync(descriptor, options as { bigint: true });
        fs.writeFileSync(source, "EVIL");
        return stats;
      })
      .mockImplementation((descriptor, options) =>
        fstatSync(descriptor, options as { bigint: true }),
      );

    expect(() =>
      readBoundedRegularFileBytes(source, "overwritten input", {
        maximumBytes: 8,
        minimumBytes: 1,
      }),
    ).toThrow("changed while it was being read");
  });

  it("closes the descriptor after successful and rejected reads (#8590)", () => {
    const root = tempRoot();
    const source = path.join(root, "source.txt");
    fs.writeFileSync(source, "trusted");
    const closeSync = vi.spyOn(fs, "closeSync");

    expect(
      readBoundedRegularFileBytes(source, "valid input", {
        maximumBytes: 8,
        minimumBytes: 1,
      }).toString("utf8"),
    ).toBe("trusted");
    expect(() =>
      readBoundedRegularFileBytes(source, "oversized input", {
        maximumBytes: 3,
        minimumBytes: 1,
      }),
    ).toThrow("bounded regular non-link file");
    expect(closeSync).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate JSON keys and symbolic contract components (#8590)", () => {
    expect(() => parseBoundedJson('{"scope":1,"scope":2}', "duplicate JSON")).toThrow(
      "duplicate object key",
    );

    const root = tempRoot();
    const outside = tempRoot();
    fs.mkdirSync(path.join(outside, "ci"));
    fs.writeFileSync(path.join(outside, "ci", "openshell-0.0.101-qualification-v1.json"), "{}");
    fs.symlinkSync(path.join(outside, "ci"), path.join(root, "ci"));
    expect(() => loadBootstrapQualificationContractFromRoot(root)).toThrow(
      "crosses a symbolic link",
    );
  });
});
