// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createOnboardProcessWorkspace,
  minimalSpawnEnv,
  runOnboardProcessAsync,
} from "./onboard-child-process-harness";

const keepAlive = `
  process.on("SIGTERM", () => {});
  process.stdout.write("started\\n", () => {
    require("node:fs").writeFileSync("child.pid", String(process.pid));
  });
  setInterval(() => {}, 1000);
`;

describe("asynchronous onboarding process fixtures", () => {
  it("overlaps isolated children while preserving output and nonzero exit status", async (context) => {
    const workspace = createOnboardProcessWorkspace("nemoclaw-async-process-overlap-");
    context.onTestFinished(workspace.remove);
    const result = await Promise.all(
      [0, 7].map((exitCode, index) =>
        runOnboardProcessAsync(
          [
            "-e",
            `const fs = require("node:fs");
             fs.writeFileSync("ready-" + process.env.CASE, "ready");
             const timer = setInterval(() => {
               if (!fs.existsSync("ready-" + process.env.PEER)) return;
               clearInterval(timer);
               process.stdout.write(process.env.CASE + ":π🚀");
               process.stderr.write("diagnostic-" + process.env.CASE);
               process.exitCode = Number(process.env.EXIT_CODE);
             }, 10);`,
          ],
          {
            cwd: workspace.root,
            env: minimalSpawnEnv(workspace.homeDir, {
              CASE: String(index),
              PEER: String(1 - index),
              EXIT_CODE: String(exitCode),
            }),
            timeoutMs: 5_000,
            context,
          },
        ),
      ),
    );

    expect(result.map(({ status }) => status)).toEqual([0, 7]);
    expect(result.map(({ signal }) => signal)).toEqual([null, null]);
    expect(result.map(({ output }) => output)).toEqual([
      "0:π🚀\ndiagnostic-0",
      "1:π🚀\ndiagnostic-1",
    ]);
  });

  it("returns a launch error when the working directory is missing", async (context) => {
    const workspace = createOnboardProcessWorkspace("nemoclaw-async-process-missing-");
    context.onTestFinished(workspace.remove);
    const result = await runOnboardProcessAsync(["-e", "process.exit(0)"], {
      cwd: workspace.path("missing"),
      env: minimalSpawnEnv(workspace.homeDir),
      timeoutMs: 5_000,
      context,
    });

    expect(result.status).toBeNull();
    expect(result.error).toMatchObject({ code: "ENOENT" });
    expect(result.stdout).toBe("");
  });

  it.for([
    { mode: "timeout", timeoutMs: 2_000, cancel: (_controller: AbortController) => undefined },
    {
      mode: "abort",
      // Exceed the test limit so a broken abort cannot pass via the process timeout.
      timeoutMs: 30_000,
      cancel: (controller: AbortController) => controller.abort(),
    },
  ])(
    "closes a child that ignores SIGTERM after $mode",
    { timeout: 10_000 },
    async ({ timeoutMs, cancel }, context) => {
      const workspace = createOnboardProcessWorkspace("nemoclaw-async-process-cancel-");
      context.onTestFinished(workspace.remove);
      const controller = new AbortController();
      const running = runOnboardProcessAsync(["-e", keepAlive], {
        cwd: workspace.root,
        env: minimalSpawnEnv(workspace.homeDir),
        timeoutMs,
        context: { signal: controller.signal, onTestFinished: context.onTestFinished },
      });
      await vi.waitFor(() => expect(fs.existsSync(workspace.path("child.pid"))).toBe(true), {
        timeout: 5_000,
      });
      const pid = Number(fs.readFileSync(workspace.path("child.pid"), "utf8"));
      cancel(controller);
      const result = await running;

      expect(result.status).toBeNull();
      expect(result.signal).toBe("SIGKILL");
      expect(result.error).toBeInstanceOf(Error);
      expect(result.stdout).toContain("started");
      expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
    },
  );

  it("does not launch a child after its test is cancelled", async (context) => {
    const workspace = createOnboardProcessWorkspace("nemoclaw-async-process-pre-abort-");
    context.onTestFinished(workspace.remove);
    const controller = new AbortController();
    const reason = new Error("fixture test cancelled");
    controller.abort(reason);

    await expect(
      runOnboardProcessAsync(["-e", keepAlive], {
        cwd: workspace.root,
        env: minimalSpawnEnv(workspace.homeDir),
        timeoutMs: 5_000,
        context: { signal: controller.signal, onTestFinished: context.onTestFinished },
      }),
    ).rejects.toBe(reason);
    expect(fs.existsSync(workspace.path("child.pid"))).toBe(false);
  });

  it("fails when a child exceeds the native output limit", async (context) => {
    const result = await runOnboardProcessAsync(
      ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000)"],
      { env: minimalSpawnEnv(process.cwd()), timeoutMs: 5_000, context },
    );

    expect(result.status).toBeNull();
    expect(result.error).toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024 * 1024);
  });
});
