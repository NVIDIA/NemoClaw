// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { directDockerfileCopySources } from "../../../scripts/lib/dockerfile-copy-sources.mts";
import {
  catalogueTarget,
  catalogueTargetsForChangedFiles,
} from "../../../tools/e2e/target-catalogue.mts";
import { REPO_ROOT } from "../fixtures/paths.ts";

import {
  buildPiReadTask,
  parsePiJsonEvents,
  parsePiInferenceEvidence,
  qualifyPiReadTask,
} from "../live/pi-agent-qualification-events.ts";

const PATH = "/sandbox/pi-qualification.txt";
const TOKEN = "NEMOCLAW_PI_TASK_V1_0123456789ABCDEF";

function eventStream(overrides: Record<string, unknown> = {}): string {
  return [
    { type: "agent_start" },
    {
      type: "tool_execution_start",
      toolCallId: "call-read",
      toolName: "read",
      args: { path: PATH },
      ...overrides,
    },
    {
      type: "tool_execution_end",
      toolCallId: "call-read",
      toolName: "read",
      result: { content: TOKEN },
      isError: false,
    },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: TOKEN }] },
    },
    { type: "agent_end", messages: [], willRetry: false },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
}

function events(...values: Record<string, unknown>[]): string {
  return values.map((event) => JSON.stringify(event)).join("\n");
}

function runReadTaskSeed(root: string, seedScript: string) {
  const script = path.join(root, "seed.sh");
  fs.writeFileSync(script, `sync() { :; }\n${seedScript}`);
  return spawnSync("bash", ["--noprofile", "--norc", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, BASH_ENV: "", ENV: "" },
    timeout: 2_000,
  });
}

