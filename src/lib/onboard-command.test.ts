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
