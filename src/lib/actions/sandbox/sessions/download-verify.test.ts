// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDownloadedFile } from "./download-verify";

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
