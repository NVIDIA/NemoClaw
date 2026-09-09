// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createNativeDiagnosticCapture,
  createNativeSessionDiagnostics,
  nativeDiagnosticTail,
  sanitizeNativeDiagnostic,
} from "../../packaging/windows/runtime/native-session-diagnostics.mts";

type CommandResult = { exitCode: number; stdout: string; stderr: string };
type CommandRunner = {
  run(
    file: string,
    args: string[],
    environment: NodeJS.ProcessEnv,
    label: string,
    timeout: number,
    diagnostics?: { capture(channel: string, chunk: Buffer | string): void },
  ): Promise<CommandResult>;
};
// Exercise the actual legacy command runner at its runtime module boundary.
// Its broader Windows qualification program is not part of this test's API.
const runnerUrl = pathToFileURL(
  path.resolve(
    import.meta.dirname,
    "../../packaging/windows/runtime/run-installed-native-turn.mts",
  ),
).href;
const runner = import(runnerUrl) as Promise<CommandRunner>;
const SECRET = "DIAGNOSTIC_CANARY+/= 84";

function captureChunks(
  chunks: Iterable<Buffer | string>,
  secrets: () => readonly string[] = () => [],
) {
  const capture = createNativeDiagnosticCapture(secrets);
  for (const chunk of chunks) capture.write(chunk);
  return capture;
}

