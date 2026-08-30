// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as store from "../../credentials/store";
import * as policies from "../../policy";
import { digestBaselineEntry } from "../../policy/baseline-exclusion";
import type { PolicyObject } from "../../policy/preset-parsing";

vi.mock("../../state/mcp-lifecycle-lock", () => ({
  withSandboxMutationLock: <T>(_name: string, action: () => Promise<T>) => action(),
}));
vi.mock("./policy-context-refresh", () => ({
  refreshSandboxPolicyContextFile: vi.fn(),
}));

import { excludeSandboxBaseline, restoreSandboxBaseline } from "./policy-channel";

class ExitError extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const BASE_CONTENT = `version: 1
network_policies:
  nous_research:
    name: nous_research
    endpoints:
      - host: nousresearch.com
        port: 443
        rules:
          - allow: { method: GET, path: "/**" }
  managed_inference:
    name: managed_inference
    endpoints:
      - host: inference.local
`;

const NOUS_ENTRY: PolicyObject = {
  name: "nous_research",
  endpoints: [{ host: "nousresearch.com", port: 443 }],
};

let exitSpy: MockInstance;
let promptMock: MockInstance;
let excludeBaselineEntryMock: MockInstance;
let restoreBaselineEntryMock: MockInstance;

async function captureExit(action: () => Promise<void>): Promise<number | undefined> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ExitError);
    return (error as ExitError).code;
  }
  throw new Error("Expected process.exit to be called");
}

let stdinIsTty: PropertyDescriptor | undefined;

function arrangeTerminal(present: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: present ? true : undefined,
  });
}

beforeEach(() => {
  delete process.env.NEMOCLAW_NON_INTERACTIVE;
  stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  arrangeTerminal(true);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code);
  }) as never);
  promptMock = vi.spyOn(store, "prompt").mockResolvedValue("y");

  vi.spyOn(policies, "resolveSandboxBaselinePolicy").mockReturnValue({
    agent: "hermes",
    policyPath: "/repo/policy-additions.yaml",
    content: BASE_CONTENT,
  });
  vi.spyOn(policies, "getSandboxBaselineEntry").mockImplementation((_sandbox, key) =>
    key === "nous_research" ? NOUS_ENTRY : null,
  );
  vi.spyOn(policies, "getSandboxBaselineEntryDigest").mockReturnValue("digest-1");
  excludeBaselineEntryMock = vi.spyOn(policies, "excludeBaselineEntry").mockReturnValue(true);
  restoreBaselineEntryMock = vi.spyOn(policies, "restoreBaselineEntry").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEMOCLAW_NON_INTERACTIVE;
  stdinIsTty
    ? Object.defineProperty(process.stdin, "isTTY", stdinIsTty)
    : Reflect.deleteProperty(process.stdin, "isTTY");
});

describe("excludeSandboxBaseline (#7178)", () => {
  it("does not mutate when a recorded agent baseline cannot be resolved (#7194)", async () => {
    vi.mocked(policies.resolveSandboxBaselinePolicy).mockImplementation(() => {
      throw new Error("Refusing to substitute the OpenClaw baseline");
    });

    await expect(
      excludeSandboxBaseline("alpha", { key: "nous_research", force: true }),
    ).rejects.toThrow("Refusing to substitute the OpenClaw baseline");

    expect(excludeBaselineEntryMock).not.toHaveBeenCalled();
  });

  it("exits on an unknown baseline key without mutating", async () => {
    const code = await captureExit(() =>
      excludeSandboxBaseline("alpha", { key: "absent", force: true }),
    );
    expect(code).toBe(1);
    expect(excludeBaselineEntryMock).not.toHaveBeenCalled();
  });

  it("refuses to exclude a protected baseline entry", async () => {
    vi.spyOn(policies, "getSandboxBaselineEntry").mockReturnValue({ name: "managed_inference" });
    const code = await captureExit(() =>
      excludeSandboxBaseline("alpha", { key: "managed_inference", force: true }),
    );
    expect(code).toBe(1);
    expect(excludeBaselineEntryMock).not.toHaveBeenCalled();
  });

  it("requires explicit acknowledgement in non-interactive mode", async () => {
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";
    const code = await captureExit(() => excludeSandboxBaseline("alpha", { key: "nous_research" }));
    expect(code).toBe(1);
    expect(excludeBaselineEntryMock).not.toHaveBeenCalled();
  });

  it("requires explicit acknowledgement when standard input has no terminal (#8877)", async () => {
    arrangeTerminal(false);

    const code = await captureExit(() => excludeSandboxBaseline("alpha", { key: "nous_research" }));

    expect(code).toBe(1);
    expect(promptMock).not.toHaveBeenCalled();
    expect(excludeBaselineEntryMock).not.toHaveBeenCalled();
  });

  it("excludes with a bound digest when acknowledged via --force", async () => {
    await excludeSandboxBaseline("alpha", { key: "nous_research", force: true });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Support impact: Hermes public metadata lookup and agent updates may stop working.",
      ),
    );
    expect(promptMock).not.toHaveBeenCalled();
    expect(excludeBaselineEntryMock).toHaveBeenCalledWith(
      "alpha",
      "nous_research",
      expect.any(String),
    );
  });

  it("discloses the affected feature before interactive acknowledgement", async () => {
    promptMock.mockImplementation(async () => {
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining(
          "Support impact: Hermes public metadata lookup and agent updates may stop working.",
        ),
      );
      return "n";
    });

    await excludeSandboxBaseline("alpha", { key: "nous_research" });

    expect(promptMock).toHaveBeenCalledOnce();
    expect(excludeBaselineEntryMock).not.toHaveBeenCalled();
  });

  it("fails closed when an entry has no reviewed feature disclosure", async () => {
    vi.spyOn(policies, "getSandboxBaselineEntry").mockReturnValue({ name: "future_entry" });
    const code = await captureExit(() =>
      excludeSandboxBaseline("alpha", { key: "future_entry", force: true }),
    );

    expect(code).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("has no supported-feature impact disclosure"),
    );
    expect(excludeBaselineEntryMock).not.toHaveBeenCalled();
  });

  it("does not mutate on --dry-run", async () => {
    await excludeSandboxBaseline("alpha", { key: "nous_research", dryRun: true });
    expect(excludeBaselineEntryMock).not.toHaveBeenCalled();
  });

  it("aborts when the interactive confirmation is declined", async () => {
    promptMock.mockResolvedValue("n");
    await excludeSandboxBaseline("alpha", { key: "nous_research" });
    expect(excludeBaselineEntryMock).not.toHaveBeenCalled();
  });
});

