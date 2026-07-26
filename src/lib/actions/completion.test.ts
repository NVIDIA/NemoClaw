// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  buildCompletionModel,
  type CompletionCommandMetadata,
  detectShell,
  generateCompletionScript,
  runCompletionAction,
  runCompletionSandboxNamesAction,
} from "./completion";

const COMMANDS = [
  {
    args: {},
    flags: {
      agent: { hidden: false, name: "agent", type: "option" },
      help: { char: "h", hidden: false, name: "help", type: "boolean" },
    },
    hidden: false,
    id: "onboard",
  },
  {
    args: {},
    flags: { type: { hidden: false, name: "type", type: "option" } },
    hidden: false,
    id: "credentials:add",
  },
  {
    args: {
      shell: { name: "shell", options: ["bash", "zsh", "fish"] },
    },
    flags: {
      "list-sandbox-names": {
        hidden: true,
        name: "list-sandbox-names",
        type: "boolean",
      },
    },
    hidden: false,
    id: "completion",
  },
  { args: {}, flags: {}, hidden: false, id: "resources" },
  {
    args: {},
    flags: { json: { hidden: false, name: "json", type: "boolean" } },
    hidden: false,
    id: "sandbox:status",
  },
  {
    args: {},
    flags: { quiet: { char: "q", hidden: false, name: "quiet", type: "boolean" } },
    hidden: false,
    id: "sandbox:gateway:token",
  },
  { args: {}, flags: {}, hidden: false, id: "sandbox:channels:add" },
  { args: {}, flags: {}, hidden: true, id: "internal:secret" },
] as unknown as CompletionCommandMetadata[];

function findCase(
  model: ReturnType<typeof buildCompletionModel>,
  scope: "global" | "sandbox",
  key: string,
) {
  return model[scope].find((entry) => entry.key === `${scope}:${key}`);
}

describe("buildCompletionModel", () => {
  it("derives public routes and flags from oclif metadata", () => {
    const model = buildCompletionModel(COMMANDS);

    expect(findCase(model, "global", "")?.candidates).toEqual([
      "completion",
      "credentials",
      "onboard",
      "resources",
    ]);
    expect(findCase(model, "global", "credentials")?.candidates).toEqual(["add"]);
    expect(findCase(model, "global", "credentials add")?.flags).toEqual(["--type"]);
    expect(findCase(model, "global", "completion")?.argOptions).toEqual(["bash", "fish", "zsh"]);
    expect(findCase(model, "sandbox", "")?.candidates).toEqual([
      "channels",
      "gateway-token",
      "status",
    ]);
    expect(findCase(model, "sandbox", "gateway-token")?.flags).toEqual(["--quiet", "-q"]);
    expect(JSON.stringify(model)).not.toContain("internal:secret");
    expect(JSON.stringify(model)).not.toContain("credentials:add");
  });
});

describe("generateCompletionScript", () => {
  it.each([
    "bash",
    "zsh",
    "fish",
  ] as const)("generates %s from the same metadata model", (shell) => {
    const script = generateCompletionScript(shell, COMMANDS, "nemoclaw");
    expect(script).toContain("credentials add");
    expect(script).toContain("gateway-token");
    expect(script).toContain("completion --list-sandbox-names");
    expect(script).not.toContain("nemoclaw list --json");
    expect(script).not.toContain("credentials:add");
  });

  it("uses the active oclif binary name", () => {
    const script = generateCompletionScript("bash", COMMANDS, "nemo-deepagents");
    expect(script).toContain("complete -F _nemo_deepagents 'nemo-deepagents'");
    expect(script).toContain("'nemo-deepagents' completion --list-sandbox-names");
  });

  it("loads and caches sandbox names in the generated Bash script", () => {
    const script = generateCompletionScript("bash", COMMANDS, "nemoclaw");
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `${script}
nemoclaw() { printf 'beta\\nalpha\\n'; }
_nemoclaw_load_sandboxes
printf '%s|%s\\n' "$__nemoclaw_sandbox_cache" "$__nemoclaw_sandbox_cache_loaded"`,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("beta\nalpha|1\n");
  });
});

describe("completion actions", () => {
  it("detects the target shell and defaults to bash", () => {
    expect(detectShell("/bin/zsh")).toBe("zsh");
    expect(detectShell("/usr/local/bin/fish")).toBe("fish");
    expect(detectShell("/bin/tcsh")).toBe("bash");
    expect(detectShell(undefined)).toBe("bash");
  });

  it("writes the selected generated script", () => {
    const written: string[] = [];
    runCompletionAction(undefined, COMMANDS, "nemoclaw", {
      shellEnv: "/bin/zsh",
      write: (output) => written.push(output),
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("#compdef nemoclaw");
  });

  it("emits sorted registry names without running the full list command", () => {
    const written: string[] = [];
    runCompletionSandboxNamesAction({
      listRegisteredSandboxes: () => ({
        defaultSandbox: "beta",
        sandboxes: [{ name: "beta" }, { name: "alpha" }],
      }),
      write: (output) => written.push(output),
    });
    expect(written).toEqual(["alpha\nbeta\n"]);
  });
});
