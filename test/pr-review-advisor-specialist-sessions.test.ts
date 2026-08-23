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
    expect(inventory.available).toEqual(ADVISOR_INTERESTS);
  });

  it.each(ADVISOR_INTERESTS)("rejects a missing required %s session", (interest) => {
    const root = fixture();
    fs.rmSync(path.join(root, specialistSessionFileName(interest)));
    expect(() => validateSpecialistSessionDirectory(root)).toThrow(
      new RegExp(`Missing required specialist session: ${interest}`, "u"),
    );
  });

  it("lets synthesis inspect available traces with read-only tools", () => {
    const root = fixture();
    const turn = buildSynthesisTurn(validateSpecialistSessionDirectory(root));

    expect(turn.activeToolNames).toEqual(["read", "grep", "find", "ls"]);
    expect(turn.requiredReadPaths).toBeUndefined();
    const tools = resolveAdvisorTurnTools(turn, [], new Set(["read", "grep", "find", "ls"]));
    const receipt = { type: "text" as const, text: "receipt" };
    expect(advisorTurnFlowErrors("synthesize", [receipt], tools)).toContain(
      "synthesize omitted specialist evidence read",
    );
    expect(
      advisorTurnFlowErrors(
        "synthesize",
        [
          {
            type: "read",
            path: turn.requiredReadOneOfPaths![0]!,
            offset: 1,
            endOffset: 20,
            fileSize: 1000,
            reachesEnd: false,
          },
          receipt,
        ],
        tools,
      ),
    ).toEqual([]);
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

  it.each(["behavior", "operations"] as const)(
    "accepts a native %s trace with a large message line",
    (interest) => {
      const root = fixture();
      fs.appendFileSync(
        path.join(root, specialistSessionFileName(interest)),
        JSON.stringify({ type: "message", body: "x".repeat(51 * 1024) }) + "\n",
      );

      expect(validateSpecialistSessionDirectory(root).available).toEqual(ADVISOR_INTERESTS);
    },
  );

  it("rejects non-Pi headers", () => {
    const invalidHeader = fixture();
    fs.writeFileSync(path.join(invalidHeader, specialistSessionFileName("documentation")), "{}\n");
    expect(() => validateSpecialistSessionDirectory(invalidHeader)).toThrow(
      /valid Pi session header/u,
    );
  });
});