describe("restoreSandboxBaseline (#7178)", () => {
  it("restores a live missing baseline entry after interactive acknowledgement", async () => {
    await restoreSandboxBaseline("alpha", { key: "nous_research" });
    expect(promptMock).toHaveBeenCalledOnce();
    expect(restoreBaselineEntryMock).toHaveBeenCalledWith("alpha", "nous_research", {
      expectedTargetDigest: digestBaselineEntry(NOUS_ENTRY),
    });
  });

  it("requires explicit acknowledgement in non-interactive mode (#8114)", async () => {
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";
    const code = await captureExit(() => restoreSandboxBaseline("alpha", { key: "nous_research" }));
    expect(code).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Non-interactive restore requires explicit acknowledgement"),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Usage: nemoclaw <sandbox> policy restore <key>"),
    );
    expect(promptMock).not.toHaveBeenCalled();
    expect(restoreBaselineEntryMock).not.toHaveBeenCalled();
  });

  it("requires explicit restore acknowledgement when standard input has no terminal (#8877)", async () => {
    arrangeTerminal(false);

    const code = await captureExit(() => restoreSandboxBaseline("alpha", { key: "nous_research" }));

    expect(code).toBe(1);
    expect(promptMock).not.toHaveBeenCalled();
    expect(restoreBaselineEntryMock).not.toHaveBeenCalled();
  });

  it("does not restore when standard input closes before acknowledgement (#8114)", async () => {
    promptMock.mockRejectedValue(
      Object.assign(new Error("Prompt closed before input"), { code: "EOF" }),
    );

    const code = await captureExit(() => restoreSandboxBaseline("alpha", { key: "nous_research" }));

    expect(code).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("No input available on stdin"),
    );
    expect(restoreBaselineEntryMock).not.toHaveBeenCalled();
  });

  it("restores without prompting when acknowledged via --yes (#8114)", async () => {
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";
    await restoreSandboxBaseline("alpha", { key: "nous_research", yes: true });
    expect(promptMock).not.toHaveBeenCalled();
    expect(restoreBaselineEntryMock).toHaveBeenCalledWith("alpha", "nous_research", {
      expectedTargetDigest: digestBaselineEntry(NOUS_ENTRY),
    });
  });

  it("restores without prompting when acknowledged via --force (#8114)", async () => {
    await restoreSandboxBaseline("alpha", { key: "nous_research", force: true });
    expect(promptMock).not.toHaveBeenCalled();
    expect(restoreBaselineEntryMock).toHaveBeenCalledWith("alpha", "nous_research", {
      expectedTargetDigest: digestBaselineEntry(NOUS_ENTRY),
    });
  });

  it("binds stale exclusion cleanup to an absent preview", async () => {
    vi.mocked(policies.getSandboxBaselineEntry).mockReturnValue(null);

    await restoreSandboxBaseline("alpha", { key: "legacy_entry", force: true });

    expect(restoreBaselineEntryMock).toHaveBeenCalledWith("alpha", "legacy_entry", {
      expectedTargetDigest: null,
    });
  });

  it("discloses the restored egress before interactive acknowledgement (#8114)", async () => {
    promptMock.mockImplementation(async () => {
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("re-allows:"));
      return "n";
    });

    await restoreSandboxBaseline("alpha", { key: "nous_research" });

    expect(promptMock).toHaveBeenCalledOnce();
    expect(restoreBaselineEntryMock).not.toHaveBeenCalled();
  });

  it("aborts when the interactive confirmation is declined (#8114)", async () => {
    promptMock.mockResolvedValue("n");
    await restoreSandboxBaseline("alpha", { key: "nous_research" });
    expect(restoreBaselineEntryMock).not.toHaveBeenCalled();
  });

  it("reports the cancellation when the interactive confirmation is declined", async () => {
    promptMock.mockResolvedValue("n");
    await restoreSandboxBaseline("alpha", { key: "nous_research" });
    expect(console.log).toHaveBeenCalledWith("  Cancelled.");
    expect(restoreBaselineEntryMock).not.toHaveBeenCalled();
  });

  it("does not mutate on --dry-run", async () => {
    await restoreSandboxBaseline("alpha", { key: "nous_research", dryRun: true });
    expect(promptMock).not.toHaveBeenCalled();
    expect(restoreBaselineEntryMock).not.toHaveBeenCalled();
  });

  it("does not mutate when a recorded agent baseline cannot be resolved (#7194)", async () => {
    vi.mocked(policies.resolveSandboxBaselinePolicy).mockImplementation(() => {
      throw new Error("Refusing to substitute the OpenClaw baseline");
    });

    await expect(restoreSandboxBaseline("alpha", { key: "nous_research" })).rejects.toThrow(
      "Refusing to substitute the OpenClaw baseline",
    );

    expect(restoreBaselineEntryMock).not.toHaveBeenCalled();
  });
});