describe("Pi qualification task construction", () => {
  it.each(["before-rebuild", "after-rebuild", "after-recovery"])(
    "constructs a context-free headless read for %s",
    (phase) => {
      const taskName = `pi-read-v2-${phase}`;
      const task = buildPiReadTask("pi-qual", "/sandbox/task root/workspace", taskName, TOKEN);

      expect(task.remotePath).toBe("/sandbox/task root/workspace/task.txt");
      expect(task.argv).toEqual([
        "pi-qual",
        "exec",
        "--workdir",
        "/sandbox/task root/workspace",
        "--no-tty",
        "--timeout",
        "300",
        "--",
        "pi",
        "--no-approve",
        "--no-context-files",
        "--mode",
        "json",
        "--print",
        "--tools",
        "read",
        "--name",
        taskName,
        "Use the read tool exactly once to read /sandbox/task root/workspace/task.txt. Reply with exactly the file contents and no other text.",
      ]);
    },
  );

  it("seeds quoted task contents and both private context files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pi-read-task-"));
    const workdir = path.join(root, "workspace 'quoted'");
    const token = "literal 'quotes' and $HOME";

    try {
      const task = buildPiReadTask("pi-qual", workdir, "pi-read-v2-before-rebuild", token);
      const result = runReadTaskSeed(root, task.seedScript);

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(task.remotePath, "utf8")).toBe(`${token}\n`);
      const parentContext = path.join(root, "AGENTS.md");
      const projectContext = path.join(workdir, "CLAUDE.md");
      const context = fs.readFileSync(parentContext, "utf8");
      expect(context).toContain("NEMOCLAW_PI_UNTRUSTED_CONTEXT");
      expect(fs.readFileSync(projectContext, "utf8")).toBe(context);
      expect(fs.statSync(task.remotePath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(parentContext).mode & 0o777).toBe(0o600);
      expect(fs.statSync(projectContext).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops seeding when the workspace cannot be created", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pi-read-task-"));
    const workdir = path.join(root, "workspace");

    try {
      fs.writeFileSync(workdir, "occupied");
      const task = buildPiReadTask("pi-qual", workdir, "pi-read-v2-before-rebuild", TOKEN);
      const result = runReadTaskSeed(root, task.seedScript);

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(fs.readFileSync(workdir, "utf8")).toBe("occupied");
      expect(fs.existsSync(path.join(root, "AGENTS.md"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Pi qualification event oracle", () => {
  it("keeps every Pi image source in the AMD64 lifecycle target ownership boundary (#7926)", () => {
    const imageSources = new Set([
      ".dockerignore",
      ...["agents/pi/Dockerfile", "agents/pi/Dockerfile.base"].flatMap((dockerfile) =>
        directDockerfileCopySources(path.join(REPO_ROOT, dockerfile), dockerfile).map(
          ({ source }) => {
            const normalized = source.replace(/\/+$/u, "");
            return normalized.startsWith("agents/pi/") ? "agents/pi" : normalized;
          },
        ),
      ),
    ]);
    const target = catalogueTarget("pi-agent-qualification-amd64");
    const uncovered = [...imageSources].filter(
      (source) =>
        !target.owningPaths.some((owner) => {
          const normalizedOwner = owner.replace(/\/$/u, "");
          return source === normalizedOwner || source.startsWith(`${normalizedOwner}/`);
        }),
    );

    expect(uncovered, `${target.id} must own every Pi Docker COPY input`).toEqual([]);
  });

  it("selects only AMD64 lifecycle qualification for a copied Pi image source (#7926)", () => {
    const targetIds = catalogueTargetsForChangedFiles([
      "nemoclaw-blueprint/scripts/nemotron-inference-fix.js",
    ]).map((target) => target.id);

    expect(targetIds).toContain("pi-agent-qualification-amd64");
    expect(targetIds).not.toContain("pi-agent-qualification-arm64");
  });

  it("accepts one successful read and an exact final response", () => {
    const events = parsePiJsonEvents(eventStream());

    expect(qualifyPiReadTask(events, PATH, TOKEN)).toEqual({
      assistantText: TOKEN,
      eventCount: 5,
      toolCallId: "call-read",
    });
  });

  it("rejects malformed JSON, another tool, a failed read, and altered output", () => {
    expect(() => parsePiJsonEvents("not-json\n")).toThrow();
    expect(() =>
      qualifyPiReadTask(parsePiJsonEvents(eventStream({ toolName: "bash" })), PATH, TOKEN),
    ).toThrow("exact read tool call");
    expect(() =>
      qualifyPiReadTask(
        parsePiJsonEvents(eventStream().replace('"isError":false', '"isError":true')),
        PATH,
        TOKEN,
      ),
    ).toThrow("did not complete successfully");
    expect(() => qualifyPiReadTask(parsePiJsonEvents(eventStream()), PATH, `${TOKEN}X`)).toThrow(
      "instead of exact file contents",
    );
  });

  it("rejects missing, extra, or mismatched read events", () => {
    const valid = parsePiJsonEvents(eventStream());
    expect(() =>
      qualifyPiReadTask(
        valid.filter((event) => event.type !== "tool_execution_end"),
        PATH,
        TOKEN,
      ),
    ).toThrow("did not complete successfully");
    expect(() =>
      qualifyPiReadTask([...valid, { ...valid[1], toolCallId: "second-read" }], PATH, TOKEN),
    ).toThrow("must start exactly one tool");
    expect(() =>
      qualifyPiReadTask(
        [...valid, { ...valid[2], toolCallId: "unmatched-completion" }],
        PATH,
        TOKEN,
      ),
    ).toThrow("did not complete successfully");
    expect(() =>
      qualifyPiReadTask(
        parsePiJsonEvents(eventStream({ args: { path: "/sandbox/other" } })),
        PATH,
        TOKEN,
      ),
    ).toThrow("exact read tool call");
  });

  it("rejects an early or duplicate completion for the read call", () => {
    const start = {
      type: "tool_execution_start",
      toolCallId: "call-read",
      toolName: "read",
      args: { path: PATH },
    };
    const success = {
      type: "tool_execution_end",
      toolCallId: "call-read",
      toolName: "read",
      result: { content: TOKEN },
      isError: false,
    };
    const failure = { ...success, isError: true };
    const reply = {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: TOKEN }] },
    };

    expect(() =>
      qualifyPiReadTask(parsePiJsonEvents(events(success, start, failure, reply)), PATH, TOKEN),
    ).toThrow("did not complete successfully");
    expect(() =>
      qualifyPiReadTask(parsePiJsonEvents(events(start, success, success, reply)), PATH, TOKEN),
    ).toThrow("did not complete successfully");
    expect(() =>
      qualifyPiReadTask(parsePiJsonEvents(events(start, reply, success)), PATH, TOKEN),
    ).toThrow("after the read completed");
  });

  it("accepts the managed Pi inference route", () => {
    expect(
      parsePiInferenceEvidence(
        JSON.stringify({
          providers: {
            openshell: {
              api: "openai-completions",
              baseUrl: "https://inference.local/v1",
              models: [{ id: "nvidia/test-model" }],
            },
          },
        }),
        "nvidia/test-model",
      ),
    ).toEqual({
      api: "openai-completions",
      model: "nvidia/test-model",
      route: "https://inference.local/v1",
    });
  });

  it("rejects missing or inconsistent Pi qualification evidence", () => {
    expect(() => parsePiInferenceEvidence("{}", "nvidia/test-model")).toThrow(
      "Pi managed inference providers must be an object",
    );
    expect(() =>
      parsePiInferenceEvidence(
        JSON.stringify({
          providers: {
            openshell: {
              api: "openai-completions",
              baseUrl: "https://inference.local/v1",
              models: [{ id: "nvidia/other-model" }],
            },
          },
        }),
        "nvidia/test-model",
      ),
    ).toThrow("does not match the qualified route");
  });
});
