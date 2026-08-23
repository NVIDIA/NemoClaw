// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import {
  advisorTurnFlowErrors,
  resolveAdvisorTurnTools,
  seedRequiredReadHistory,
  seededReadFlowForTurn,
} from "../tools/advisors/session.mts";
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
  it("seeds complete ordinary reads into genuine Pi history", async () => {
    const root = fixture();
    const requiredPath = path.join(root, specialistSessionFileName("behavior"));
    const offsets: number[] = [];
    const readTool = {
      name: "read",
      label: "read",
      description: "Read a test trace",
      parameters: { type: "object", properties: {} } as ToolDefinition["parameters"],
      async execute(_toolCallId: string, input: { path: string; offset?: number }) {
        offsets.push(input.offset ?? 1);
        const first = input.offset === undefined;
        return {
          content: [{ type: "text" as const, text: first ? "first page" : "last page" }],
          details: first
            ? { truncation: { truncated: true, outputLines: 2 } }
            : { truncation: { truncated: false, outputLines: 1 } },
        };
      },
    } as ToolDefinition;
    const manager = SessionManager.inMemory(root);

    const seeded = await seedRequiredReadHistory(manager, readTool, [requiredPath], {
      api: "openai-completions",
      provider: "azure",
      id: "test-model",
    });

    expect(offsets).toEqual([1, 3]);
    expect(seeded.flow).toEqual([
      expect.objectContaining({ path: requiredPath, offset: 1, endOffset: 2, reachesEnd: false }),
      expect.objectContaining({ path: requiredPath, offset: 3, endOffset: 3, reachesEnd: true }),
    ]);
    expect(manager.buildSessionContext().messages).toEqual([
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({
        role: "assistant",
        content: [expect.objectContaining({ type: "toolCall", name: "read" })],
      }),
      expect.objectContaining({ role: "toolResult", toolName: "read", isError: false }),
      expect.objectContaining({
        role: "assistant",
        content: [expect.objectContaining({ arguments: { path: requiredPath, offset: 3 } })],
      }),
      expect.objectContaining({ role: "toolResult", toolName: "read", isError: false }),
    ]);
  });

  it("does not reuse seeded reads in a later turn with the same path", () => {
    const requiredPath = path.join(fixture(), specialistSessionFileName("behavior"));
    const seededFlow = [
      {
        type: "read" as const,
        path: requiredPath,
        offset: 1,
        endOffset: null,
        fileSize: 1,
        reachesEnd: true,
      },
    ];
    const seededTurn = {
      name: "seeded",
      prompt: "seeded",
      requiredReadPaths: [requiredPath],
      seedRequiredReads: true,
    };
    const laterTurn = {
      name: "later",
      prompt: "later",
      requiredReadPaths: [requiredPath],
      requireAssistantText: true,
    };

    expect(seededReadFlowForTurn(seededTurn, seededFlow)).toEqual(seededFlow);
    expect(seededReadFlowForTurn(laterTurn, seededFlow)).toEqual([]);
    expect(
      advisorTurnFlowErrors("later", [{ type: "text", text: "analysis" }], {
        activeToolNames: ["read"],
        requiredToolNames: [],
        requireToolsBeforeText: [],
        requiredReadPaths: [requiredPath],
        requireAssistantText: true,
      }),
    ).toContain(`later omitted required read: ${requiredPath}`);
  });

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

  it("validates the complete reads already present before synthesis text", () => {
    const turn = buildSynthesisTurn(validateSpecialistSessionDirectory(fixture()));
    const tools = resolveAdvisorTurnTools(turn, [], new Set(["read", "grep", "find", "ls"]));
    const paths = turn.requiredReadPaths ?? [];
    expect(turn.activeToolNames).toEqual(["read", "grep", "find", "ls"]);
    expect(turn.seedRequiredReads).toBe(true);
    expect(turn.prompt).toContain("Pi session already contains complete ordinary `read` calls");
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
    const toolCall = (toolName: string) => [
      { type: "tool_start" as const, toolName },
      { type: "tool_end" as const, toolName, isError: false },
    ];

    expect(advisorTurnFlowErrors("synthesize", [...complete, receipt], tools)).toEqual([]);
    expect(
      ["grep", "find", "ls", "other_tool"].map((toolName) =>
        advisorTurnFlowErrors(
          "synthesize",
          [read(paths[0]!, 1, 10, false), ...toolCall(toolName), ...complete, receipt],
          tools,
        ),
      ),
    ).toEqual(
      ["grep", "find", "ls", "other_tool"].map((toolName) =>
        expect.arrayContaining([`synthesize called ${toolName} before required reads completed`]),
      ),
    );
    expect(
      advisorTurnFlowErrors(
        "synthesize",
        [...complete, ...["grep", "find", "ls"].flatMap(toolCall), receipt],
        tools,
      ),
    ).toEqual([]);
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

  it("rejects a trace line that ordinary read cannot return", () => {
    const root = fixture();
    fs.appendFileSync(
      path.join(root, specialistSessionFileName("documentation")),
      JSON.stringify({ type: "message", body: "x".repeat(51 * 1024) }) + "\n",
    );
    expect(() => validateSpecialistSessionDirectory(root)).toThrow(/ordinary read limit/u);
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