async function withChild<T>(operation: (script: string) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-diagnostic-child-"));
  const script = path.join(root, "child.mjs");
  fs.writeFileSync(
    script,
    `
const mode = process.argv[2];
if (mode === "tail-stderr" || mode === "tail-stdout") {
  const output = mode === "tail-stderr" ? process.stderr : process.stdout;
  const other = mode === "tail-stderr" ? process.stdout : process.stderr;
  output.write("Provisioning sandbox warning ".repeat(4000) + "\\n");
  output.write("FINAL_PROVISIONING_FAILURE " + process.env.TEST_SECRET + "\\n");
  const index = process.argv.indexOf("--env");
  other.write("argument value: " + process.argv[index + 1].split("=").slice(1).join("=") + "\\n");
  process.exitCode = 23;
} else if (mode === "timeout") {
  process.stdout.write("CHILD_PID=" + process.pid + "\\n");
  setInterval(() => {}, 1000);
} else if (mode === "limit") {
  process.stdout.write("Z".repeat(2 * 1024 * 1024));
} else if (mode === "zero") {
  process.stdout.write("successful result\\n");
} else throw new Error("Unknown controlled child mode");
`,
    "utf8",
  );
  try {
    return await operation(script);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("native session diagnostic secrecy and final errors", () => {
  it("redacts known raw, JSON, and URL values and removes terminal controls", () => {
    const input =
      "\u001b[31m" +
      [
        SECRET,
        JSON.stringify(SECRET),
        encodeURIComponent(SECRET),
        "Bearer unknown-value",
        "api_key=other-value",
      ].join("\n") +
      "\u001b[0m";
    const safe = sanitizeNativeDiagnostic(input, [SECRET]);
    expect(safe).not.toContain(SECRET);
    expect(safe).not.toContain(encodeURIComponent(SECRET));
    expect(safe).not.toContain("unknown-value");
    expect(safe).not.toContain("other-value");
    expect(safe).not.toContain("\u001b");
    expect(safe).toContain("[REDACTED]");
    const escaped = 'QUOTE"BACKSLASH\\VALUE';
    expect(sanitizeNativeDiagnostic(JSON.stringify(escaped), [escaped])).toBe('"[REDACTED]"');
  });

  it("decodes bytewise UTF8 and redacts secrets split across chunks", () => {
    const capture = captureChunks(
      Array.from(Buffer.from(`préface 🟩 ${SECRET}\r\nFINAL\n`), (byte) => Buffer.from([byte])),
      () => [SECRET],
    );
    expect(capture.finish()).toBe("préface 🟩 [REDACTED]\nFINAL\n");
    expect(capture.finish()).toBe(capture.text());
    capture.write("ignored after finish");
    expect(capture.finish()).toBe("préface 🟩 [REDACTED]\nFINAL\n");
  });

  it("removes split ANSI sequences before matching a complete secret", () => {
    const capture = captureChunks(
      ["SPLIT-\u001b[", "31mKEY", "\u001b[0", "m\n"].map((part) => Buffer.from(part)),
      () => ["SPLIT-KEY"],
    );
    expect(capture.finish()).toBe("[REDACTED]\n");
  });

  it("discards a complete oversized line without retaining its secret suffix", () => {
    const capture = createNativeDiagnosticCapture(() => ["SECRET-SUFFIX"]);
    capture.write("x".repeat(16000));
    capture.write("y".repeat(1000) + "SECRET-");
    capture.write("SUFFIX\nFINAL\n");
    capture.write("z".repeat(20000));
    expect(capture.finish()).toBe(
      "[overlong diagnostic line omitted]\nFINAL\n[overlong diagnostic line omitted]\n",
    );
  });

  it("bounds the retained tail while preserving the final complete error", () => {
    const capture = captureChunks(
      Array.from({ length: 5000 }, (_, index) => `warning-${index}${" ".repeat(80)}\n`),
    );
    capture.write("LAST_FAILURE\n");
    const tail = capture.finish();
    expect(tail.length).toBeLessThanOrEqual(24 * 1024);
    expect(tail.endsWith("LAST_FAILURE\n")).toBe(true);
    expect(tail).not.toContain("warning-0 ");
    const selected = nativeDiagnosticTail("a\n".repeat(50000) + "LAST_FAILURE\n", [], 1000);
    expect(selected.length).toBeLessThanOrEqual(1035);
    expect(selected.endsWith("LAST_FAILURE\n")).toBe(true);
  });

  it("redacts a registered key reconstructed by control-character removal", () => {
    // The original replacement order restored this exact canary after redaction.
    const safe = sanitizeNativeDiagnostic("KEY-\u0000CANARY", ["KEY-CANARY"]);
    expect(safe).toBe("[REDACTED]");
  });

  it("redacts a later registered secret from already retained complete lines", () => {
    // The original retained-tail path did not apply newly registered secrets.
    let values: string[] = [];
    const capture = createNativeDiagnosticCapture(() => values);
    capture.write("EARLY_KEY_CANARY\n");
    values = ["EARLY_KEY_CANARY"];
    expect(capture.text()).toBe("[REDACTED]\n");
    expect(capture.finish()).toBe("[REDACTED]\n");
  });

  it.each(["tail-stdout", "tail-stderr"])(
    "retains final provisioning failure from %s and redacts child argv and environment",
    async (mode) => {
      await withChild(async (script) => {
        const { run } = await runner;
        const envValue = "ENV_DIAGNOSTIC_CANARY";
        const argvValue = "ARGV_DIAGNOSTIC_CANARY=with-equals";
        let failure: unknown;
        try {
          await run(
            process.execPath,
            [script, mode, "--env", `API_KEY=${argvValue}`],
            { ...process.env, TEST_SECRET: envValue },
            "controlled provisioning child",
            5000,
          );
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        const message = (failure as Error).message;
        expect(message).toContain("exited 23");
        expect(message).toContain("FINAL_PROVISIONING_FAILURE");
        expect(message).not.toContain(envValue);
        expect(message).not.toContain(argvValue);
        expect(message.length).toBeLessThan(34 * 1024);
      });
    },
  );

  it("retains sanitized primary evidence when the real owner process cannot start", async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "native-diagnostic-state-"));
    try {
      // Real Node rejects the native owner's flag. This proves the failure
      // path without substituting a successful Windows file-authority owner.
      const diagnostics = createNativeSessionDiagnostics(process.execPath, state, "hermes");
      diagnostics.secret(SECRET);
      diagnostics.stage("bootstrap");
      diagnostics.capture("gateway.stderr", `final broker error ${SECRET}\n`);
      diagnostics.fail(new Error(`primary ${SECRET}`, { cause: new Error(`cause ${SECRET}`) }));
      diagnostics.stage("cleanup");
      diagnostics.cleanupFailed(`gateway stop ${SECRET}`);
      const presentation = await diagnostics.persist(new Error("later cleanup failure"), [
        "owned file close",
      ]);
      expect(presentation.stage).toBe("bootstrap");
      expect(presentation.diagnosticPath).toBeUndefined();
      expect(presentation.message).toContain("connecting the sandbox to the local broker");
      expect(presentation.message).toContain("diagnostic file could not be saved");
      const serialized = diagnostics.failureEvidence();
      expect(serialized).not.toContain(SECRET);
      const document = JSON.parse(serialized);
      expect(document).toMatchObject({
        schemaVersion: 1,
        classification: "native-session-failure",
        agent: "hermes",
        stage: "bootstrap",
        failure: { message: "primary [REDACTED]", cause: { message: "cause [REDACTED]" } },
        cleanupFailures: ["gateway stop [REDACTED]", "owned file close"],
        output: { "gateway.stderr": "final broker error [REDACTED]\n" },
      });
      expect(serialized).not.toContain("later cleanup failure");
      expect(await diagnostics.persist(new Error("third error"))).toEqual(presentation);
      expect(diagnostics.failureEvidence()).toBe(serialized);
    } finally {
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  it("returns the complete output from a successful real child", async () => {
    await withChild(async (script) => {
      const result = await (
        await runner
      ).run(process.execPath, [script, "zero"], process.env, "controlled success", 5000);
      expect(result).toEqual({ exitCode: 0, stdout: "successful result\n", stderr: "" });
    });
  });

  it("keeps a real timeout as failure and terminates the owned child", async () => {
    await withChild(async (script) => {
      let output = "";
      await expect(
        (await runner).run(
          process.execPath,
          [script, "timeout"],
          process.env,
          "controlled timeout",
          400,
          {
            capture(_name, chunk) {
              output += chunk;
            },
          },
        ),
      ).rejects.toThrow(/timed out/u);
      const pid = Number(/CHILD_PID=(\d+)/u.exec(output)?.[1]);
      expect(pid).toBeGreaterThan(0);
      const deadline = performance.now() + 3000;
      let exited = false;
      while (performance.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          expect(error).toMatchObject({ code: "ESRCH" });
          exited = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(exited).toBe(true);
    });
  });

  it("rejects a real zero-exit child when it exceeds the output limit", async () => {
    await withChild(async (script) => {
      const capture = createNativeDiagnosticCapture(() => []);
      await expect(
        (await runner).run(
          process.execPath,
          [script, "limit"],
          process.env,
          "controlled output limit",
          5000,
          {
            capture(_name, chunk) {
              capture.write(chunk);
            },
          },
        ),
      ).rejects.toThrow(/exceeded its diagnostic output limit/u);
      expect(capture.finish().length).toBeLessThanOrEqual(24 * 1024);
    });
  });
});
