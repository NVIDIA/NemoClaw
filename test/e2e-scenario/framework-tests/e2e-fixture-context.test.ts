// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ArtifactSink } from "../framework/artifacts.ts";
import { CleanupRegistry } from "../framework/cleanup.ts";
import { test as e2eTest } from "../framework/e2e-test.ts";
import { SecretStore } from "../framework/secrets.ts";

describe("E2E fixture primitives", () => {
  it("artifact sink writes under its root and rejects traversal", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-artifacts-"));
    try {
      const artifacts = new ArtifactSink(tmp);
      await artifacts.ensureRoot();
      const written = await artifacts.writeText("nested/output.txt", "ok");
      expect(fs.readFileSync(written, "utf8")).toBe("ok");
      expect(() => artifacts.pathFor("../escape.txt")).toThrow(/escapes root/);
      expect(() => artifacts.pathFor(path.join(tmp, "absolute.txt"))).toThrow(/must be relative/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("cleanup registry runs callbacks in reverse order", async () => {
    const cleanup = new CleanupRegistry();
    const order: string[] = [];
    cleanup.add("first", () => {
      order.push("first");
    });
    cleanup.add("second", () => {
      order.push("second");
    });

    const result = await cleanup.runAll();
    expect(order).toEqual(["second", "first"]);
    expect(result).toEqual({ passed: ["second", "first"], failures: [] });
  });

  it("secret store redacts sensitive env values and skips missing required secrets", () => {
    const store = new SecretStore(
      { NVIDIA_API_KEY: "nv-secret", PLAIN_VALUE: "visible" },
      (note?: string): never => {
        throw new Error(note ?? "skipped");
      },
    );

    expect(store.optional("PLAIN_VALUE")).toBe("visible");
    expect(store.redact("token=nv-secret plain=visible")).toBe("token=[REDACTED] plain=visible");
    expect(() => store.required("MISSING_SECRET")).toThrow(/missing required E2E secret/);
  });
});

e2eTest("fixture context captures redacted shell artifacts", async ({
  artifacts,
  cleanup,
  shellProbe,
}) => {
  const marker = await artifacts.writeText("context.txt", "fixture-ready");
  cleanup.add("write cleanup marker", async () => {
    await artifacts.writeText("cleanup-marker.txt", "done");
  });

  const secret = "shell-probe-secret-value";
  const result = await shellProbe.run(process.execPath, {
    args: [
      "-e",
      "console.log(process.env.NEMOCLAW_TEST_TOKEN); console.error(process.argv[1]);",
      secret,
    ],
    artifactName: "redaction-proof",
    env: { NEMOCLAW_TEST_TOKEN: secret },
    redactionValues: [secret],
    timeoutMs: 5_000,
  });

  expect(fs.readFileSync(marker, "utf8")).toBe("fixture-ready");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("[REDACTED]");
  expect(result.stderr).toContain("[REDACTED]");
  expect(result.stdout).not.toContain(secret);
  expect(result.stderr).not.toContain(secret);
  expect(fs.readFileSync(result.artifacts.result, "utf8")).not.toContain(secret);
});
