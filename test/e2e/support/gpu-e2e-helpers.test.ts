// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import {
  assertAgentExecutionSucceeded,
  cleanupGpu,
  env,
  hasExactReadyPhase,
  ollamaCleanupScript,
  openClawModelConfigProjectionScript,
} from "../live/gpu-e2e-helpers.ts";
import {
  PROTECTED_OLLAMA_CURL_MAX_SECONDS,
  PROTECTED_OLLAMA_READY_ATTEMPTS,
  PROTECTED_OLLAMA_READY_SLEEP_SECONDS,
  PROTECTED_OLLAMA_START_TIMEOUT_MS,
  protectedOllamaStartScript,
  startProtectedOllama,
} from "../live/managed-image-protected-runtime-helpers.ts";

const GPU_MODEL = "qwen3.5:9b";
const SYNC_E2E_CHILD_OPTIONS = { killSignal: "SIGKILL" as const, timeout: 5_000 };

function loopbackPort(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  assert(address && typeof address !== "string", "loopback server has no TCP port");
  return address.port;
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = loopbackPort(server);
  const closed = once(server, "close");
  server.close();
  await closed;
  return port;
}

function writeShellCommands(
  bin: string,
  commands: ReadonlyArray<readonly [command: string, body: string]>,
): void {
  for (const [command, body] of commands) {
    const commandPath = path.join(bin, command);
    writeFileSync(commandPath, `#!/bin/sh\n${body}`);
    chmodSync(commandPath, 0o755);
  }
}

interface AgentOutputOverrides {
  status?: string;
  summary?: string;
  aborted?: boolean;
  provider?: string;
  model?: string;
  winnerProvider?: string;
  winnerModel?: string;
  attemptProvider?: string;
  attemptModel?: string;
  attemptStage?: string;
  attemptResult?: "success" | "error";
}

function agentOutput({
  status = "ok",
  summary = "completed",
  aborted = false,
  provider = "inference",
  model = GPU_MODEL,
  winnerProvider = "inference",
  winnerModel = GPU_MODEL,
  attemptProvider = provider,
  attemptModel = model,
  attemptStage = "assistant",
  attemptResult = "success",
}: AgentOutputOverrides = {}): string {
  return JSON.stringify({
    status,
    summary,
    result: {
      payloads: [],
      meta: {
        aborted,
        agentMeta: { provider, model },
        finalAssistantVisibleText: "NO_REPLY",
        executionTrace: {
          winnerProvider,
          winnerModel,
          attempts: [
            {
              provider: attemptProvider,
              model: attemptModel,
              result: attemptResult,
              stage: attemptStage,
            },
          ],
        },
      },
    },
  });
}

const invalidExecutionProofs: Array<{
  name: string;
  overrides: AgentOutputOverrides;
  message: string;
}> = [
  { name: "status", overrides: { status: "error" }, message: "agent command must report success" },
  { name: "summary", overrides: { summary: "failed" }, message: "agent command must complete" },
  { name: "abort state", overrides: { aborted: true }, message: "agent command must not abort" },
  {
    name: "provider",
    overrides: { provider: "unexpected" },
    message: "agent must use the expected provider",
  },
  {
    name: "model",
    overrides: { model: "unexpected" },
    message: "agent must use the expected model",
  },
  {
    name: "winner provider",
    overrides: { winnerProvider: "unexpected" },
    message: "execution trace must select the expected provider",
  },
  {
    name: "winner model",
    overrides: { winnerModel: "unexpected" },
    message: "execution trace must select the expected model",
  },
  {
    name: "attempt provider",
    overrides: { attemptProvider: "unexpected" },
    message: "execution trace must contain a successful assistant attempt",
  },
  {
    name: "attempt model",
    overrides: { attemptModel: "unexpected" },
    message: "execution trace must contain a successful assistant attempt",
  },
  {
    name: "attempt stage",
    overrides: { attemptStage: "tool" },
    message: "execution trace must contain a successful assistant attempt",
  },
];

