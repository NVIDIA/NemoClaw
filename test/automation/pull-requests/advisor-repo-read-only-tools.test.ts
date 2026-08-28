// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalRepoReadPath,
  createRepoConfinedReadOnlyTools,
  MAX_ADVISOR_TOOL_RESULT_JSON_BYTES,
} from "../../../tools/advisors/repo-read-only-tools.mts";

const tempDirs: string[] = [];
const PI_SESSION_READ_LINE_LIMIT_BYTES = 50 * 1024;
let workspace: string;
let outside: string;
let tools: Map<string, ToolDefinition>;

const toolInputs: Record<string, (target: string) => Record<string, unknown>> = {
  read: (target) => ({ path: target }),
  grep: (target) => ({ pattern: "needle", path: target, literal: true }),
  find: (target) => ({ pattern: "*", path: target }),
  ls: (target) => ({ path: target }),
};
const piUnicodeSpaces = [
  ["U+00A0", "\u00A0"],
  ["U+2000", "\u2000"],
  ["U+2001", "\u2001"],
  ["U+2002", "\u2002"],
  ["U+2003", "\u2003"],
  ["U+2004", "\u2004"],
  ["U+2005", "\u2005"],
  ["U+2006", "\u2006"],
  ["U+2007", "\u2007"],
  ["U+2008", "\u2008"],
  ["U+2009", "\u2009"],
  ["U+200A", "\u200A"],
  ["U+202F", "\u202F"],
  ["U+205F", "\u205F"],
  ["U+3000", "\u3000"],
] as const;

