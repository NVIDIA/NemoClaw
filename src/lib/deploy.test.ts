// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildDeployEnvLines,
  executeDeploy,
  findBrevInstanceStatus,
  inferDeployProvider,
  isBrevInstanceFailed,
  isBrevInstanceReady,
} from "../../dist/lib/deploy";
import { validateName } from "../../dist/lib/runner";

describe("inferDeployProvider", () => {
  it("prefers an explicit provider override", () => {
    const provider = inferDeployProvider("openai", {
      NVIDIA_API_KEY: "nvapi-test",
    });

    expect(provider).toBe("openai");
  });

  it("infers the provider from a single matching credential", () => {
    const provider = inferDeployProvider("", {
      ANTHROPIC_API_KEY: "sk-ant-test",
    });

    expect(provider).toBe("anthropic");
  });

  it("returns null when multiple provider credentials are present without an override", () => {
    const provider = inferDeployProvider("", {
      NVIDIA_API_KEY: "nvapi-test",
      OPENAI_API_KEY: "sk-openai-test",
    });

    expect(provider).toBeNull();
  });
});

describe("buildDeployEnvLines", () => {
  it("includes standard non-interactive deploy env plus passthrough values", () => {
    const envLines = buildDeployEnvLines({
      env: {
        CHAT_UI_URL: "https://chat.example.com",
        NEMOCLAW_POLICY_MODE: "suggested",
      },
      sandboxName: "my-assistant",
      provider: "build",
      credentials: {
        NVIDIA_API_KEY: "nvapi-test",
      },
      shellQuote: (value: string) => `'${value}'`,
    });

    expect(envLines).toContain("NEMOCLAW_NON_INTERACTIVE=1");
    expect(envLines).toContain("NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1");
    expect(envLines).toContain("NEMOCLAW_SANDBOX_NAME='my-assistant'");
    expect(envLines).toContain("NEMOCLAW_PROVIDER='build'");
    expect(envLines).toContain("CHAT_UI_URL='https://chat.example.com'");
    expect(envLines).toContain("NEMOCLAW_POLICY_MODE='suggested'");
    expect(envLines).toContain("NVIDIA_API_KEY='nvapi-test'");
  });

  it("passes ALLOWED_CHAT_IDS through when Telegram is configured", () => {
    const envLines = buildDeployEnvLines({
      env: {},
      sandboxName: "my-assistant",
      provider: "build",
      credentials: {
        TELEGRAM_BOT_TOKEN: "123456:telegram-token",
        ALLOWED_CHAT_IDS: "111,222",
      },
      shellQuote: (value: string) => `'${value}'`,
    });

    expect(envLines).toContain("TELEGRAM_BOT_TOKEN='123456:telegram-token'");
    expect(envLines).toContain("ALLOWED_CHAT_IDS='111,222'");
  });

  it("passes HF_TOKEN and HUGGING_FACE_HUB_TOKEN to the VM when set", () => {
    const envLines = buildDeployEnvLines({
      env: {},
      sandboxName: "my-assistant",
      provider: "build",
      credentials: {
        NVIDIA_API_KEY: "nvapi-test",
        HF_TOKEN: "hf_abc123",
        HUGGING_FACE_HUB_TOKEN: "hf_def456",
      },
      shellQuote: (value: string) => `'${value}'`,
    });

    expect(envLines).toContain("HF_TOKEN='hf_abc123'");
    expect(envLines).toContain("HUGGING_FACE_HUB_TOKEN='hf_def456'");
  });

  it("omits ALLOWED_CHAT_IDS when Telegram is not configured", () => {
    const envLines = buildDeployEnvLines({
      env: {},
      sandboxName: "my-assistant",
      provider: "build",
      credentials: {
        ALLOWED_CHAT_IDS: "111,222",
      },
      shellQuote: (value: string) => `'${value}'`,
    });

    expect(envLines).not.toContain("ALLOWED_CHAT_IDS='111,222'");
  });
});