describe("GPU E2E helpers", () => {
  it("stops the Ollama system service before cleanup completes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-ollama-cleanup-"));
    const listenerPort = await unusedLoopbackPort();
    try {
      const bin = path.join(root, "bin");
      const calls = path.join(root, "calls.log");
      mkdirSync(bin);
      writeShellCommands(bin, [
        ["id", 'printf "1000\\n"\n'],
        ["sudo", 'printf "sudo %s\\n" "$*" >>"$FAKE_CALLS"\nexit 0\n'],
        ["systemctl", 'printf "systemctl %s\\n" "$*" >>"$FAKE_CALLS"\nexit 0\n'],
        ["pkill", "exit 1\n"],
        ["pgrep", "exit 1\n"],
      ]);

      execFileSync("bash", ["-c", ollamaCleanupScript(listenerPort)], {
        ...SYNC_E2E_CHILD_OPTIONS,
        env: { ...process.env, FAKE_CALLS: calls, PATH: `${bin}:${process.env.PATH}` },
      });
      const commandLog = readFileSync(calls, "utf8");
      expect(commandLog).toContain("systemctl --user stop ollama.service");
      expect(commandLog).toContain("sudo -n systemctl stop ollama.service");
      expect(commandLog).toContain("sudo -n pkill -f [o]llama serve");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects cleanup when an Ollama listener remains", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-ollama-stale-listener-"));
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const listenerPort = loopbackPort(server);
    try {
      const bin = path.join(root, "bin");
      mkdirSync(bin);
      writeShellCommands(bin, [
        ["systemctl", "exit 1\n"],
        ["pkill", "exit 1\n"],
        ["pgrep", "exit 1\n"],
      ]);

      expect(() =>
        execFileSync("bash", ["-c", ollamaCleanupScript(listenerPort)], {
          ...SYNC_E2E_CHILD_OPTIONS,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          stdio: "pipe",
        }),
      ).toThrow();
    } finally {
      const closed = once(server, "close");
      server.close();
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("quotes protected Ollama log paths as shell data", () => {
    const script = protectedOllamaStartScript("/tmp/$(touch injected)-$USER-`id`-'quoted.log");

    expect(script).toContain("log_path='/tmp/$(touch injected)-$USER-`id`-'\\''quoted.log'");
  });

  it("keeps protected Ollama readiness inside the host command timeout", () => {
    const maximumReadinessMs =
      PROTECTED_OLLAMA_READY_ATTEMPTS *
      (PROTECTED_OLLAMA_CURL_MAX_SECONDS + PROTECTED_OLLAMA_READY_SLEEP_SECONDS) *
      1_000;

    expect(PROTECTED_OLLAMA_START_TIMEOUT_MS).toBeGreaterThan(maximumReadinessMs);
  });

  it("restarts the protected Ollama daemon through its installed system service", () => {
    const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-ollama-start-"));
    try {
      const bin = path.join(root, "bin");
      const calls = path.join(root, "calls.log");
      const logPath = path.join(root, "ollama.log");
      mkdirSync(bin);
      const idPath = path.join(bin, "id");
      writeFileSync(idPath, '#!/bin/sh\nprintf "1000\\n"\n');
      chmodSync(idPath, 0o755);
      const sudoPath = path.join(bin, "sudo");
      writeFileSync(
        sudoPath,
        '#!/bin/sh\nprintf "sudo %s\\n" "$*" >>"$FAKE_CALLS"\ncase "$*" in\n  "-n systemctl is-failed --quiet ollama.service") exit 1 ;;\n  *) exit 0 ;;\nesac\n',
      );
      chmodSync(sudoPath, 0o755);
      const curlPath = path.join(bin, "curl");
      writeFileSync(curlPath, "#!/bin/sh\nexit 0\n");
      chmodSync(curlPath, 0o755);
      const systemctlPath = path.join(bin, "systemctl");
      writeFileSync(systemctlPath, "#!/bin/sh\nexit 0\n");
      chmodSync(systemctlPath, 0o755);

      const stdout = execFileSync("bash", ["-c", protectedOllamaStartScript(logPath)], {
        ...SYNC_E2E_CHILD_OPTIONS,
        encoding: "utf8",
        env: { ...process.env, FAKE_CALLS: calls, PATH: `${bin}:${process.env.PATH}` },
      });
      expect(stdout).toBe("restart_mode=system\n");
      expect(readFileSync(calls, "utf8")).toContain("sudo -n systemctl restart ollama.service");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fall back when the installed Ollama system service restart fails", () => {
    const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-ollama-start-failure-"));
    try {
      const bin = path.join(root, "bin");
      const calls = path.join(root, "calls.log");
      const logPath = path.join(root, "ollama.log");
      mkdirSync(bin);
      writeShellCommands(bin, [
        ["id", 'printf "1000\\n"\n'],
        [
          "sudo",
          'printf "sudo %s\\n" "$*" >>"$FAKE_CALLS"\ncase "$*" in\n  "-n systemctl restart ollama.service") exit 1 ;;\n  *) exit 0 ;;\nesac\n',
        ],
        ["systemctl", 'printf "systemctl %s\\n" "$*" >>"$FAKE_CALLS"\nexit 0\n'],
        ["setsid", 'printf "setsid %s\\n" "$*" >>"$FAKE_CALLS"\nexit 0\n'],
        ["curl", "exit 0\n"],
      ]);

      expect(() =>
        execFileSync("bash", ["-c", protectedOllamaStartScript(logPath)], {
          ...SYNC_E2E_CHILD_OPTIONS,
          env: { ...process.env, FAKE_CALLS: calls, PATH: `${bin}:${process.env.PATH}` },
          stdio: "pipe",
        }),
      ).toThrow();
      const commandLog = readFileSync(calls, "utf8");
      expect(commandLog).toContain("systemctl cat ollama.service");
      expect(commandLog).toContain("sudo -n systemctl restart ollama.service");
      expect(commandLog).not.toContain("systemctl --user restart ollama.service");
      expect(commandLog).not.toContain("setsid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops when the restarted Ollama system service enters the failed state", () => {
    const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-ollama-start-failed-state-"));
    try {
      const bin = path.join(root, "bin");
      const calls = path.join(root, "calls.log");
      const logPath = path.join(root, "ollama.log");
      mkdirSync(bin);
      writeShellCommands(bin, [
        ["id", 'printf "1000\\n"\n'],
        [
          "sudo",
          'printf "sudo %s\\n" "$*" >>"$FAKE_CALLS"\ncase "$*" in\n  "-n systemctl is-failed --quiet ollama.service") exit 0 ;;\n  *) exit 0 ;;\nesac\n',
        ],
        ["systemctl", 'printf "systemctl %s\\n" "$*" >>"$FAKE_CALLS"\nexit 0\n'],
        ["setsid", 'printf "setsid %s\\n" "$*" >>"$FAKE_CALLS"\nexit 0\n'],
        ["curl", "exit 1\n"],
      ]);

      expect(() =>
        execFileSync("bash", ["-c", protectedOllamaStartScript(logPath)], {
          ...SYNC_E2E_CHILD_OPTIONS,
          env: { ...process.env, FAKE_CALLS: calls, PATH: `${bin}:${process.env.PATH}` },
          stdio: "pipe",
        }),
      ).toThrow();
      const commandLog = readFileSync(calls, "utf8");
      expect(commandLog).toContain("sudo -n systemctl restart ollama.service");
      expect(commandLog).toContain("sudo -n systemctl is-failed --quiet ollama.service");
      expect(commandLog).not.toContain("systemctl --user restart ollama.service");
      expect(commandLog).not.toContain("setsid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an installed Ollama system service without restart permission", () => {
    const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-ollama-start-unprivileged-"));
    try {
      const bin = path.join(root, "bin");
      const calls = path.join(root, "calls.log");
      const logPath = path.join(root, "ollama.log");
      mkdirSync(bin);
      writeShellCommands(bin, [
        ["id", 'printf "id %s\\n" "$*" >>"$FAKE_CALLS"\nprintf "1000\\n"\n'],
        ["sudo", 'printf "sudo %s\\n" "$*" >>"$FAKE_CALLS"\nexit 1\n'],
        [
          "systemctl",
          'printf "systemctl %s\\n" "$*" >>"$FAKE_CALLS"\ncase "$*" in\n  "cat ollama.service") exit 0 ;;\n  *) exit 1 ;;\nesac\n',
        ],
        ["setsid", 'printf "setsid %s\\n" "$*" >>"$FAKE_CALLS"\nexit 0\n'],
        ["curl", "exit 0\n"],
      ]);

      expect(() =>
        execFileSync("bash", ["-c", protectedOllamaStartScript(logPath)], {
          ...SYNC_E2E_CHILD_OPTIONS,
          env: { ...process.env, FAKE_CALLS: calls, PATH: `${bin}:${process.env.PATH}` },
          stdio: "pipe",
        }),
      ).toThrow();
      const commandLog = readFileSync(calls, "utf8");
      expect(commandLog).toContain("systemctl cat ollama.service");
      expect(commandLog).not.toContain("systemctl restart ollama.service");
      expect(commandLog).not.toContain("systemctl --user restart ollama.service");
      expect(commandLog).not.toContain("setsid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restarts an available Ollama user service without a manual daemon", () => {
    const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-ollama-start-user-service-"));
    try {
      const bin = path.join(root, "bin");
      const calls = path.join(root, "calls.log");
      const logPath = path.join(root, "ollama.log");
      mkdirSync(bin);
      writeShellCommands(bin, [
        ["id", 'printf "1000\\n"\n'],
        ["sudo", "exit 1\n"],
        [
          "systemctl",
          'printf "systemctl %s\\n" "$*" >>"$FAKE_CALLS"\ncase "$*" in\n  "cat ollama.service") exit 1 ;;\n  "--user restart ollama.service") exit 0 ;;\n  *) exit 1 ;;\nesac\n',
        ],
        ["setsid", 'printf "setsid %s\\n" "$*" >>"$FAKE_CALLS"\nexit 0\n'],
        ["curl", "exit 0\n"],
      ]);

      const stdout = execFileSync("bash", ["-c", protectedOllamaStartScript(logPath)], {
        ...SYNC_E2E_CHILD_OPTIONS,
        encoding: "utf8",
        env: { ...process.env, FAKE_CALLS: calls, PATH: `${bin}:${process.env.PATH}` },
      });
      expect(stdout).toBe("restart_mode=user\n");
      const commandLog = readFileSync(calls, "utf8");
      expect(commandLog).toContain("systemctl cat ollama.service");
      expect(commandLog).toContain("systemctl --user restart ollama.service");
      expect(commandLog).not.toContain("setsid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts a manual Ollama daemon when no service is available", () => {
    const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-ollama-start-manual-"));
    try {
      const bin = path.join(root, "bin");
      const calls = path.join(root, "calls.log");
      const logPath = path.join(root, "ollama.log");
      const readyPath = path.join(root, "ollama-ready");
      mkdirSync(bin);
      writeShellCommands(bin, [
        ["id", 'printf "1000\\n"\n'],
        ["sudo", "exit 1\n"],
        ["systemctl", 'printf "systemctl %s\\n" "$*" >>"$FAKE_CALLS"\nexit 1\n'],
        ["setsid", 'printf "setsid %s\\n" "$*" >>"$FAKE_CALLS"\nshift\nexec "$@"\n'],
        ["ollama", 'printf "ollama-executed %s\\n" "$*" >>"$FAKE_CALLS"\n: >"$FAKE_READY"\n'],
        ["curl", 'printf "curl-probe %s\\n" "$*" >>"$FAKE_CALLS"\ntest -f "$FAKE_READY"\n'],
      ]);

      const stdout = execFileSync("bash", ["-c", protectedOllamaStartScript(logPath)], {
        ...SYNC_E2E_CHILD_OPTIONS,
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_CALLS: calls,
          FAKE_READY: readyPath,
          PATH: `${bin}:${process.env.PATH}`,
        },
      });
      expect(stdout).toBe("restart_mode=manual\n");
      const commandLog = readFileSync(calls, "utf8");
      expect(commandLog).toContain("systemctl cat ollama.service");
      expect(commandLog).toContain("systemctl --user restart ollama.service");
      expect(commandLog).toContain("setsid -f env OLLAMA_HOST=127.0.0.1:11434 ollama serve");
      expect(commandLog).toContain("ollama-executed serve");
      expect(commandLog).toContain(
        "curl-probe -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:11434/api/tags",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a stale Ollama listener before protected startup", async () => {
    const artifacts: string[] = [];
    const host = {
      command: async (
        _command: string,
        _args: string[],
        options: { artifactName?: string } = {},
      ) => {
        artifacts.push(options.artifactName ?? "");
        switch (options.artifactName) {
          case "command-v-ollama":
            return { exitCode: 0, stderr: "", stdout: "/usr/local/bin/ollama\n" };
          case "pre-cleanup-managed-image-ollama":
            return {
              exitCode: 1,
              stderr: "Ollama still listens on 127.0.0.1:11434",
              stdout: "",
            };
          default:
            throw new Error(
              `unexpected command after failed cleanup: ${options.artifactName ?? ""}`,
            );
        }
      },
    } as unknown as HostCliClient;

    await expect(startProtectedOllama(host)).rejects.toThrow(/still listens/u);
    expect(artifacts).toEqual(["command-v-ollama", "pre-cleanup-managed-image-ollama"]);
  });

  it("keeps protected Ollama startup diagnostics out of assertion output", async () => {
    const diagnostic = "sensitive Ollama journal diagnostic";
    const resultArtifact = "/tmp/start-managed-image-ollama.result.json";
    const artifacts: string[] = [];
    const host = {
      command: async (
        _command: string,
        _args: string[],
        options: { artifactName?: string } = {},
      ) => {
        artifacts.push(options.artifactName ?? "");
        switch (options.artifactName) {
          case "command-v-ollama":
            return { exitCode: 0, stderr: "", stdout: "/usr/local/bin/ollama\n" };
          case "pre-cleanup-managed-image-ollama":
            return { exitCode: 0, stderr: "", stdout: "" };
          case "start-managed-image-ollama":
            return {
              artifacts: {
                result: resultArtifact,
                stderr: "/tmp/start-managed-image-ollama.stderr.txt",
                stdout: "/tmp/start-managed-image-ollama.stdout.txt",
              },
              exitCode: 1,
              stderr: diagnostic,
              stdout: "",
            };
          default:
            throw new Error(
              `unexpected command after failed startup: ${options.artifactName ?? ""}`,
            );
        }
      },
    } as unknown as HostCliClient;

    let failure: unknown;
    try {
      await startProtectedOllama(host);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const failureText = failure instanceof Error ? failure.message : String(failure);
    expect(failureText).toContain("protected Ollama startup failed");
    expect(failureText).toContain(resultArtifact);
    expect(failureText).not.toContain(diagnostic);
    expect(artifacts).toEqual([
      "command-v-ollama",
      "pre-cleanup-managed-image-ollama",
      "start-managed-image-ollama",
    ]);
  });

  it("stops GPU setup when Ollama cleanup leaves a listener", async () => {
    const success = { exitCode: 0, stderr: "", stdout: "" };
    const host = {
      command: async (command: string) =>
        command === "bash"
          ? { exitCode: 1, stderr: "Ollama still listens on 127.0.0.1:11434", stdout: "" }
          : success,
    } as unknown as HostCliClient;
    const sandbox = {
      cleanupSandbox: async () => success,
      openshell: async () => success,
    } as unknown as SandboxClient;

    await expect(cleanupGpu(host, sandbox)).rejects.toThrow(/still listens/u);
  });

  it("forwards the workflow-owned Ollama model pull timeout", () => {
    expect(env({}, { NEMOCLAW_OLLAMA_PULL_TIMEOUT: "2400" }).NEMOCLAW_OLLAMA_PULL_TIMEOUT).toBe(
      "2400",
    );
  });

  it("does not synthesize an Ollama model pull timeout outside workflow configuration", () => {
    expect(env({}, {}).NEMOCLAW_OLLAMA_PULL_TIMEOUT).toBeUndefined();
  });

  it("uses the release-supported small GPU model by default", () => {
    expect(env({}, {}).NEMOCLAW_MODEL).toBe("qwen3.5:9b");
  });

  it("honors the workflow-owned GPU model", () => {
    expect(env({}, { NEMOCLAW_MODEL: "workflow/model" }).NEMOCLAW_MODEL).toBe("workflow/model");
  });

  it("forwards the workflow-owned trace directory through availability probes", () => {
    expect(env({}, { NEMOCLAW_TRACE_DIR: "/tmp/nemoclaw-traces" }).NEMOCLAW_TRACE_DIR).toBe(
      "/tmp/nemoclaw-traces",
    );
  });

  it("accepts an ANSI-colored exact Ready sandbox phase", () => {
    expect(hasExactReadyPhase("Sandbox:\n  \u001b[2mPhase:\u001b[0m Ready\n")).toBe(true);
  });

  it("rejects an ANSI-colored non-Ready sandbox phase", () => {
    expect(hasExactReadyPhase("Sandbox:\n  \u001b[2mPhase:\u001b[0m Error\n")).toBe(false);
  });

  it.each([
    ["Error before Ready", "Phase: Error\nPhase: Ready\n"],
    ["Ready before Error", "Phase: Ready\nPhase: Error\n"],
    ["prefixed Ready", "Current Phase: Ready\n"],
    ["suffixed Ready", "Phase: Ready (stale)\n"],
  ])("rejects %s output", (_case, output) => {
    expect(hasExactReadyPhase(output)).toBe(false);
  });

  it("accepts successful execution proof when the model suppresses visible text", () => {
    expect(() =>
      assertAgentExecutionSucceeded(agentOutput(), "inference", GPU_MODEL),
    ).not.toThrow();
  });

  it("rejects a recovery trace without a successful assistant attempt", () => {
    expect(() =>
      assertAgentExecutionSucceeded(
        agentOutput({ attemptResult: "error" }),
        "inference",
        GPU_MODEL,
      ),
    ).toThrow("execution trace must contain a successful assistant attempt");
  });

  it.each(invalidExecutionProofs)(
    "rejects invalid $name execution proof",
    ({ overrides, message }) => {
      expect(() =>
        assertAgentExecutionSucceeded(agentOutput(overrides), "inference", GPU_MODEL),
      ).toThrow(message);
    },
  );

  it("projects only model evidence before OpenClaw config crosses the artifact boundary", () => {
    const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-gpu-config-"));
    try {
      const configPath = path.join(root, "openclaw.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          agents: { defaults: { model: { primary: "inference/model" } } },
          models: { providers: {} },
          gateway: { auth: { token: "generated-gateway-secret" } },
        }),
      );

      const stdout = execFileSync(
        "bash",
        ["-lc", openClawModelConfigProjectionScript(configPath)],
        { encoding: "utf8" },
      );

      expect(JSON.parse(stdout)).toEqual({
        agents: { defaults: { model: { primary: "inference/model" } } },
        models: { providers: {} },
      });
      expect(stdout).not.toContain("generated-gateway-secret");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