async function execute(name: string, input: Record<string, unknown>) {
  return tools
    .get(name)!
    .execute("test-call", input as never, undefined, undefined, undefined as never);
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-workspace-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-outside-"));
  tempDirs.push(workspace, outside);
  fs.writeFileSync(path.join(workspace, "safe.txt"), "safe needle\n", "utf8");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret needle\n", "utf8");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "escaped-file"));
  fs.symlinkSync(outside, path.join(workspace, "escaped-directory"), "dir");
  tools = new Map(createRepoConfinedReadOnlyTools(workspace).map((tool) => [tool.name, tool]));
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("repo-confined advisor read-only tools", () => {
  it.each([
    "read",
    "grep",
    "find",
    "ls",
  ])("rejects an absolute outside path through %s (#6446)", async (name) => {
    await expect(execute(name, toolInputs[name]!(outside))).rejects.toThrow(
      "outside the workspace",
    );
  });

  it.each([
    ["read", "escaped-file"],
    ["grep", "escaped-directory"],
    ["find", "escaped-directory"],
    ["ls", "escaped-directory"],
  ])("rejects a symlink escape through %s (#6446)", async (name, target) => {
    await expect(execute(name, toolInputs[name]!(target))).rejects.toThrow(
      "resolves outside the workspace",
    );
  });

  it("rejects the proc environment path before the SDK can read it (#6446)", async () => {
    await expect(execute("read", { path: "/proc/self/environ" })).rejects.toThrow(
      "outside the workspace",
    );
  });

  it.each([
    ["read", "@/proc/self/environ"],
    ["ls", "~/advisor-private-file"],
  ])("rejects the SDK %s path alias %s before delegation (#6446)", async (name, target) => {
    await expect(execute(name, toolInputs[name]!(target))).rejects.toThrow("outside the workspace");
  });

  it("rejects a relative parent traversal before delegation (#6446)", async () => {
    const traversal = path.relative(workspace, path.join(outside, "secret.txt"));
    await expect(execute("read", { path: traversal })).rejects.toThrow("outside the workspace");
  });

  it.each(
    piUnicodeSpaces,
  )("normalizes the Pi SDK %s space before guarding read (#6446)", async (_codePoint, unicodeSpace) => {
    const unicodePath = `safe${unicodeSpace}target`;
    fs.writeFileSync(path.join(workspace, unicodePath), "safe\n", "utf8");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "safe target"));

    await expect(execute("read", { path: unicodePath })).rejects.toThrow(
      "resolves outside the workspace",
    );
  });

  it.each([
    "grep",
    "find",
    "ls",
  ])("normalizes Unicode spaces before guarding a %s directory root (#6446)", async (name) => {
    fs.mkdirSync(path.join(workspace, "safe\u00A0directory"));
    fs.symlinkSync(outside, path.join(workspace, "safe directory"), "dir");

    await expect(execute(name, toolInputs[name]!("safe\u00A0directory"))).rejects.toThrow(
      "resolves outside the workspace",
    );
  });

  it("rejects a canonical file target changed by Pi SDK normalization (#6446)", async () => {
    fs.writeFileSync(path.join(workspace, "safe\u00A0target"), "safe\n", "utf8");
    fs.symlinkSync(path.join(workspace, "safe\u00A0target"), path.join(workspace, "safe-link"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "safe target"));

    await expect(execute("read", { path: "safe-link" })).rejects.toThrow(
      "not stable under Pi SDK normalization",
    );
  });

  it.each([
    "grep",
    "find",
    "ls",
  ])("rejects a canonical %s directory target changed by Pi SDK normalization (#6446)", async (name) => {
    fs.mkdirSync(path.join(workspace, "safe\u00A0directory"));
    fs.symlinkSync(
      path.join(workspace, "safe\u00A0directory"),
      path.join(workspace, "safe-link"),
      "dir",
    );
    fs.symlinkSync(outside, path.join(workspace, "safe directory"), "dir");

    await expect(execute(name, toolInputs[name]!("safe-link"))).rejects.toThrow(
      "not stable under Pi SDK normalization",
    );
  });

  it("reports ordinary read ranges and file size (#9949)", async () => {
    fs.writeFileSync(path.join(workspace, "ranges.txt"), "one\ntwo\nthree\n", "utf8");
    const realPath = fs.realpathSync(path.join(workspace, "ranges.txt"));
    const observations: Parameters<
      NonNullable<Parameters<typeof createRepoConfinedReadOnlyTools>[1]>
    >[0][] = [];
    tools = new Map(
      createRepoConfinedReadOnlyTools(workspace, (observation) => observations.push(observation)).map(
        (tool) => [tool.name, tool],
      ),
    );

    await execute("read", { path: "ranges.txt", offset: 1, limit: 2 });
    await execute("read", { path: "ranges.txt", offset: 3 });

    expect(observations).toEqual([
      { path: realPath, offset: 1, endOffset: 2, fileSize: 14, reachesEnd: false },
      { path: realPath, offset: 3, endOffset: null, fileSize: 14, reachesEnd: true },
    ]);
  });

  it("keeps escaped read results within the specialist session line limit (#9949)", async () => {
    const lineCount = 40;
    const escapedLine = `const value = ${JSON.stringify('\\"'.repeat(96))};`;
    fs.writeFileSync(
      path.join(workspace, "escaped-read.txt"),
      `${Array.from({ length: lineCount }, () => escapedLine).join("\n")}\n`,
      "utf8",
    );
    const observations: Parameters<
      NonNullable<Parameters<typeof createRepoConfinedReadOnlyTools>[1]>
    >[0][] = [];
    tools = new Map(
      createRepoConfinedReadOnlyTools(workspace, (observation) => observations.push(observation)).map(
        (tool) => [tool.name, tool],
      ),
    );

    const first = await execute("read", { path: "escaped-read.txt", offset: 1 });
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(
      MAX_ADVISOR_TOOL_RESULT_JSON_BYTES,
    );
    expect(
      Buffer.byteLength(
        JSON.stringify({
          type: "message",
          id: "result-1",
          parentId: "call-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: first.content,
            details: first.details,
            isError: false,
          },
        }),
        "utf8",
      ),
    ).toBeLessThanOrEqual(PI_SESSION_READ_LINE_LIMIT_BYTES);
    const firstTruncation = (
      first.details as { truncation?: { truncated: boolean; outputLines: number } } | undefined
    )?.truncation;
    expect(firstTruncation?.truncated).toBe(true);
    expect(firstTruncation?.outputLines).toBeGreaterThan(0);
    const nextOffset = 1 + (firstTruncation?.outputLines ?? 0);
    expect((first.content[0] as { text: string }).text).toContain(
      `Use offset=${nextOffset} to continue`,
    );

    const second = await execute("read", { path: "escaped-read.txt", offset: nextOffset });
    expect(Buffer.byteLength(JSON.stringify(second), "utf8")).toBeLessThanOrEqual(
      MAX_ADVISOR_TOOL_RESULT_JSON_BYTES,
    );
    expect(
      Buffer.byteLength(
        JSON.stringify({
          type: "message",
          id: "result-2",
          parentId: "call-2",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-2",
            toolName: "read",
            content: second.content,
            details: second.details,
            isError: false,
          },
        }),
        "utf8",
      ),
    ).toBeLessThanOrEqual(PI_SESSION_READ_LINE_LIMIT_BYTES);

    expect(observations.at(-1)?.reachesEnd).toBe(true);
    expect(observations.at(-1)?.endOffset).toBeNull();
  });

  it("uses one canonical path for configured and observed reads", async () => {
    fs.writeFileSync(path.join(workspace, "required.txt"), "required\n", "utf8");
    const observations: Parameters<
      NonNullable<Parameters<typeof createRepoConfinedReadOnlyTools>[1]>
    >[0][] = [];
    tools = new Map(
      createRepoConfinedReadOnlyTools(workspace, (observation) => observations.push(observation)).map(
        (tool) => [tool.name, tool],
      ),
    );

    const configuredPath = await canonicalRepoReadPath(workspace, "required.txt");
    await execute("read", { path: "required.txt" });

    expect(configuredPath).toBe(fs.realpathSync(path.join(workspace, "required.txt")));
    expect(observations[0]?.path).toBe(configuredPath);
  });

  it("keeps ordinary read, grep, find, and ls behavior inside the workspace (#6446)", async () => {
    await expect(execute("read", { path: "safe.txt" })).resolves.toMatchObject({
      content: [{ type: "text", text: "safe needle\n" }],
    });
    await expect(
      execute("grep", { pattern: "needle", path: ".", literal: true }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("safe.txt") }],
    });
    await expect(execute("find", { pattern: "*.txt", path: "." })).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("safe.txt") }],
    });
    const listing = await execute("ls", { path: "." });
    expect(listing).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("safe.txt") }],
    });
    expect((listing.content[0] as { text: string }).text).not.toContain("escaped-");
  });

  it("does not traverse outside symlinks while searching the workspace (#6446)", async () => {
    await expect(
      execute("grep", { pattern: "secret", path: ".", literal: true }),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "No matches found" }] });
    await expect(execute("find", { pattern: "secret.txt", path: "." })).resolves.toMatchObject({
      content: [{ type: "text", text: "No files found matching pattern" }],
    });
  });
});
