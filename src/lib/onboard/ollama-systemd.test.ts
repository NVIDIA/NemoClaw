// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OLLAMA_PORT } from "../core/ports";
import { MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW } from "../inference/ollama-runtime-context";
import {
  ensureOllamaLoopbackSystemdOverride,
  mergeOllamaLoopbackSystemdOverride,
  shouldSkipOllamaLoopbackForMissingSudo,
} from "./ollama-systemd";

const SUDO_MODE_ENV = "NEMOCLAW_NON_INTERACTIVE_SUDO_MODE";

// Restore a process.env entry to its saved value (or delete it when the entry
// was previously unset). Lives at top of file so test bodies stay linear per
// the repository's growth guardrail on conditional branching in test files.
function restoreEnv(key: string, previous: string | undefined): void {
  previous === undefined ? delete process.env[key] : (process.env[key] = previous);
}

describe("mergeOllamaLoopbackSystemdOverride", () => {
  it("writes the OLLAMA_HOST and OLLAMA_CONTEXT_LENGTH lines under [Service] when no drop-in exists", () => {
    const out = mergeOllamaLoopbackSystemdOverride("");
    expect(out).toContain("[Service]");
    expect(out).toContain(`Environment="OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT}"`);
    expect(out).toContain(
      `Environment="OLLAMA_CONTEXT_LENGTH=${MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW}"`,
    );
  });

  it("preserves an existing user-supplied OLLAMA_CONTEXT_LENGTH that is above the NemoClaw floor", () => {
    const existing = [
      "[Service]",
      'Environment="OLLAMA_HOST=0.0.0.0:11434"',
      'Environment="OLLAMA_CONTEXT_LENGTH=65536"',
      "",
    ].join("\n");
    const out = mergeOllamaLoopbackSystemdOverride(existing);
    expect(out).toContain(`Environment="OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT}"`);
    expect(out).toContain('Environment="OLLAMA_CONTEXT_LENGTH=65536"');
    expect(out).not.toContain(
      `Environment="OLLAMA_CONTEXT_LENGTH=${MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW}"`,
    );
    // Legacy 0.0.0.0 line must be stripped.
    expect(out).not.toContain('Environment="OLLAMA_HOST=0.0.0.0:11434"');
  });

  it("replaces a stale OLLAMA_CONTEXT_LENGTH below the NemoClaw floor", () => {
    const existing = [
      "[Service]",
      'Environment="OLLAMA_HOST=127.0.0.1:11434"',
      'Environment="OLLAMA_CONTEXT_LENGTH=4096"',
      "",
    ].join("\n");
    const out = mergeOllamaLoopbackSystemdOverride(existing);
    expect(out).toContain(
      `Environment="OLLAMA_CONTEXT_LENGTH=${MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW}"`,
    );
    expect(out).not.toContain('Environment="OLLAMA_CONTEXT_LENGTH=4096"');
  });

  it("preserves unrelated variables sharing an Environment line with managed Ollama settings", () => {
    const existing = [
      "[Service]",
      'Environment="OLLAMA_CONTEXT_LENGTH=4096" "OLLAMA_ORIGINS=http://127.0.0.1" "HTTPS_PROXY=http://proxy.local"',
      "",
    ].join("\n");
    const out = mergeOllamaLoopbackSystemdOverride(existing);
    expect(out).toContain(
      'Environment="OLLAMA_ORIGINS=http://127.0.0.1" "HTTPS_PROXY=http://proxy.local"',
    );
    expect(out).toContain(
      `Environment="OLLAMA_CONTEXT_LENGTH=${MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW}"`,
    );
    expect(out).not.toContain('Environment="OLLAMA_CONTEXT_LENGTH=4096"');
  });

  it("keeps commented-out OLLAMA_CONTEXT_LENGTH lines verbatim", () => {
    const existing = [
      "[Service]",
      'Environment="OLLAMA_HOST=127.0.0.1:11434"',
      '# Environment="OLLAMA_CONTEXT_LENGTH=8192"',
      "",
    ].join("\n");
    const out = mergeOllamaLoopbackSystemdOverride(existing);
    expect(out).toContain('# Environment="OLLAMA_CONTEXT_LENGTH=8192"');
    expect(out).toContain(
      `Environment="OLLAMA_CONTEXT_LENGTH=${MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW}"`,
    );
  });

  it("threads through the libraryOverride option alongside the context length", () => {
    const out = mergeOllamaLoopbackSystemdOverride("", { libraryOverride: "cuda_v13" });
    expect(out).toContain('Environment="OLLAMA_LLM_LIBRARY=cuda_v13"');
    expect(out).toContain(
      `Environment="OLLAMA_CONTEXT_LENGTH=${MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW}"`,
    );
  });
});

