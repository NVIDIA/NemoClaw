// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import { ArtifactSink, createArtifactSink } from "../fixtures/artifacts.ts";
import { assertCleanupPassed, CleanupRegistry } from "../fixtures/cleanup.ts";
import { test as e2eTest } from "../fixtures/e2e-test.ts";
import { SecretStore } from "../fixtures/secrets.ts";
import {
  ShellProbe,
  trustedShellCommand,
  type TrustedShellCommand,
} from "../fixtures/shell-probe.ts";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function expectProcessToExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await delay(25);
  }
  throw new Error(`process ${pid} was still alive after ${timeoutMs}ms`);
}

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

  it("live scenario artifacts match the workflow upload allowlist paths", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-live-artifacts-"));
    const previousArtifactDir = process.env.E2E_ARTIFACT_DIR;
    const scenarioId = "ubuntu-repo-cloud-openclaw";
    const artifactParent = path.join(tmp, "e2e-artifacts", "vitest");
    const allowlistedFiles = [
      "run-plan.json",
      "scenario.json",
      "scenario-result.json",
      "environment.result.json",
      "onboarding.result.json",
      "state-validation.result.json",
    ];
    const shellEvidenceFiles = [
      "shell/command-evidence.result.json",
      "shell/command-evidence.stdout.txt",
      "shell/command-evidence.stderr.txt",
    ];

    try {
      process.env.E2E_ARTIFACT_DIR = artifactParent;
      const artifacts = createArtifactSink(scenarioId, tmp);
      await artifacts.ensureRoot();

      expect(artifacts.rootDir).toBe(path.resolve(artifactParent, scenarioId));
      for (const file of allowlistedFiles) {
        await artifacts.writeJson(file, { scenarioId, file });
      }
      const controller = new AbortController();
      const shellProbe = new ShellProbe({
        artifacts,
        redact: (text) => text,
        signal: controller.signal,
      });
      const shellResult = await shellProbe.run(
        trustedShellCommand({
          command: process.execPath,
          args: ["-e", "console.log('shell evidence')"],
          reason: "verify workflow allowlist preserves command evidence",
        }),
        { artifactName: "command-evidence", timeoutMs: 5_000 },
      );

      expect(shellResult.exitCode).toBe(0);

      for (const file of allowlistedFiles) {
        expect(fs.existsSync(path.join(artifactParent, scenarioId, file))).toBe(true);
      }
      for (const file of shellEvidenceFiles) {
        expect(fs.existsSync(path.join(artifactParent, scenarioId, file))).toBe(true);
      }
      expect(
        fs.existsSync(path.join(artifactParent, scenarioId, scenarioId, "run-plan.json")),
      ).toBe(false);
    } finally {
      if (previousArtifactDir === undefined) {
        delete process.env.E2E_ARTIFACT_DIR;
      } else {
        process.env.E2E_ARTIFACT_DIR = previousArtifactDir;
      }
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

  it("cleanup registry redacts failures, continues, and clears callbacks", async () => {
    const secret = "cleanup-secret-value";
    const cleanup = new CleanupRegistry((text) => text.split(secret).join("[REDACTED]"));
    const order: string[] = [];
    cleanup.add("first", () => {
      order.push("first");
    });
    cleanup.add("second", () => {
      order.push("second");
      throw new Error(`failed with ${secret}`);
    });
    cleanup.add(`third-${secret}`, () => {
      order.push("third");
    });

    const result = await cleanup.runAll();
    expect(order).toEqual(["third", "second", "first"]);
    expect(result).toEqual({
      passed: ["third-[REDACTED]", "first"],
      failures: [{ name: "second", message: "failed with [REDACTED]" }],
    });
    expect(() => assertCleanupPassed(result)).toThrow("failed with [REDACTED]");
    expect(() => assertCleanupPassed(result)).not.toThrow(secret);
    expect(await cleanup.runAll()).toEqual({ passed: [], failures: [] });
  });

  it("secret store redacts sensitive env values and skips missing required secrets", () => {
    const canonicalToken = `${"nv"}${"api"}-${"a".repeat(24)}`;
    const store = new SecretStore(
      { NVIDIA_API_KEY: "nv-secret", PLAIN_VALUE: "visible" },
      (note?: string): never => {
        throw new Error(note ?? "skipped");
      },
    );

    expect(store.optional("PLAIN_VALUE")).toBe("visible");
    expect(store.redact("token=nv-secret plain=visible")).toBe("token=[REDACTED] plain=visible");
    expect(store.redact(`printed ${canonicalToken}`)).toContain("<REDACTED>");
    expect(store.redact(`printed ${canonicalToken}`)).not.toContain(canonicalToken);
    expect(() => store.required("MISSING_SECRET")).toThrow(/missing required E2E secret/);
  });

  it("shell probe requires trusted command descriptors", () => {
    expectTypeOf<Parameters<ShellProbe["run"]>[0]>().toEqualTypeOf<TrustedShellCommand>();
    expect(() =>
      trustedShellCommand({
        command: "node",
        reason: "",
      }),
    ).toThrow(/trusted command reason is required/);
    expect(() =>
      trustedShellCommand({
        command: "node",
        args: ["bad\0arg"],
        reason: "validate arguments",
      }),
    ).toThrow(/argument cannot contain NUL bytes/);
  });

  it("shell probe enforces options.redactionValues even when the injected redactor ignores extra values", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-shell-probe-enforce-"));
    try {
      const artifacts = new ArtifactSink(tmp);
      await artifacts.ensureRoot();
      const secret = "redaction-enforced-via-options";
      const controller = new AbortController();
      const probe = new ShellProbe({
        artifacts,
        redact: (text) => text,
        signal: controller.signal,
      });

      const result = await probe.run(
        trustedShellCommand({
          command: process.execPath,
          args: [
            "-e",
            `console.log(${JSON.stringify(secret)}); console.error(${JSON.stringify(secret)});`,
          ],
          reason: "verify ShellProbe enforces redactionValues regardless of injected redactor",
        }),
        {
          artifactName: "options-redaction-enforced",
          redactionValues: [secret],
          timeoutMs: 5_000,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("[REDACTED]");
      expect(result.stderr).toContain("[REDACTED]");
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
      const written = fs.readFileSync(
        artifacts.pathFor("shell/options-redaction-enforced.result.json"),
        "utf8",
      );
      expect(written).not.toContain(secret);
      expect(
        fs.readFileSync(artifacts.pathFor("shell/options-redaction-enforced.stdout.txt"), "utf8"),
      ).not.toContain(secret);
      expect(
        fs.readFileSync(artifacts.pathFor("shell/options-redaction-enforced.stderr.txt"), "utf8"),
      ).not.toContain(secret);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("shell probe scrubs overlapping redactionValues longest-first when the injected redactor ignores extra values", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-shell-probe-overlap-"));
    try {
      const artifacts = new ArtifactSink(tmp);
      await artifacts.ensureRoot();
      const longer = "alpha-beta-gamma-delta";
      const shorter = "alpha";
      const controller = new AbortController();
      const probe = new ShellProbe({
        artifacts,
        redact: (text) => text,
        signal: controller.signal,
      });

      const result = await probe.run(
        trustedShellCommand({
          command: process.execPath,
          args: [
            "-e",
            `console.log(${JSON.stringify(longer)}); console.error(${JSON.stringify(longer)});`,
          ],
          reason: "verify ShellProbe longest-first ordering for overlapping redactionValues",
        }),
        {
          artifactName: "overlap-shorter-first",
          redactionValues: [shorter, longer],
          timeoutMs: 5_000,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain(longer);
      expect(result.stdout).not.toContain("-beta-gamma-delta");
      expect(result.stderr).not.toContain(longer);
      expect(result.stderr).not.toContain("-beta-gamma-delta");
      const written = fs.readFileSync(
        artifacts.pathFor("shell/overlap-shorter-first.result.json"),
        "utf8",
      );
      expect(written).not.toContain(longer);
      expect(written).not.toContain("-beta-gamma-delta");
      expect(
        fs.readFileSync(artifacts.pathFor("shell/overlap-shorter-first.stdout.txt"), "utf8"),
      ).not.toContain("-beta-gamma-delta");
      expect(
        fs.readFileSync(artifacts.pathFor("shell/overlap-shorter-first.stderr.txt"), "utf8"),
      ).not.toContain("-beta-gamma-delta");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("shell probe cleans up and redacts missing command failures", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-shell-probe-"));
    try {
      const artifacts = new ArtifactSink(tmp);
      await artifacts.ensureRoot();
      const secret = "spawn-secret-value";
      const controller = new AbortController();
      let abortAdds = 0;
      let abortRemoves = 0;
      const addEventListener = controller.signal.addEventListener.bind(controller.signal);
      const removeEventListener = controller.signal.removeEventListener.bind(controller.signal);
      const instrumentedAddEventListener = (
        type: string,
        listener: EventListener | EventListenerObject,
        options?: AddEventListenerOptions | boolean,
      ) => {
        if (type === "abort") abortAdds += 1;
        return addEventListener(type, listener, options);
      };
      const instrumentedRemoveEventListener = (
        type: string,
        listener: EventListener | EventListenerObject,
        options?: EventListenerOptions | boolean,
      ) => {
        if (type === "abort") abortRemoves += 1;
        return removeEventListener(type, listener, options);
      };
      controller.signal.addEventListener =
        instrumentedAddEventListener as typeof controller.signal.addEventListener;
      controller.signal.removeEventListener =
        instrumentedRemoveEventListener as typeof controller.signal.removeEventListener;
      const probe = new ShellProbe({
        artifacts,
        redact: (text, extraValues = []) =>
          [secret, ...extraValues].reduce(
            (redacted, value) => redacted.split(value).join("[REDACTED]"),
            text,
          ),
        signal: controller.signal,
      });

      let thrown: unknown;
      try {
        await probe.run(
          trustedShellCommand({
            command: `missing-command-${secret}`,
            args: [secret],
            reason: "exercise redacted spawn failure handling",
          }),
          {
            artifactName: "spawn-error",
            redactionValues: [secret],
            timeoutMs: 10_000,
          },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toContain("[REDACTED]");
      expect(message).not.toContain(secret);
      expect(abortAdds).toBe(1);
      expect(abortRemoves).toBe(1);
      expect(
        fs.readFileSync(artifacts.pathFor("shell/spawn-error.result.json"), "utf8"),
      ).not.toContain(secret);
      expect(fs.readFileSync(artifacts.pathFor("shell/spawn-error.stderr.txt"), "utf8")).toContain(
        "[REDACTED]",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("shell probe escalates abort-triggered termination", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-shell-probe-abort-"));
    try {
      const artifacts = new ArtifactSink(tmp);
      await artifacts.ensureRoot();
      const controller = new AbortController();
      const probe = new ShellProbe({
        artifacts,
        redact: (text) => text,
        signal: controller.signal,
      });

      const started = Date.now();
      const run = probe.run(
        trustedShellCommand({
          command: process.execPath,
          args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
          reason: "exercise abort escalation",
        }),
        {
          artifactName: "abort-escalation",
          timeoutMs: 10_000,
          killGraceMs: 50,
        },
      );
      setTimeout(() => controller.abort(), 50);
      const result = await run;

      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result.timedOut).toBe(false);
      expect(result.signal).toBe("SIGKILL");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("shell probe terminates pre-aborted signals immediately", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-shell-probe-pre-abort-"));
    try {
      const artifacts = new ArtifactSink(tmp);
      await artifacts.ensureRoot();
      const controller = new AbortController();
      controller.abort();
      const probe = new ShellProbe({
        artifacts,
        redact: (text) => text,
        signal: controller.signal,
      });

      const started = Date.now();
      const result = await probe.run(
        trustedShellCommand({
          command: process.execPath,
          args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
          reason: "exercise pre-aborted signal termination",
        }),
        {
          artifactName: "pre-abort-escalation",
          timeoutMs: 10_000,
          killGraceMs: 50,
        },
      );

      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result.timedOut).toBe(false);
      expect(result.signal).toBeTruthy();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("shell probe reaps timed-out command process groups", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-shell-probe-pgid-"));
    let grandchildPid: number | undefined;
    try {
      const artifacts = new ArtifactSink(tmp);
      await artifacts.ensureRoot();
      const controller = new AbortController();
      const probe = new ShellProbe({
        artifacts,
        redact: (text) => text,
        signal: controller.signal,
      });
      const pidFile = path.join(tmp, "sleep.pid");

      const result = await probe.run(
        trustedShellCommand({
          command: "bash",
          args: ["-c", 'sleep 30 & echo "$!" > "$1"; wait', "e2e-shell-probe", pidFile],
          reason: "exercise process-group timeout cleanup",
        }),
        {
          artifactName: "process-group-timeout",
          timeoutMs: 200,
          killGraceMs: 50,
        },
      );

      grandchildPid = Number(fs.readFileSync(pidFile, "utf8").trim());
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(result.timedOut).toBe(true);
      expect(result.signal).toBeTruthy();
      await expectProcessToExit(grandchildPid);
    } finally {
      if (grandchildPid && isProcessAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

e2eTest(
  "fixture context captures redacted shell artifacts",
  async ({ artifacts, cleanup, shellProbe }) => {
    const marker = await artifacts.writeText("context.txt", "fixture-ready");
    cleanup.add("write cleanup marker", async () => {
      await artifacts.writeText("cleanup-marker.txt", "done");
    });

    const secret = "shell-probe-secret-value";
    const result = await shellProbe.run(
      trustedShellCommand({
        command: process.execPath,
        args: [
          "-e",
          "console.log(process.env.NEMOCLAW_TEST_TOKEN); console.error(process.argv[1]);",
          secret,
        ],
        reason: "exercise fixture shell artifact redaction",
      }),
      {
        artifactName: "redaction-proof",
        env: { NEMOCLAW_TEST_TOKEN: secret },
        redactionValues: [secret],
        timeoutMs: 5_000,
      },
    );

    expect(fs.readFileSync(marker, "utf8")).toBe("fixture-ready");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    expect(fs.readFileSync(result.artifacts.result, "utf8")).not.toContain(secret);
  },
);

e2eTest("shell probe uses explicit env and escalates ignored timeouts", async ({ shellProbe }) => {
  const parentSecretName = "NEMOCLAW_PARENT_SECRET_FOR_PROBE_TEST";
  const parentSecret = "parent-secret-value";
  const explicitSecret = "explicit-secret-value";
  const oldParentSecret = process.env[parentSecretName];
  process.env[parentSecretName] = parentSecret;
  try {
    const envResult = await shellProbe.run(
      trustedShellCommand({
        command: process.execPath,
        args: [
          "-e",
          `console.log(process.env.${parentSecretName} ?? "missing"); console.log(process.env.NEMOCLAW_TEST_TOKEN);`,
        ],
        reason: "exercise explicit shell probe environment",
      }),
      {
        artifactName: "minimal-env",
        env: { NEMOCLAW_TEST_TOKEN: explicitSecret },
        redactionValues: [explicitSecret, parentSecret],
        timeoutMs: 5_000,
      },
    );

    expect(envResult.exitCode).toBe(0);
    expect(envResult.stdout).toContain("missing");
    expect(envResult.stdout).toContain("[REDACTED]");
    expect(envResult.stdout).not.toContain(parentSecret);
    expect(envResult.stdout).not.toContain(explicitSecret);
    expect(fs.readFileSync(envResult.artifacts.result, "utf8")).not.toContain(explicitSecret);
  } finally {
    if (oldParentSecret === undefined) {
      delete process.env[parentSecretName];
    } else {
      process.env[parentSecretName] = oldParentSecret;
    }
  }

  const started = Date.now();
  const timeoutResult = await shellProbe.run(
    trustedShellCommand({
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      reason: "exercise timeout escalation",
    }),
    {
      artifactName: "timeout-escalation",
      timeoutMs: 50,
      killGraceMs: 50,
    },
  );

  expect(Date.now() - started).toBeLessThan(2_000);
  expect(timeoutResult.timedOut).toBe(true);
  // Darwin can report the earlier SIGTERM even when the supervisor's bounded
  // escalation path resolves promptly. The contract here is timeout detection
  // plus bounded cleanup; leaf supervisor tests own exact signal sequencing.
  expect(
    timeoutResult.signal === "SIGKILL" ||
      timeoutResult.signal === "SIGTERM" ||
      timeoutResult.exitCode !== 0,
  ).toBe(true);
});
