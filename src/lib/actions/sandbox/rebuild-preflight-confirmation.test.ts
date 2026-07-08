// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import * as openshellResolve from "../../adapters/openshell/resolve";
import { redact } from "../../security/redact";
import * as sandboxSession from "../../state/sandbox-session";
import {
  confirmSandboxRebuildIfNeeded,
  countActiveSandboxSessionsForRebuild,
  createRebuildCommandContext,
} from "./rebuild-preflight-confirmation";
import { isSingleAgentRebuildSupported } from "./rebuild-preflight-guards";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rebuild confirmation", () => {
  it("accepts trimmed case-insensitive affirmative input", async () => {
    const prompt = vi.fn(async () => " YES ");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(confirmSandboxRebuildIfNeeded(false, 0, prompt)).resolves.toBe(true);

    expect(prompt).toHaveBeenCalledWith("  Proceed? [y/N]: ");
    expect(log).not.toHaveBeenCalledWith("  Cancelled.");
  });

  it("prints active-session risk before asking for confirmation", async () => {
    const prompt = vi.fn(async () => "n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(confirmSandboxRebuildIfNeeded(false, 2, prompt)).resolves.toBe(false);

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Active SSH sessions detected (2 connections)");
    expect(output).toContain("terminate all active sessions with a Broken pipe error");
    expect(output.indexOf("Active SSH sessions detected")).toBeLessThan(
      output.indexOf("Cancelled."),
    );
  });

  it("omits the active-session warning when detection yields no sessions", async () => {
    const prompt = vi.fn(async () => "n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(confirmSandboxRebuildIfNeeded(false, 0, prompt)).resolves.toBe(false);

    const output = log.mock.calls.flat().join("\n");
    expect(output).not.toContain("Active SSH");
    expect(output).toContain("Cancelled.");
  });

  it("does not prompt when confirmation is skipped", async () => {
    const prompt = vi.fn(async () => "n");
    await expect(confirmSandboxRebuildIfNeeded(true, 3, prompt)).resolves.toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("warns before the generic rebuild confirmation when thread auto-approval is enabled (#6478)", async () => {
    const prompt = vi.fn(async () => "n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(confirmSandboxRebuildIfNeeded(false, 0, prompt, "thread-opt-in")).resolves.toBe(
      false,
    );

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("thread auto-approval will be enabled");
    expect(output).toContain(
      "Tool calls, including shell commands, may execute without further confirmation inside OpenShell",
    );
    expect(output.indexOf("thread auto-approval will be enabled")).toBeLessThan(
      output.indexOf("This will:"),
    );
  });

  it("prints the auto-approval warning even when --yes skips the prompt (#6478)", async () => {
    const prompt = vi.fn(async () => "n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(confirmSandboxRebuildIfNeeded(true, 0, prompt, "thread-opt-in")).resolves.toBe(
      true,
    );

    expect(log.mock.calls.flat().join("\n")).toContain("including shell commands");
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe("createRebuildCommandContext bail behaviour (#6376)", () => {
  it("prints the bail message to stderr before exiting (non-throw mode)", () => {
    // Regression for #6376: the non-throw bail path used to discard its
    // `message` argument and just call `process.exit(code)`, so an actionable
    // reason (e.g. `Failed to preserve MCP bridges before rebuild: Sandbox
    // 'X' has an incomplete MCP destroy transaction ...`) exited 1 with NO
    // output, leaving the user without a diagnosis.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);

    const ctx = createRebuildCommandContext([], { throwOnError: false });
    expect(() => ctx.bail("Failed to preserve MCP bridges before rebuild: reason X", 1)).toThrow(
      "process.exit(1)",
    );

    // The message must reach stderr; `console.error` inherits the pipeline's
    // leading two-space rebuild-diagnostic prefix.
    expect(errorSpy).toHaveBeenCalledWith(
      "  Failed to preserve MCP bridges before rebuild: reason X",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("still exits with the requested code even when the message is empty (backward compat)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);

    const ctx = createRebuildCommandContext([], { throwOnError: false });
    expect(() => ctx.bail("", 2)).toThrow("process.exit(2)");

    // Empty messages must NOT be printed as a bare two-space line —
    // silence is fine when the caller passed nothing meaningful.
    expect(errorSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("keeps the throw-on-error path lossless (bail message becomes the Error)", () => {
    // Belt-and-suspenders: the other consumer of createRebuildCommandContext
    // (test / in-process callers) still gets the message via `throw new Error`.
    const ctx = createRebuildCommandContext([], { throwOnError: true });
    expect(() => ctx.bail("carried reason", 1)).toThrow("carried reason");
  });

  it("routes the surfaced bail message through the redaction boundary (#6376)", () => {
    // The bail message can wrap a lower-level error (`bail("...: " + err.message)`)
    // that carries a URL/token; the new stderr path must not become the one place
    // rebuild leaks a secret. It must apply the same `redact` boundary `log` uses.
    const raw =
      "Failed to preserve MCP bridges before rebuild: probe https://hub.example.test/v1?api_key=SUPERSECRETTOKEN123 failed";
    const redacted = redact(raw);
    // Sanity: the chosen message actually contains something the boundary scrubs,
    // so this test is meaningful regardless of redact's exact patterns.
    expect(redacted).not.toBe(raw);
    expect(redacted).not.toContain("SUPERSECRETTOKEN123");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);

    const ctx = createRebuildCommandContext([], { throwOnError: false });
    expect(() => ctx.bail(raw, 1)).toThrow("process.exit(1)");

    // What reached stderr is the redacted form, with the two-space prefix ...
    expect(errorSpy).toHaveBeenCalledWith(`  ${redacted}`);
    // ... and the raw secret never surfaced.
    for (const call of errorSpy.mock.calls) {
      expect(String(call[0])).not.toContain("SUPERSECRETTOKEN123");
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("rebuild preflight guards", () => {
  it("rejects a multi-agent sandbox before later rebuild work", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bail = (message: string): never => {
      throw new Error(message);
    };

    expect(() =>
      isSingleAgentRebuildSupported(
        { name: "alpha", agents: [{ name: "openclaw" }, { name: "hermes" }] } as never,
        bail,
      ),
    ).toThrow("Multi-agent sandbox rebuild is not yet supported");

    const output = error.mock.calls.flat().join("\n");
    expect(output).toContain("Multi-agent sandbox rebuild is not yet supported");
    expect(output).toContain("Back up state manually");
  });

  it("treats an unavailable OpenShell session detector as zero active sessions", () => {
    vi.spyOn(openshellResolve, "resolveOpenshell").mockReturnValue(null);
    expect(countActiveSandboxSessionsForRebuild("alpha")).toBe(0);
  });

  it("treats a session detector failure as zero active sessions", () => {
    vi.spyOn(openshellResolve, "resolveOpenshell").mockReturnValue("/usr/bin/openshell");
    vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockImplementation(() => {
      throw new Error("session detector unavailable");
    });

    expect(countActiveSandboxSessionsForRebuild("alpha")).toBe(0);
  });
});
