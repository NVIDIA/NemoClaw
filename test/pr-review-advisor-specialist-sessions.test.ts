// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ADVISOR_INTERESTS } from "../tools/pr-review-advisor/specialists.mts";
import {
  specialistSessionFileName,
  validateSpecialistSessionDirectory,
} from "../tools/pr-review-advisor/specialist-sessions.mts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-specialists-"));
  roots.push(root);
  for (const interest of ADVISOR_INTERESTS) {
    fs.writeFileSync(
      path.join(root, specialistSessionFileName(interest)),
      JSON.stringify({
        type: "session",
        version: 3,
        id: interest,
        cwd: "/pr-workdir",
        timestamp: "2026-01-01T00:00:00Z",
      }) +
        "\n" +
        JSON.stringify({
          type: "message",
          id: `${interest}-message`,
          parentId: null,
          timestamp: "2026-01-01T00:00:01Z",
          message: { role: "assistant", content: "handoff" },
        }) +
        "\n",
    );
  }
  return root;
}

describe("specialist Pi session inputs", () => {
  it("accepts the five expected native Pi JSONL sessions", () => {
    const root = fixture();
    const inventory = validateSpecialistSessionDirectory(root);
    expect(Object.keys(inventory.files)).toEqual(ADVISOR_INTERESTS);
    expect(inventory.totalBytes).toBeGreaterThan(0);
  });

  it("rejects a missing mandatory session", () => {
    const root = fixture();
    fs.rmSync(path.join(root, specialistSessionFileName("trust")));
    expect(() => validateSpecialistSessionDirectory(root)).toThrow(
      /Missing specialist session: trust/u,
    );
  });

  it("rejects unexpected files", () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, "extra.jsonl"), "{}\n");
    expect(() => validateSpecialistSessionDirectory(root)).toThrow(
      /Unexpected specialist session input/u,
    );
  });

  it("rejects symlinked sessions", () => {
    const root = fixture();
    const behavior = path.join(root, specialistSessionFileName("behavior"));
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-specialist-target-"));
    roots.push(targetRoot);
    const target = path.join(targetRoot, "behavior.jsonl");
    fs.renameSync(behavior, target);
    fs.symlinkSync(target, behavior);
    expect(() => validateSpecialistSessionDirectory(root)).toThrow(/regular file: behavior/u);
  });

  it("rejects malformed JSONL and non-Pi headers", () => {
    const malformed = fixture();
    fs.writeFileSync(path.join(malformed, specialistSessionFileName("operations")), "{\n");
    expect(() => validateSpecialistSessionDirectory(malformed)).toThrow(/invalid JSONL/u);

    const invalidHeader = fixture();
    fs.writeFileSync(path.join(invalidHeader, specialistSessionFileName("documentation")), "{}\n");
    expect(() => validateSpecialistSessionDirectory(invalidHeader)).toThrow(
      /valid Pi session header/u,
    );
  });
});
