// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertDownloadArtifactExists,
  assertDownloadedFile,
  resolveDownloadArtifactPath,
} from "./download-verify";

describe("assertDownloadedFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-7367-verify-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("passes when the download reported success and wrote a non-empty file", () => {
    const target = path.join(dir, "bundle.tgz");
    fs.writeFileSync(target, "payload");
    expect(() =>
      assertDownloadedFile({ status: 0 }, target, {
        remoteLabel: "/sandbox/x.tgz",
        sandboxName: "alpha",
        requireNonEmpty: true,
      }),
    ).not.toThrow();
  });

  it("rejects a non-zero exit status with the exit code in the message", () => {
    const target = path.join(dir, "bundle.tgz");
    fs.writeFileSync(target, "payload");
    expect(() =>
      assertDownloadedFile({ status: 1 }, target, {
        remoteLabel: "/sandbox/x.tgz",
        sandboxName: "alpha",
      }),
    ).toThrow(/Failed to download '\/sandbox\/x\.tgz' from sandbox 'alpha' \(exit 1\)\./);
  });

  // The #7367 core: openshell can exit 0 while writing nothing. Trusting the
  // exit code alone would record the rejected download as a valid bundle.
  it("rejects exit 0 when no file was written", () => {
    const target = path.join(dir, "missing.tgz");
    expect(() =>
      assertDownloadedFile({ status: 0 }, target, {
        remoteLabel: "/sandbox/x.tgz",
        sandboxName: "alpha",
        requireNonEmpty: true,
      }),
    ).toThrow(/reported success \(exit 0\) but no file was written to/);
  });

  it("rejects exit 0 when the destination is a directory, not a regular file", () => {
    const target = path.join(dir, "adir");
    fs.mkdirSync(target);
    expect(() =>
      assertDownloadedFile({ status: 0 }, target, {
        remoteLabel: "/sandbox/x.tgz",
        sandboxName: "alpha",
      }),
    ).toThrow(/reported success \(exit 0\) but '.*' is not a regular file/);
  });

  it("rejects exit 0 with an empty file when requireNonEmpty is set", () => {
    const target = path.join(dir, "empty.tgz");
    fs.writeFileSync(target, "");
    expect(() =>
      assertDownloadedFile({ status: 0 }, target, {
        remoteLabel: "/sandbox/x.tgz",
        sandboxName: "alpha",
        requireNonEmpty: true,
      }),
    ).toThrow(/reported success \(exit 0\) but wrote an empty file/);
  });

  it("allows an empty file when requireNonEmpty is not set (per-session files)", () => {
    const target = path.join(dir, "session.jsonl");
    fs.writeFileSync(target, "");
    expect(() =>
      assertDownloadedFile({ status: 0 }, target, {
        remoteLabel: "/sandbox/.openclaw/agents/main/sessions/session.jsonl",
        sandboxName: "alpha",
      }),
    ).not.toThrow();
  });
});

describe("resolveDownloadArtifactPath", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-7367-artifact-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns the exact dest for a file source when the dest is not a directory", () => {
    const dest = path.join(dir, "out.txt");
    expect(resolveDownloadArtifactPath("/sandbox/a/b.txt", dest, "file")).toBe(dest);
  });

  it("joins the source basename when the dest is an existing directory (file source)", () => {
    expect(resolveDownloadArtifactPath("/sandbox/a/b.txt", dir, "file")).toBe(
      path.join(dir, "b.txt"),
    );
  });

  it("joins the source basename when the dest has a trailing separator (file source)", () => {
    const dest = `${path.join(dir, "sub")}${path.sep}`;
    expect(resolveDownloadArtifactPath("/sandbox/a/b.txt", dest, "file")).toBe(
      path.join(dest, "b.txt"),
    );
  });

  it("returns the dest itself for a directory source (contents extract into it)", () => {
    expect(resolveDownloadArtifactPath("/sandbox/a/mydir", dir, "dir")).toBe(dir);
  });
});

describe("assertDownloadArtifactExists", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-7367-exists-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("passes when a file artifact exists", () => {
    const target = path.join(dir, "f.txt");
    fs.writeFileSync(target, "x");
    expect(() =>
      assertDownloadArtifactExists(target, { remoteLabel: "/sandbox/f.txt", sandboxName: "alpha" }),
    ).not.toThrow();
  });

  it("passes when a directory artifact exists (directory downloads are valid)", () => {
    expect(() =>
      assertDownloadArtifactExists(dir, { remoteLabel: "/sandbox/d", sandboxName: "alpha" }),
    ).not.toThrow();
  });

  it("throws when nothing was written (the #7367 exit-0 race)", () => {
    const target = path.join(dir, "missing");
    expect(() =>
      assertDownloadArtifactExists(target, { remoteLabel: "/sandbox/x", sandboxName: "alpha" }),
    ).toThrow(/reported success \(exit 0\) but nothing was written to/);
  });
});
