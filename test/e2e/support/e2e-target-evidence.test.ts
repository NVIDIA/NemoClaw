// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";

function liveTypescriptFiles(): string[] {
  const liveRoot = path.resolve(import.meta.dirname, "../live");
  return fs
    .readdirSync(liveRoot)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => path.join(liveRoot, file));
}

describe("target evidence", () => {
  it("emits normalized, redacted metadata and result files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-target-evidence-"));
    const secret = "target-evidence-secret";
    try {
      const artifacts = new ArtifactSink(root, [secret]);

      await artifacts.target.declare({
        id: "typed-target",
        contract: ["first contract", "second contract"],
        detail: `contains ${secret}`,
        extensionField: "metadata extension field",
      });
      await artifacts.target.complete({
        id: "typed-target",
        assertionCount: 2,
        contract: "result extension field",
      });

      expect(JSON.parse(fs.readFileSync(path.join(root, "target.json"), "utf8"))).toEqual({
        id: "typed-target",
        detail: "contains [REDACTED]",
        extensionField: "metadata extension field",
        contracts: ["first contract", "second contract"],
        runner: "vitest",
      });
      expect(JSON.parse(fs.readFileSync(path.join(root, "target-result.json"), "utf8"))).toEqual({
        id: "typed-target",
        status: "passed",
        assertionCount: 2,
        contract: "result extension field",
        runner: "vitest",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid identifiers, results, and conflicting contract names", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-target-evidence-invalid-"));
    try {
      const target = new ArtifactSink(root).target;

      await expect(target.declare({ id: "" })).rejects.toThrow(/id must be a non-empty string/);
      await expect(target.declare({ id: "   " })).rejects.toThrow(/id must be a non-empty string/);
      await expect(target.complete({ id: "typed-target", status: "" })).rejects.toThrow(
        /status must be a non-empty string/,
      );
      await expect(target.complete({ id: "typed-target", status: "   " })).rejects.toThrow(
        /status must be a non-empty string/,
      );
      await expect(
        target.complete({ id: "typed-target", status: undefined } as never),
      ).rejects.toThrow(/status must be a non-empty string/);
      await expect(
        target.declare({
          id: "typed-target",
          contract: "singular",
          contracts: ["plural"],
        }),
      ).rejects.toThrow(/either contract or contracts/);
      await expect(
        target.declare({
          id: "typed-target",
          contract: 42,
        } as never),
      ).rejects.toThrow(/contracts must be a string or an array of strings/);
      await expect(
        target.declare({
          id: "typed-target",
          contracts: ["valid", 42],
        } as never),
      ).rejects.toThrow(/contracts must be a string or an array of strings/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("contains symlinked artifact roots before writing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-target-evidence-symlink-"));
    try {
      const realRoot = path.join(root, "real-root");
      const linkRoot = path.join(root, "link-root");
      fs.mkdirSync(realRoot);
      fs.symlinkSync(realRoot, linkRoot, "dir");

      const artifacts = new ArtifactSink(linkRoot);
      const targetPath = await artifacts.writeJson("target.json", { ok: true });

      expect(targetPath).toBe(fs.realpathSync(path.join(realRoot, "target.json")));
      expect(JSON.parse(fs.readFileSync(path.join(realRoot, "target.json"), "utf8"))).toEqual({
        ok: true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps live target evidence behind the typed API", () => {
    // This static guard intentionally catches literal legacy target filenames;
    // dynamic target filename construction should not be introduced in live tests.
    const violations = liveTypescriptFiles()
      .filter((file) =>
        /\.writeJson\(\s*[`'"]target(?:-result)?\.json[`'"]/.test(fs.readFileSync(file, "utf8")),
      )
      .map((file) => path.basename(file));

    expect(violations).toEqual([]);
  });
});