// #5716: on a Linux aarch64 host running `nemoclaw onboard --non-interactive
// --yes` without passwordless sudo, the wizard previously aborted with
// "Refusing to continue with a potentially non-loopback Ollama bind" mid-flow.
// The new behaviour detects the missing `sudo -n` upfront and skips the
// loopback override with an actionable warning so the headless install can
// continue against Ollama's existing bind.
describe("ensureOllamaLoopbackSystemdOverride non-interactive sudo (#5716)", () => {
  // CR thread: isolate NEMOCLAW_NON_INTERACTIVE_SUDO_MODE so an outer shell
  // that has set it to `prompt` cannot change which branch of getSudoPrefix
  // these tests exercise. Each test in this block targets the `sudo -n`
  // branch and must see the env at its default.
  let savedSudoMode: string | undefined;
  beforeEach(() => {
    savedSudoMode = process.env[SUDO_MODE_ENV];
    delete process.env[SUDO_MODE_ENV];
  });
  afterEach(() => {
    restoreEnv(SUDO_MODE_ENV, savedSudoMode);
  });

  it("skips the override with a warning when sudo -n is unavailable in non-interactive mode", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = ensureOllamaLoopbackSystemdOverride({
        platformImpl: () => "linux",
        hasOllamaSystemdUnitImpl: () => true,
        isNonInteractive: () => true,
        hasPasswordlessSudoImpl: () => false,
      });
      expect(result).toBe("not-applicable");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("passwordless sudo is not available"),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  // Ultra advisor PRA-4 / CR follow-up: pin every branch of the new gate
  // via the pure `shouldSkipOllamaLoopbackForMissingSudo` decision so the
  // happy path is covered without falling through into the real systemd
  // override. Earlier round of this test called
  // `ensureOllamaLoopbackSystemdOverride` with
  // `hasPasswordlessSudoImpl: () => true`; on a Linux CI runner with
  // passwordless sudo, that would exec the real `sudo install / daemon-
  // reload / restart` host-boundary commands. CodeRabbit flagged that as
  // a non-hermetic unit test. The pure helper covers the contract without
  // any host-boundary touch.
  it("skips when getSudoPrefix is 'sudo -n' AND passwordless sudo is unavailable", () => {
    expect(shouldSkipOllamaLoopbackForMissingSudo("sudo -n", () => false)).toBe(true);
  });

  it("does NOT skip when getSudoPrefix is 'sudo -n' but passwordless sudo IS available", () => {
    expect(shouldSkipOllamaLoopbackForMissingSudo("sudo -n", () => true)).toBe(false);
  });

  it("does NOT skip when getSudoPrefix is 'sudo' (interactive), regardless of probe", () => {
    expect(shouldSkipOllamaLoopbackForMissingSudo("sudo", () => false)).toBe(false);
    expect(shouldSkipOllamaLoopbackForMissingSudo("sudo", () => true)).toBe(false);
  });

  it("does not invoke the passwordless-sudo probe when sudoPrefix is 'sudo'", () => {
    const probe = vi.fn(() => false);
    shouldSkipOllamaLoopbackForMissingSudo("sudo", probe);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns before Linux-only probes when not on Linux", () => {
    // CR thread: prove the platform gate by making the Linux-only probes
    // throw if reached. The platformImpl returns "darwin", so the function
    // should return "not-applicable" before touching any of the Linux
    // probes below.
    const result = ensureOllamaLoopbackSystemdOverride({
      platformImpl: () => "darwin",
      hasOllamaSystemdUnitImpl: () => {
        throw new Error("systemd probe should not run on non-Linux");
      },
      hasPasswordlessSudoImpl: () => {
        throw new Error("sudo probe should not run on non-Linux");
      },
      isNonInteractive: () => true,
    });
    expect(result).toBe("not-applicable");
  });
});
