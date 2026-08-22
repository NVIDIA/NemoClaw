// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { advisorTurnFlowErrors, resolveAdvisorTurnTools } from "../tools/advisors/session.mts";
import { buildSynthesisTurn } from "../tools/pr-review-advisor/synthesis-turn.mts";
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
    expect(inventory.available).toEqual(ADVISOR_INTERESTS);
    expect(inventory.missing).toEqual([]);
  });

  it.each(["behavior", "trust"] as const)("rejects a missing required %s session", (interest) => {
    const root = fixture();
    fs.rmSync(path.join(root, specialistSessionFileName(interest)));
    expect(() => validateSpecialistSessionDirectory(root)).toThrow(
      new RegExp(`Missing required specialist session: ${interest}`, "u"),
    );
  });

  it.each(["design-architecture", "operations", "documentation"] as const)(
    "accepts a missing optional %s session and inventories the limitation",
    (interest) => {
      const root = fixture();
      fs.rmSync(path.join(root, specialistSessionFileName(interest)));
      const inventory = validateSpecialistSessionDirectory(root);

      expect(inventory.available).toEqual(ADVISOR_INTERESTS.filter((item) => item !== interest));
      expect(inventory.missing).toEqual([interest]);
      expect(inventory.files[interest]).toBeUndefined();
    },
  );

  it("passes only available traces to synthesis and names missing domains", () => {
    const root = fixture();
    fs.rmSync(path.join(root, specialistSessionFileName("documentation")));
    const turn = buildSynthesisTurn(validateSpecialistSessionDirectory(root));

    expect(turn.prompt).not.toContain(specialistSessionFileName("documentation"));
    expect(turn.prompt).toContain("documentation: specialist trace unavailable");
    expect(turn.prompt).toContain("explicit review-completeness limitation");
  });

  it("requires complete contiguous ordinary-read coverage before synthesis text", () => {
    const turn = buildSynthesisTurn(validateSpecialistSessionDirectory(fixture()));
    const tools = resolveAdvisorTurnTools(turn, [], new Set(["read", "grep", "find", "ls"]));
    const paths = turn.requiredReadPaths ?? [];
    const read = (
      readPath: string,
      offset: number,
      endOffset: number | null,
      reachesEnd: boolean,
    ) => ({
      type: "read" as const,
      path: readPath,
      offset,
      endOffset,
      fileSize: 256,
      reachesEnd,
    });
    const complete = paths.map((readPath) => read(readPath, 1, null, true));
    const receipt = { type: "text" as const, text: "receipt" };

    expect(advisorTurnFlowErrors("synthesize", [...complete, receipt], tools)).toEqual([]);
    const incompleteError = `synthesize incompletely read required path: ${paths[0]}`;
    expect(
      advisorTurnFlowErrors(
        "synthesize",
        [read(paths[0]!, 1, 1, false), ...complete.slice(1), receipt],
        tools,
      ),
    ).toContain(incompleteError);
    expect(
      advisorTurnFlowErrors(
        "synthesize",
        [read(paths[0]!, 1, 10, false), ...complete.slice(1), receipt],
        tools,
      ),
    ).toContain(incompleteError);
    expect(
      advisorTurnFlowErrors(
        "synthesize",
        [
          read(paths[0]!, 1, 10, false),
          read(paths[0]!, 12, null, true),
          ...complete.slice(1),
          receipt,
        ],
        tools,
      ),
    ).toContain(incompleteError);
    expect(
      advisorTurnFlowErrors(
        "synthesize",
        [
          read(paths[0]!, 1, 10, false),
          receipt,
          read(paths[0]!, 11, null, true),
          ...complete.slice(1),
        ],
        tools,
      ),
    ).toContain(`synthesize emitted text before required read completed: ${paths[0]}`);
    expect(
      advisorTurnFlowErrors(
        "synthesize",
        [
          read(paths[0]!, 1, 10, false),
          read(paths[0]!, 11, null, true),
          ...complete.slice(1),
          receipt,
        ],
        tools,
      ),
    ).toEqual([]);
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

  it("rejects a malformed present optional session", () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, specialistSessionFileName("operations")), "{\n");
    expect(() => validateSpecialistSessionDirectory(root)).toThrow(/invalid JSONL/u);
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
