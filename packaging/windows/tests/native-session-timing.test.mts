// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createNativeSessionDiagnostics,
  NativeSessionFailure,
} from "../runtime/native-session-diagnostics.mts";
import { attemptNativeUiCleanup } from "../runtime/native-ui-lifecycle.mts";

type Diagnostics = ReturnType<typeof createNativeSessionDiagnostics>;
const CANARY = 'TIMING_KEY_"SPECIAL+secret';

async function withDiagnostics(action: (diagnostics: Diagnostics, root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-session-timing-"));
  try {
    const diagnostics = createNativeSessionDiagnostics(process.execPath, root, "hermes");
    diagnostics.secret(CANARY);
    await action(diagnostics, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function record(diagnostics: Diagnostics) {
  const text = diagnostics.evidence();
  assert(!text.includes(CANARY));
  assert(!text.includes(encodeURIComponent(CANARY)));
  return JSON.parse(text);
}

// Execute the actual host wrapper's source without importing the legacy runner's
// CLI graph. These substitute only external operations, not diagnostics or cleanup.
function wrapper(source: string, bindings: Record<string, unknown>, body: string) {
  return new Function(...Object.keys(bindings), `${stripTypeScriptTypes(source)}\nreturn ${body};`)(
    ...Object.values(bindings),
  );
}
const consoleSource = fs.readFileSync(
  new URL("../runtime/run-installed-native-console-agent.mts", import.meta.url),
  "utf8",
);
const consoleWrapper = consoleSource
  .slice(
    consoleSource.indexOf("export async function runNativeConsoleAgent("),
    consoleSource.lastIndexOf("\nif (process.argv[1]"),
  )
  .replace("export ", "");
const webSource = fs.readFileSync(
  new URL("../runtime/run-installed-native-web-ui.mts", import.meta.url),
  "utf8",
);
const webWrapper =
  "async function runWeb() {\n" +
  webSource.slice(
    webSource.indexOf("  const diagnostics = createNativeSessionDiagnostics("),
    webSource.lastIndexOf("\nif (process.argv[1]"),
  );
const executableConsole = consoleWrapper;

function common(diagnostics: Diagnostics) {
  return {
    createNativeSessionDiagnostics: () => diagnostics,
    NativeSessionFailure,
    path,
    process,
    console: { log() {}, error() {} },
    requiredDirectory: (value: string) => value || os.tmpdir(),
    requiredFile: (value: string) => value,
    fail: (message: string) => {
      throw new Error(message);
    },
  };
}

test("real monotonic intervals survive a wall-clock jump and do not count the diagnostic writer", async () => {
  await withDiagnostics(async (diagnostics) => {
    const originalNow = Date.now;
    try {
      Date.now = () => -123456789;
      await sleep(20);
      diagnostics.stage("runtime-copy-agent");
      diagnostics.stage("runtime-copy-agent");
      await sleep(20);
      diagnostics.stage("cleanup");
      await sleep(10);
      const presentation = await diagnostics.persistSuccess();
      const saved = record(diagnostics);
      assert.equal(saved.classification, "native-session-success");
      assert.equal(saved.failure, null);
      assert.equal(saved.timing.failureElapsedMs, null);
      assert.equal(saved.timing.clock, "process.hrtime.bigint");
      assert.deepEqual(
        saved.timing.stages.map((stage: { stage: string }) => stage.stage),
        ["inference", "runtime-copy-agent", "cleanup"],
      );
      assert(saved.timing.stages[0].elapsedMs >= 10);
      assert(saved.timing.stages[1].elapsedMs >= 10);
      let previous = 0;
      for (const stage of saved.timing.stages) {
        assert.equal(stage.startMs, previous);
        assert(stage.elapsedMs >= 0);
        assert.equal(stage.elapsedMs, stage.endMs - stage.startMs);
        previous = stage.endMs;
      }
      assert.equal(previous, saved.timing.elapsedMs);
      // Real Node rejects --native-ui-file-owner. A success record is still
      // available in memory, but this does not claim Windows persistence worked.
      assert.equal(presentation.diagnosticPath, undefined);
      assert.match(presentation.message, /diagnostic file could not be saved/u);
      const before = diagnostics.evidence();
      await sleep(20);
      assert.equal(diagnostics.evidence(), before);
    } finally {
      Date.now = originalNow;
    }
  });
});

test("retains the primary exception and failure time through cleanup with no process logs", async () => {
  await withDiagnostics(async (diagnostics) => {
    const primary = new Error(`primary ${CANARY}`, { cause: new Error(`cause ${CANARY}`) });
    diagnostics.stage("sandbox");
    diagnostics.fail(primary);
    diagnostics.stage("cleanup");
    await sleep(15);
    diagnostics.cleanupFailed("private state release");
    const presentation = await diagnostics.persist(new Error("secondary cleanup exception"));
    const saved = record(diagnostics);
    assert.equal(diagnostics.primaryError(), primary);
    assert.equal(saved.stage, "sandbox");
    assert.equal(saved.failure.message, "primary [REDACTED]");
    assert.equal(saved.failure.cause.message, "cause [REDACTED]");
    assert.deepEqual(saved.output, {});
    assert.deepEqual(saved.cleanupFailures, ["private state release"]);
    assert(saved.timing.elapsedMs > saved.timing.failureElapsedMs);
    assert.equal(presentation.stage, "sandbox");
    assert(!diagnostics.evidence().includes("secondary cleanup exception"));
    assert.equal(await diagnostics.persist(new Error("third error")), presentation);
  });
});

test("preserves a thrown undefined value as the first failure", async () => {
  await withDiagnostics(async (diagnostics) => {
    diagnostics.fail(undefined);
    diagnostics.stage("cleanup");
    await diagnostics.persist(new Error("later cleanup"));
    assert.equal(diagnostics.hasFailure(), true);
    assert.equal(diagnostics.primaryError(), undefined);
    assert.equal(record(diagnostics).classification, "native-session-failure");
    assert(!diagnostics.evidence().includes("later cleanup"));
  });
});

test("success capture redacts bytewise UTF8, split tokens and late registered values", async () => {
  await withDiagnostics(async (diagnostics) => {
    for (const byte of Buffer.from(`préface 🟩 ${CANARY}\nBearer UNKNOWN_VALUE\nLATE_KEY\n`))
      diagnostics.capture("create.stdout", Buffer.from([byte]));
    diagnostics.secret("LATE_KEY");
    diagnostics.stage("cleanup");
    await diagnostics.persistSuccess();
    const saved = record(diagnostics);
    assert.equal(saved.failure, null);
    assert.equal(
      saved.output["create.stdout"],
      "préface 🟩 [REDACTED]\nBearer [REDACTED]\n[REDACTED]\n",
    );
    assert(!diagnostics.evidence().includes("UNKNOWN_VALUE"));
  });
});

test("bounds stage records without losing total elapsed or inventing retained intervals", async () => {
  await withDiagnostics(async (diagnostics) => {
    for (let count = 0; count < 300; count++) diagnostics.stage(count % 2 ? "runtime" : "broker");
    diagnostics.stage("cleanup");
    await diagnostics.persistSuccess();
    const saved = record(diagnostics);
    assert.equal(saved.timing.stages.length, 128);
    assert.equal(saved.timing.omittedStageRecords, 174);
    assert(saved.timing.elapsedMs >= saved.timing.stages.at(-1).endMs);
  });
});

test("actual console wrapper throws the original cause when inner cleanup throws another error", async () => {
  await withDiagnostics(async (diagnostics) => {
    const primary = new Error("original no-output startup failure");
    const secondary = new Error("secondary finally failure");
    let completed: unknown;
    const progressStages: string[] = [];
    const operation = wrapper(
      executableConsole,
      {
        ...common(diagnostics),
        argumentValue: () => "hermes",
        AGENT_ADAPTERS: { hermes: {} },
        runNativeConsoleAgentInternal: async () => {
          diagnostics.stage("sandbox");
          diagnostics.fail(primary);
          throw secondary;
        },
      },
      "runNativeConsoleAgent",
    );
    await assert.rejects(
      operation({
        webSession: {
          progress: (stage: string) => progressStages.push(stage),
          complete: async (...values: unknown[]) => {
            completed = values;
            throw new Error("third UI failure");
          },
        },
      }),
      (error: unknown) => {
        assert(error instanceof NativeSessionFailure);
        assert.equal(error.cause, primary);
        return true;
      },
    );
    assert.equal((completed as unknown[])[0], false);
    assert.deepEqual(progressStages, ["cleanup"]);
    assert.equal(record(diagnostics).failure.message, primary.message);
  });
});

test("actual console wrapper saves a success record after the session control closes", async () => {
  await withDiagnostics(async (diagnostics) => {
    let stopped = false;
    const operation = wrapper(
      executableConsole,
      {
        ...common(diagnostics),
        argumentValue: () => "hermes",
        AGENT_ADAPTERS: { hermes: {} },
        runNativeConsoleAgentInternal: async () => {
          diagnostics.stage("agent");
          await sleep(10);
          diagnostics.stage("cleanup");
        },
      },
      "runNativeConsoleAgent",
    );
    await operation({
      webSession: {
        complete: async (passed: boolean) => {
          assert(passed);
          stopped = true;
        },
      },
    });
    assert(stopped);
    assert.equal(record(diagnostics).classification, "native-session-success");
  });
});

test("actual OpenClaw wrapper retains an early no-log failure and a later state-release error", async () => {
  await withDiagnostics(async (diagnostics, root) => {
    const primary = new Error(`broker startup ${CANARY}`);
    let released = false;
    let completed: unknown;
    const operation = wrapper(
      webWrapper,
      {
        ...common(diagnostics),
        fs,
        launcherPath: process.execPath,
        installRoot: root,
        configured: true,
        selectedEvidenceRoot: root,
        openNativeWebSession: async () => ({
          progress() {},
          assertRunning() {},
          complete: async (...values: unknown[]) => {
            completed = values;
          },
        }),
        readNativeAgentConfiguration: () => ({ config: { model: "native-test" } }),
        resolveNativeConfiguredInference: async () => ({
          configuration: { model: "native-test" },
          credential: CANARY,
        }),
        acquireNativeStateSession: async () => ({
          release: async () => {
            released = true;
            throw new Error("state cleanup failed");
          },
        }),
        readNativeServiceEnvironment: async () => ({ environment: {} }),
        startNativeInferenceBroker: async () => {
          throw primary;
        },
        randomBytes: () => Buffer.from("12345678"),
        attemptNativeUiCleanup,
      },
      "runWeb",
    );
    await assert.rejects(operation(), (error: unknown) => {
      assert(error instanceof NativeSessionFailure);
      assert.equal(error.cause, primary);
      return true;
    });
    assert(released);
    assert.equal((completed as unknown[])[0], false);
    const saved = record(diagnostics);
    assert.equal(saved.failure.message, "broker startup [REDACTED]");
    assert.deepEqual(saved.output, {});
    assert.deepEqual(saved.cleanupFailures, ["private agent state"]);
    assert.equal(saved.stage, "broker");
  });
});

test("actual OpenClaw wrapper retains failure to start the native control itself", async () => {
  await withDiagnostics(async (diagnostics, root) => {
    const primary = new Error("native control could not start");
    const operation = wrapper(
      webWrapper,
      {
        ...common(diagnostics),
        launcherPath: process.execPath,
        installRoot: root,
        configured: true,
        openNativeWebSession: async () => {
          throw primary;
        },
      },
      "runWeb",
    );
    await assert.rejects(operation(), (error: unknown) => {
      assert(error instanceof NativeSessionFailure);
      assert.equal(error.cause, primary);
      return true;
    });
    assert.deepEqual(record(diagnostics).output, {});
  });
});

test("legacy failure snapshot retains its closed schema and coarse copy stage", async () => {
  await withDiagnostics(async (diagnostics) => {
    diagnostics.stage("runtime-copy-agent");
    const presentation = await diagnostics.persist(new Error("copy failed"));
    const legacy = JSON.parse(diagnostics.failureEvidence());
    assert.deepEqual(
      Object.keys(legacy).sort(),
      [
        "agent",
        "classification",
        "cleanupFailures",
        "failure",
        "output",
        "recordedAt",
        "schemaVersion",
        "stage",
      ].sort(),
    );
    assert.equal(legacy.stage, "runtime");
    assert.equal(presentation.stage, "runtime");
    assert.equal(record(diagnostics).timing.stages.at(-1).stage, "runtime-copy-agent");
  });
});

test("success API cannot relabel already recorded cleanup failures as success", async () => {
  await withDiagnostics(async (diagnostics) => {
    diagnostics.stage("cleanup");
    diagnostics.cleanupFailed("private state release");
    await diagnostics.persistSuccess();
    assert.equal(record(diagnostics).classification, "native-session-failure");
    assert.equal(diagnostics.hasFailure(), true);
  });
});

test("actual OpenClaw final handoff saves success and measures native control close separately", async () => {
  await withDiagnostics(async (diagnostics) => {
    const progressStages: string[] = [];
    const footer = webSource.slice(
      webSource.lastIndexOf(
        "\n  } catch (error) {\n    diagnostics.fail(error);\n    presentation =",
      ),
      webSource.lastIndexOf("\nif (process.argv[1]"),
    );
    assert(footer.startsWith("\n  } catch"));
    const operation = wrapper(
      "async function finishWeb() { let presentation; try { await backend();" + footer,
      {
        ...common(diagnostics),
        diagnostics,
        backend: async () => {
          diagnostics.stage("agent");
          await sleep(10);
          diagnostics.stage("cleanup");
        },
        webSession: {
          progress: (stage: string) => progressStages.push(stage),
          complete: async (passed: boolean) => {
            assert(passed);
            await sleep(20);
          },
        },
      },
      "finishWeb",
    );
    await operation();
    const saved = record(diagnostics);
    assert.deepEqual(progressStages, ["cleanup"]);
    assert.equal(saved.failure, null);
    assert.equal(saved.classification, "native-session-success");
    assert.equal(saved.timing.stages.at(-1).stage, "control-close");
    assert(saved.timing.stages.at(-1).elapsedMs >= 10);
  });
});

const nativeLauncher = process.env.NEMOCLAW_NATIVE_TEST_LAUNCHER;
test(
  "Windows native owner durably retains both success and empty-output primary failure",
  { skip: process.platform !== "win32" || !nativeLauncher },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-diagnostic-durability-"));
    try {
      for (const failed of [false, true]) {
        const diagnostics = createNativeSessionDiagnostics(nativeLauncher!, root, "openclaw");
        diagnostics.secret(CANARY);
        diagnostics.stage("sandbox");
        if (failed) diagnostics.fail(new Error(`empty-output primary ${CANARY}`));
        diagnostics.stage("cleanup");
        const presentation = failed
          ? await diagnostics.persist(diagnostics.primaryError())
          : await diagnostics.persistSuccess();
        assert(presentation.diagnosticPath);
        assert.equal(fs.readFileSync(presentation.diagnosticPath, "utf8"), diagnostics.evidence());
        assert.equal(
          record(diagnostics).failure?.message ?? null,
          failed ? "empty-output primary [REDACTED]" : null,
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
