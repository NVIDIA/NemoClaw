// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
      acceptThirdPartySoftware: true,
      agent: null,
      dangerouslySkipPermissions: false,
      controlUiPort: null,
      sandboxName: null,
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
      acceptThirdPartySoftware: true,
      agent: null,
      dangerouslySkipPermissions: false,
      controlUiPort: null,
      sandboxName: null,
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
      acceptThirdPartySoftware: false,
      agent: null,
      dangerouslySkipPermissions: false,
      controlUiPort: null,
      sandboxName: null,
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
    expect(lines.join("\n")).toContain("--agent <name>");
    expect(lines.join("\n")).toContain("--dangerously-skip-permissions");
  });

  it("parses --from <Dockerfile>", () => {
    expect(
      parseOnboardArgs(
        ["--resume", "--from", "/tmp/Custom.Dockerfile"],
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
      fromDockerfile: "/tmp/Custom.Dockerfile",
      acceptThirdPartySoftware: false,
      agent: null,
      dangerouslySkipPermissions: false,
      controlUiPort: null,
      sandboxName: null,
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
      acceptThirdPartySoftware: false,
      agent: null,
      dangerouslySkipPermissions: false,
      controlUiPort: null,
      sandboxName: null,
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

  it("parses --agent and --dangerously-skip-permissions", () => {
    expect(
      parseOnboardArgs(
        ["--agent", "openclaw", "--dangerously-skip-permissions"],
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
      acceptThirdPartySoftware: false,
      agent: "openclaw",
      dangerouslySkipPermissions: true,
      controlUiPort: null,
      sandboxName: null,
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
      acceptThirdPartySoftware: false,
      agent: null,
      dangerouslySkipPermissions: false,
      controlUiPort: null,
      sandboxName: null,
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
  it("parses --name <sandbox-name>", () => {
    const result = parseOnboardArgs(
      ["--non-interactive", "--name", "deepobs", "--from", "/path/to/Dockerfile"],
      "--yes-i-accept-third-party-software",
      "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
      {
        env: {},
        error: () => {},
        exit: exitWithCode,
      },
    );
    expect(result.sandboxName).toBe("deepobs");
    expect(result.fromDockerfile).toBe("/path/to/Dockerfile");
    expect(result.nonInteractive).toBe(true);
  });

  it("rejects --name with no following value", () => {
    const errorMessages: string[] = [];
    expect(() =>
      parseOnboardArgs(
        ["--name"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          error: (msg) => {
            errorMessages.push(String(msg ?? ""));
          },
          exit: exitWithCode,
        },
      ),
    ).toThrow();
    expect(errorMessages.join("\n")).toMatch(/--name requires a sandbox name/);
  });

  it("rejects --name <flag> (treats next flag as missing value)", () => {
    const errorMessages: string[] = [];
    expect(() =>
      parseOnboardArgs(
        ["--name", "--from", "/path/to/Dockerfile"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          error: (msg) => {
            errorMessages.push(String(msg ?? ""));
          },
          exit: exitWithCode,
        },
      ),
    ).toThrow();
    expect(errorMessages.join("\n")).toMatch(/--name requires a sandbox name/);
  });

  it("propagates --name to NEMOCLAW_SANDBOX_NAME so promptValidatedSandboxName picks it up", async () => {
    const env: NodeJS.ProcessEnv = {};
    const runOnboard = vi.fn(async () => {});
    await runOnboardCommand({
      args: ["--non-interactive", "--name", "my-deepobs"],
      noticeAcceptFlag: "--yes-i-accept-third-party-software",
      noticeAcceptEnv: "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
      env,
      runOnboard,
      error: () => {},
      exit: exitWithCode,
    });
    expect(env.NEMOCLAW_SANDBOX_NAME).toBe("my-deepobs");
    expect(runOnboard).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: "my-deepobs" }),
    );
  });

  it("does not touch NEMOCLAW_SANDBOX_NAME when --name is absent", async () => {
    const env: NodeJS.ProcessEnv = { NEMOCLAW_SANDBOX_NAME: "existing-default" };
    const runOnboard = vi.fn(async () => {});
    await runOnboardCommand({
      args: ["--non-interactive"],
      noticeAcceptFlag: "--yes-i-accept-third-party-software",
      noticeAcceptEnv: "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
      env,
      runOnboard,
      error: () => {},
      exit: exitWithCode,
    });
    expect(env.NEMOCLAW_SANDBOX_NAME).toBe("existing-default");
  });

  it("rejects --non-interactive without --name and without NEMOCLAW_SANDBOX_NAME", () => {
    const errorMessages: string[] = [];
    expect(() =>
      parseOnboardArgs(
        ["--non-interactive", "--from", "/path/to/Dockerfile"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          error: (msg) => {
            errorMessages.push(String(msg ?? ""));
          },
          exit: exitWithCode,
        },
      ),
    ).toThrow();
    expect(errorMessages.join("\n")).toMatch(
      /--non-interactive requires --name <sandbox-name>/,
    );
  });

  it("accepts --non-interactive when --name is provided", () => {
    const result = parseOnboardArgs(
      ["--non-interactive", "--name", "my-deepobs"],
      "--yes-i-accept-third-party-software",
      "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
      {
        env: {},
        error: () => {},
        exit: exitWithCode,
      },
    );
    expect(result.nonInteractive).toBe(true);
    expect(result.sandboxName).toBe("my-deepobs");
  });

  it("accepts --non-interactive when NEMOCLAW_SANDBOX_NAME env var is set", () => {
    const result = parseOnboardArgs(
      ["--non-interactive"],
      "--yes-i-accept-third-party-software",
      "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
      {
        env: { NEMOCLAW_SANDBOX_NAME: "from-env" },
        error: () => {},
        exit: exitWithCode,
      },
    );
    expect(result.nonInteractive).toBe(true);
    expect(result.sandboxName).toBe(null);
  });

  it("treats whitespace-only NEMOCLAW_SANDBOX_NAME as missing", () => {
    const errorMessages: string[] = [];
    expect(() =>
      parseOnboardArgs(
        ["--non-interactive"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: { NEMOCLAW_SANDBOX_NAME: "   " },
          error: (msg) => {
            errorMessages.push(String(msg ?? ""));
          },
          exit: exitWithCode,
        },
      ),
    ).toThrow();
    expect(errorMessages.join("\n")).toMatch(
      /--non-interactive requires --name <sandbox-name>/,
    );
  });

  it("exempts --resume from the non-interactive name requirement (session has the name)", () => {
    const result = parseOnboardArgs(
      ["--non-interactive", "--resume"],
      "--yes-i-accept-third-party-software",
      "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
      {
        env: {},
        error: () => {},
        exit: exitWithCode,
      },
    );
    expect(result.nonInteractive).toBe(true);
    expect(result.resume).toBe(true);
    expect(result.sandboxName).toBe(null);
  });

});
