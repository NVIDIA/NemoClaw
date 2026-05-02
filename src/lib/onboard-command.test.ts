// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  parseOnboardArgs,
  runDeprecatedOnboardAliasCommand,
  runOnboardCommand,
} from "./onboard-command";

function exitWithCode(code: number): never {
  throw new Error(String(code));
}

function exitWithPrefixedCode(code: number): never {
  throw new Error(`exit:${code}`);
}

describe("onboard command", () => {
  it("parses onboard flags", () => {
    expect(
      parseOnboardArgs(
        ["--non-interactive", "--resume", "--yes-i-accept-third-party-software"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          error: () => {},
          exit: exitWithCode,
        },
      ),
    ).toEqual({
      nonInteractive: true,
      resume: true,
      fresh: false,
      recreateSandbox: false,
      fromDockerfile: null,
      sandboxName: null,
      acceptThirdPartySoftware: true,
      agent: null,
      controlUiPort: null,
    });
  });

  it("accepts the env-based third-party notice acknowledgement", () => {
    expect(
      parseOnboardArgs(
        [],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: { NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1" },
          error: () => {},
          exit: exitWithCode,
        },
      ),
    ).toEqual({
      nonInteractive: false,
      resume: false,
      fresh: false,
      recreateSandbox: false,
      fromDockerfile: null,
      sandboxName: null,
      acceptThirdPartySoftware: true,
      agent: null,
      controlUiPort: null,
    });
  });

  it("runs onboard with parsed options", async () => {
    const runOnboard = vi.fn(async () => {});
    await runOnboardCommand({
      args: ["--resume"],
      noticeAcceptFlag: "--yes-i-accept-third-party-software",
      noticeAcceptEnv: "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
      env: {},
      runOnboard,
      error: () => {},
      exit: exitWithCode,
    });
    expect(runOnboard).toHaveBeenCalledWith({
      nonInteractive: false,
      resume: true,
      fresh: false,
      recreateSandbox: false,
      fromDockerfile: null,
      sandboxName: null,
      acceptThirdPartySoftware: false,
      agent: null,
      controlUiPort: null,
    });
  });

  it("prints usage and skips onboarding for --help", async () => {
    const runOnboard = vi.fn(async () => {});
    const lines: string[] = [];
    await runOnboardCommand({
      args: ["--help"],
      noticeAcceptFlag: "--yes-i-accept-third-party-software",
      noticeAcceptEnv: "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
      env: {},
      runOnboard,
      log: (message = "") => lines.push(message),
      error: () => {},
      exit: exitWithCode,
    });
    expect(runOnboard).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("Usage: nemoclaw onboard");
    expect(lines.join("\n")).toContain("--from <Dockerfile>");
    expect(lines.join("\n")).toContain("--name <sandbox>");
    expect(lines.join("\n")).toContain("Dockerfile's parent directory");
    expect(lines.join("\n")).toContain("node_modules, .git, .venv, __pycache__");
    expect(lines.join("\n")).toContain(".env*, .ssh, .aws");
    expect(lines.join("\n")).toContain("--agent <name>");
  });

  it("parses --from <Dockerfile>", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-from-parse-"));
    const dockerfilePath = path.join(tmpDir, "Custom.Dockerfile");
    fs.writeFileSync(dockerfilePath, "FROM scratch\n");

    expect(
      parseOnboardArgs(
        ["--resume", "--from", dockerfilePath],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          error: () => {},
          exit: exitWithCode,
        },
      ),
    ).toEqual({
      nonInteractive: false,
      resume: true,
      fresh: false,
      recreateSandbox: false,
      fromDockerfile: dockerfilePath,
      sandboxName: null,
      acceptThirdPartySoftware: false,
      agent: null,
      controlUiPort: null,
    });
  });

  it("parses --fresh and surfaces it as fresh=true", () => {
    expect(
      parseOnboardArgs(
        ["--fresh"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          error: () => {},
          exit: exitWithCode,
        },
      ),
    ).toEqual({
      nonInteractive: false,
      resume: false,
      fresh: true,
      recreateSandbox: false,
      fromDockerfile: null,
      sandboxName: null,
      acceptThirdPartySoftware: false,
      agent: null,
      controlUiPort: null,
    });
  });

  it("rejects --resume and --fresh together", () => {
    const errors: string[] = [];
    expect(() =>
      parseOnboardArgs(
        ["--resume", "--fresh"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          error: (message = "") => errors.push(message),
          exit: exitWithPrefixedCode,
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("--resume and --fresh are mutually exclusive");
  });

  it("parses --name <sandbox>", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-name-parse-"));
    const dockerfilePath = path.join(tmpDir, "Custom.Dockerfile");
    fs.writeFileSync(dockerfilePath, "FROM scratch\n");

    expect(
      parseOnboardArgs(
        ["--non-interactive", "--from", dockerfilePath, "--name", "second-assistant"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          error: () => {},
          exit: exitWithCode,
        },
      ),
    ).toEqual({
      nonInteractive: true,
      resume: false,
      fresh: false,
      recreateSandbox: false,
      fromDockerfile: dockerfilePath,
      sandboxName: "second-assistant",
      acceptThirdPartySoftware: false,
      agent: null,
      controlUiPort: null,
    });
  });

  it("exits when --name is missing its sandbox value", () => {
    const errors: string[] = [];
    expect(() =>
      parseOnboardArgs(
        ["--name"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          error: (message = "") => errors.push(message),
          exit: exitWithPrefixedCode,
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("--name requires a sandbox name");
  });

  it("exits when --name is followed by another flag instead of a value", () => {
    const errors: string[] = [];
    expect(() =>
      parseOnboardArgs(
        ["--name", "--resume"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          error: (message = "") => errors.push(message),
          exit: exitWithPrefixedCode,
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("--name requires a sandbox name");
  });

  it("exits when --from is missing its Dockerfile path", () => {
    expect(() =>
      parseOnboardArgs(
        ["--from"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          error: () => {},
          exit: exitWithPrefixedCode,
        },
      ),
    ).toThrow("exit:1");
  });

  it("exits before onboarding when --from points to a missing Dockerfile", async () => {
    const runOnboard = vi.fn(async () => {});
    const errors: string[] = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-from-missing-"));

    await expect(
      runOnboardCommand({
        args: ["--from", path.join(tmpDir, "no-such-dockerfile-2589")],
        noticeAcceptFlag: "--yes-i-accept-third-party-software",
        noticeAcceptEnv: "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        env: {},
        runOnboard,
        error: (message = "") => errors.push(message),
        exit: exitWithPrefixedCode,
      }),
    ).rejects.toThrow("exit:1");

    expect(runOnboard).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("--from path not found:");
  });

  it("exits before onboarding when --from points to a directory", async () => {
    const runOnboard = vi.fn(async () => {});
    const errors: string[] = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-from-dir-"));

    await expect(
      runOnboardCommand({
        args: ["--from", tmpDir],
        noticeAcceptFlag: "--yes-i-accept-third-party-software",
        noticeAcceptEnv: "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        env: {},
        runOnboard,
        error: (message = "") => errors.push(message),
        exit: exitWithPrefixedCode,
      }),
    ).rejects.toThrow("exit:1");

    expect(runOnboard).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("--from must point to a Dockerfile:");
  });

  it("exits with usage on unknown args", () => {
    const errors: string[] = [];
    expect(() =>
      parseOnboardArgs(
        ["--bad-flag"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          error: (message = "") => errors.push(message),
          exit: exitWithPrefixedCode,
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("Unknown onboard option(s): --bad-flag");
    expect(errors.join("\n")).toContain("Usage: nemoclaw onboard");
  });

  it("parses --agent", () => {
    expect(
      parseOnboardArgs(
        ["--agent", "openclaw"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          listAgents: () => ["openclaw", "hermes"],
          error: () => {},
          exit: exitWithCode,
        },
      ),
    ).toEqual({
      nonInteractive: false,
      resume: false,
      fresh: false,
      recreateSandbox: false,
      fromDockerfile: null,
      sandboxName: null,
      acceptThirdPartySoftware: false,
      agent: "openclaw",
      controlUiPort: null,
    });
  });

  it("rejects unknown --agent values", () => {
    const errors: string[] = [];
    expect(() =>
      parseOnboardArgs(
        ["--agent", "bogus"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          listAgents: () => ["openclaw", "hermes"],
          error: (message = "") => errors.push(message),
          exit: exitWithPrefixedCode,
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("Unknown agent 'bogus'");
    expect(errors.join("\n")).toContain("Usage: nemoclaw onboard");
  });

  it("parses --control-ui-port with a valid port", () => {
    const result = parseOnboardArgs(
      ["--control-ui-port", "18790"],
      "--yes-i-accept-third-party-software",
      "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
      {
        env: {},
        error: () => {},
        exit: ((code: number) => {
          throw new Error(String(code));
        }) as never,
      },
    );
    expect(result.controlUiPort).toBe(18790);
  });

  it("exits when --control-ui-port is missing its value", () => {
    expect(() =>
      parseOnboardArgs(
        ["--control-ui-port"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          error: () => {},
          exit: ((code: number) => {
            throw new Error(`exit:${code}`);
          }) as never,
        },
      ),
    ).toThrow("exit:1");
  });

  it("exits when --control-ui-port value is out of range", () => {
    const errors: string[] = [];
    expect(() =>
      parseOnboardArgs(
        ["--control-ui-port", "80"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          error: (message = "") => errors.push(message),
          exit: ((code: number) => {
            throw new Error(`exit:${code}`);
          }) as never,
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("1024-65535");
  });

  it("--control-ui-port takes precedence over CHAT_UI_URL env", () => {
    const result = parseOnboardArgs(
      ["--control-ui-port", "19000"],
      "--yes-i-accept-third-party-software",
      "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
      {
        env: { CHAT_UI_URL: "http://127.0.0.1:18790" },
        error: () => {},
        exit: ((code: number) => {
          throw new Error(String(code));
        }) as never,
      },
    );
    expect(result.controlUiPort).toBe(19000);
  });

  it("--help includes --control-ui-port in usage", async () => {
    const lines: string[] = [];
    await runOnboardCommand({
      args: ["--help"],
      noticeAcceptFlag: "--yes-i-accept-third-party-software",
      noticeAcceptEnv: "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
      env: {},
      runOnboard: vi.fn(async () => {}),
      log: (message = "") => lines.push(message),
      error: () => {},
      exit: ((code: number) => {
        throw new Error(String(code));
      }) as never,
    });
    expect(lines.join("\n")).toContain("--control-ui-port");
  });

  it("prints the setup-spark deprecation text before delegating", async () => {
    const lines: string[] = [];
    const runOnboard = vi.fn(async () => {});
    await runDeprecatedOnboardAliasCommand({
      kind: "setup-spark",
      args: [],
      noticeAcceptFlag: "--yes-i-accept-third-party-software",
      noticeAcceptEnv: "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
      env: {},
      runOnboard,
      log: (message = "") => lines.push(message),
      error: () => {},
      exit: exitWithCode,
    });
    expect(lines.join("\n")).toContain("setup-spark` is deprecated");
    expect(lines.join("\n")).toContain("Use `nemoclaw onboard` instead");
    expect(runOnboard).toHaveBeenCalledTimes(1);
    expect(runOnboard).toHaveBeenCalledWith({
      nonInteractive: false,
      resume: false,
      fresh: false,
      recreateSandbox: false,
      fromDockerfile: null,
      sandboxName: null,
      acceptThirdPartySoftware: false,
      agent: null,
      controlUiPort: null,
    });
  });

  it("prints the setup deprecation text before delegating", async () => {
    const lines: string[] = [];
    const runOnboard = vi.fn(async () => {});
    await runDeprecatedOnboardAliasCommand({
      kind: "setup",
      args: [],
      noticeAcceptFlag: "--yes-i-accept-third-party-software",
      noticeAcceptEnv: "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
      env: {},
      runOnboard,
      log: (message = "") => lines.push(message),
      error: () => {},
      exit: exitWithCode,
    });
    expect(lines.join("\n")).toContain("`nemoclaw setup` is deprecated");
    expect(lines.join("\n")).toContain("Use `nemoclaw onboard` instead");
    expect(runOnboard).toHaveBeenCalledTimes(1);
  });
});
