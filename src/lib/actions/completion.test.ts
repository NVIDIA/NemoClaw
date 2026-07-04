// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { detectShell, generateCompletionScript, runCompletionAction } from "./completion";

describe("detectShell", () => {
  it("detects zsh from SHELL", () => {
    expect(detectShell("/bin/zsh")).toBe("zsh");
  });

  it("detects fish from SHELL", () => {
    expect(detectShell("/usr/local/bin/fish")).toBe("fish");
  });

  it("defaults to bash", () => {
    expect(detectShell("/bin/bash")).toBe("bash");
    expect(detectShell(undefined)).toBe("bash");
    expect(detectShell("")).toBe("bash");
  });
});

describe("generateCompletionScript", () => {
  it("emits a bash completion function", () => {
    const script = generateCompletionScript("bash");
    expect(script).toContain("_nemoclaw()");
    expect(script).toContain("complete -F _nemoclaw nemoclaw");
  });

  it("emits a zsh compdef", () => {
    const script = generateCompletionScript("zsh");
    expect(script).toContain("#compdef nemoclaw");
  });

  it("emits fish completions", () => {
    const script = generateCompletionScript("fish");
    expect(script).toContain("__nemoclaw_sandboxes");
  });

  it("reads sandbox names from list --json in every shell", () => {
    expect(generateCompletionScript("bash")).toContain("nemoclaw list --json");
    expect(generateCompletionScript("zsh")).toContain("nemoclaw list --json");
    expect(generateCompletionScript("fish")).toContain("nemoclaw list --json");
  });

  it("includes the same sandbox subcommands in fish as in bash", () => {
    const bash = generateCompletionScript("bash");
    const fish = generateCompletionScript("fish");
    const probes = ["gateway-token", "policy-explain", "share:mount", "config:rotate-token"];
    for (const subcommand of probes) {
      expect(bash).toContain(subcommand);
      expect(fish).toContain(subcommand);
    }
  });

  it("offers the same per-command flags in all three shells", () => {
    const bash = generateCompletionScript("bash");
    const zsh = generateCompletionScript("zsh");
    const fish = generateCompletionScript("fish");
    const longFlagProbes = [
      "--sandbox",
      "--agent",
      "--non-interactive",
      "--type",
      "--credential",
      "--config",
      "--from-existing",
      "--quick",
      "--output",
      "--force",
      "--dry-run",
      "--json",
    ];
    for (const flag of longFlagProbes) {
      expect(bash).toContain(flag);
      expect(zsh).toContain(flag);
      // fish spells long flags as `-l <name>` without the dashes
      expect(fish).toContain(`-l ${flag.slice(2)}`);
    }
  });

  it("completes shell names for the completion command in all three shells", () => {
    expect(generateCompletionScript("bash")).toContain("bash zsh fish");
    expect(generateCompletionScript("zsh")).toContain("'bash' 'zsh' 'fish'");
    expect(generateCompletionScript("fish")).toContain(
      "__fish_seen_subcommand_from completion' -a 'bash zsh fish'",
    );
  });
});

describe("runCompletionAction", () => {
  it("writes the script for an explicit shell", () => {
    const written: string[] = [];
    runCompletionAction("zsh", { write: (s) => written.push(s) });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("#compdef nemoclaw");
  });

  it("auto-detects the shell from the env dep when omitted", () => {
    const written: string[] = [];
    runCompletionAction(undefined, {
      write: (s) => written.push(s),
      shellEnv: "/usr/local/bin/fish",
    });
    expect(written[0]).toContain("# nemoclaw fish completion");
  });

  it("falls back to bash for unknown shells", () => {
    const written: string[] = [];
    runCompletionAction(undefined, { write: (s) => written.push(s), shellEnv: "/bin/tcsh" });
    expect(written[0]).toContain("complete -F _nemoclaw nemoclaw");
  });
});