describe("executeDeploy", () => {
  function makeDeployOptions(overrides: Partial<Parameters<typeof executeDeploy>[0]> = {}) {
    const calls: Array<{ file?: string; args?: string[]; command?: readonly string[] }> = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const interactive: string[][] = [];
    let plainBrevList = "";

    const options: Parameters<typeof executeDeploy>[0] = {
      instanceName: "target",
      env: {
        NEMOCLAW_DEPLOY_NO_START_SERVICES: "1",
        NEMOCLAW_SANDBOX_NAME: "my-box",
      },
      rootDir: "/repo/root",
      getCredential: (key: string) => (key === "NVIDIA_API_KEY" ? "nvapi-test" : null),
      validateName: (value: string) => value,
      shellQuote: (value: string) => `'${value}'`,
      run: (command: readonly string[]) => {
        calls.push({ command });
      },
      runInteractive: (command: readonly string[]) => {
        interactive.push([...command]);
      },
      execFileSync: (file: string, args: string[]) => {
        calls.push({ file, args });
        if (file === "which" && args[0] === "brev") return "";
        if (file === "brev" && args[0] === "ls" && args[1] !== "--json") return plainBrevList;
        if (file === "brev" && args[0] === "ls" && args[1] === "--json") {
          return JSON.stringify([
            {
              name: "target",
              id: "brev-id-1",
              status: "RUNNING",
              build_status: "COMPLETED",
              shell_status: "READY",
            },
          ]);
        }
        if (file === "ssh" && args[0] === "-G") return "hostname target.example.test\n";
        if (file === "ssh" && args.includes("echo")) return "/home/tester\n";
        if (file === "ssh-keyscan") return "target.example.test ssh-ed25519 AAAA\n";
        return "";
      },
      spawnSync: () => undefined,
      log: (message = "") => {
        logs.push(message);
      },
      error: (message = "") => {
        errors.push(message);
      },
      stdoutWrite: (message: string) => {
        logs.push(message);
      },
      exit: (code: number): never => {
        throw new Error(`exit:${code}`);
      },
      ...overrides,
    };

    return { options, calls, logs, errors, interactive, setPlainBrevList: (value: string) => (plainBrevList = value) };
  }

  it("uses the standard installer, syncs a buildable checkout, pins SSH host keys, and connects to the requested sandbox", async () => {
    const fixture = makeDeployOptions();

    await executeDeploy(fixture.options);

    expect(fixture.calls.some((call) => call.command?.[0] === "brev" && call.command.includes("create") && call.command.includes("--provider") && call.command.includes("gcp"))).toBe(true);
    const rsync = fixture.calls.find((call) => call.command?.[0] === "rsync")?.command ?? [];
    expect(rsync).toContain("/repo/root/");
    expect(rsync).toContain("--exclude");
    expect(rsync).toContain("dist");
    expect(rsync).not.toContain("src");
    expect(fixture.calls.some((call) => call.file === "ssh-keyscan" && call.args?.includes("target.example.test"))).toBe(true);
    const sshCommands = [...fixture.calls.flatMap((call) => call.command ?? []), ...fixture.interactive.flat()];
    expect(sshCommands).toContain("StrictHostKeyChecking=yes");
    expect(sshCommands.some((arg) => String(arg).startsWith("UserKnownHostsFile="))).toBe(true);
    expect(sshCommands).not.toContain("StrictHostKeyChecking=accept-new");
    expect(fixture.interactive.some((command) => command.join(" ").includes("bash scripts/install.sh --non-interactive --yes-i-accept-third-party-software"))).toBe(true);
    expect(fixture.interactive.some((command) => command.join(" ").includes("openshell sandbox connect 'my-box'"))).toBe(true);
    expect(fixture.logs.join("\n")).toContain("Skipping service startup");
  });

  it("reports Brev failure states before SSH probing", async () => {
    const fixture = makeDeployOptions({
      execFileSync: (file: string, args: string[]) => {
        fixture.calls.push({ file, args });
        if (file === "which" && args[0] === "brev") return "";
        if (file === "brev" && args[0] === "ls" && args[1] !== "--json") return "target\n";
        if (file === "brev" && args[0] === "ls" && args[1] === "--json") {
          return JSON.stringify([
            {
              name: "target",
              id: "failed-id",
              status: "FAILURE",
              build_status: "PENDING",
              shell_status: "NOT_READY",
            },
          ]);
        }
        throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      },
    });

    await expect(executeDeploy(fixture.options)).rejects.toThrow("exit:1");

    const errorText = fixture.errors.join("\n");
    expect(errorText).toContain("Brev instance 'target' did not become ready.");
    expect(errorText).toContain("Try: brev reset target");
    expect(errorText).toContain("failed-id");
    expect(fixture.calls.some((call) => call.file === "ssh-keyscan")).toBe(false);
  });

  it("rejects invalid NEMOCLAW_SANDBOX_NAME before Brev provisioning", async () => {
    const fixture = makeDeployOptions({
      env: {
        NEMOCLAW_SANDBOX_NAME: "bad name",
        NEMOCLAW_PROVIDER: "build",
        NEMOCLAW_DEPLOY_NO_START_SERVICES: "1",
      },
      validateName,
    });

    await expect(executeDeploy(fixture.options)).rejects.toThrow("exit:1");

    const errorText = fixture.errors.join("\n");
    expect(errorText).toContain("Invalid sandbox name: 'bad name'");
    expect(errorText).toContain("Sandbox names cannot contain spaces.");
    expect(errorText).toContain(
      "Allowed format: lowercase, starts with a letter, letters/numbers/internal hyphens only, ends with letter/number.",
    );
    expect(errorText).toContain(
      "Brev deploy is non-interactive and cannot prompt for a corrected sandbox name.",
    );
    expect(errorText).toContain("Set NEMOCLAW_SANDBOX_NAME to a valid sandbox name and retry.");
    expect(fixture.calls).toEqual([]);
    expect(fixture.interactive).toEqual([]);
  });
});

describe("Brev status helpers", () => {
  it("finds the matching instance from brev ls json", () => {
    const status = findBrevInstanceStatus(
      JSON.stringify([
        { name: "other", status: "RUNNING" },
        { name: "target", status: "FAILURE", build_status: "PENDING", shell_status: "NOT READY" },
      ]),
      "target",
    );

    expect(status).toMatchObject({
      name: "target",
      status: "FAILURE",
      build_status: "PENDING",
      shell_status: "NOT READY",
    });
  });

  it("classifies Brev failure states", () => {
    expect(
      isBrevInstanceFailed({
        status: "FAILURE",
        build_status: "PENDING",
        shell_status: "NOT READY",
      }),
    ).toBe(true);
    expect(
      isBrevInstanceFailed({
        status: "RUNNING",
        build_status: "COMPLETED",
        shell_status: "READY",
      }),
    ).toBe(false);
  });

  it("only classifies Brev readiness when running, completed, and ready", () => {
    expect(
      isBrevInstanceReady({
        status: "RUNNING",
        build_status: "COMPLETED",
        shell_status: "READY",
      }),
    ).toBe(true);
    expect(
      isBrevInstanceReady({
        status: "RUNNING",
        build_status: "BUILDING",
        shell_status: "NOT READY",
      }),
    ).toBe(false);
  });
});
