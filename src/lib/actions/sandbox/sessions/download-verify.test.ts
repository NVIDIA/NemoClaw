// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertDownloadArtifactExists,
  assertDownloadedFile,
  publishDownloadArtifact,
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
      path.join(fs.realpathSync(dir), "b.txt"),
    );
  });

  it("joins the source basename when the dest has a trailing separator (file source)", () => {
    const dest = `${path.join(dir, "sub")}${path.sep}`;
    expect(resolveDownloadArtifactPath("/sandbox/a/b.txt", dest, "file")).toBe(
      path.join(dest, "b.txt"),
    );
  });

  it("returns the dest itself for a directory source (contents extract into it)", () => {
    expect(resolveDownloadArtifactPath("/sandbox/a/mydir", dir, "dir")).toBe(fs.realpathSync(dir));
  });

  it("resolves an existing symbolic-link directory before publication", () => {
    const linkedDir = path.join(dir, "linked");
    const actualDir = path.join(dir, "actual");
    fs.mkdirSync(actualDir);
    fs.symlinkSync(actualDir, linkedDir);

    const canonicalDir = fs.realpathSync(actualDir);
    expect(resolveDownloadArtifactPath("/sandbox/a/mydir", linkedDir, "dir")).toBe(canonicalDir);
    expect(resolveDownloadArtifactPath("/sandbox/a/file.txt", linkedDir, "file")).toBe(
      path.join(canonicalDir, "file.txt"),
    );
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

  it("throws when nothing was written, the exit-0 race (#7367)", () => {
    const target = path.join(dir, "missing");
    expect(() =>
      assertDownloadArtifactExists(target, { remoteLabel: "/sandbox/x", sandboxName: "alpha" }),
    ).toThrow(/reported success \(exit 0\) but nothing was written to/);
  });
});

describe("publishDownloadArtifact", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-7367-publish-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("merges a staged directory into an existing destination directory", () => {
    const staged = path.join(dir, "staged");
    const destination = path.join(dir, "destination");
    fs.mkdirSync(staged);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(staged, "new.txt"), "new");
    fs.writeFileSync(path.join(destination, "existing.txt"), "existing");

    publishDownloadArtifact(staged, destination, "dir");

    expect(fs.readFileSync(path.join(destination, "new.txt"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(destination, "existing.txt"), "utf8")).toBe("existing");
  });

  it("rejects a destination path that traverses a symbolic link", () => {
    const staged = path.join(dir, "staged");
    const outside = path.join(dir, "outside");
    const destination = path.join(dir, "destination");
    fs.mkdirSync(path.join(staged, "linked"), { recursive: true });
    fs.mkdirSync(outside);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(staged, "linked", "new.txt"), "new");
    fs.symlinkSync(outside, path.join(destination, "linked"));

    expect(() => publishDownloadArtifact(staged, destination, "dir")).toThrow(
      /destination path '.*linked' is a symbolic link/,
    );
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("rejects a fresh destination below a symbolic-link parent without writing the target", () => {
    const staged = path.join(dir, "staged.txt");
    const outside = path.join(dir, "outside");
    const linkedParent = path.join(dir, "linked-parent");
    const destination = path.join(linkedParent, "fresh.txt");
    fs.writeFileSync(staged, "payload");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, linkedParent);

    expect(() => publishDownloadArtifact(staged, destination, "file")).toThrow(
      /destination path '.*linked-parent' is a symbolic link/,
    );
    expect(fs.existsSync(path.join(outside, "fresh.txt"))).toBe(false);
  });

  it("rejects an existing symbolic-link file without changing its target", () => {
    const staged = path.join(dir, "staged.txt");
    const outside = path.join(dir, "outside.txt");
    const destination = path.join(dir, "destination.txt");
    fs.writeFileSync(staged, "new");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, destination);

    expect(() => publishDownloadArtifact(staged, destination, "file")).toThrow(
      /destination path '.*destination\.txt' is a symbolic link/,
    );
    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
  });

  it("atomically replaces an existing regular file", () => {
    const staged = path.join(dir, "staged.txt");
    const destination = path.join(dir, "destination.txt");
    fs.writeFileSync(staged, "new");
    fs.writeFileSync(destination, "old");

    publishDownloadArtifact(staged, destination, "file");

    expect(fs.readFileSync(destination, "utf8")).toBe("new");
  });
});
