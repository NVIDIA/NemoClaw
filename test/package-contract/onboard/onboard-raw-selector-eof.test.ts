// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ctrl-D cancellation at the raw-mode onboarding menus (#12169).
 *
 * The policy-tier and policy-preset menus, the messaging-channel menu and the
 * Hermes managed-tools menu each switch the terminal to raw mode. That switch
 * drops a Ctrl-D typed between two questions, and inside the menu the key
 * arrives as an ordinary byte rather than an end-of-file. Either way the menu
 * waited for a key that never came. These tests drive every menu through a
 * real pseudo-terminal, press Ctrl-D both between questions and inside the
 * menu, and assert that onboarding cancels with exit status 1 and leaves the
 * terminal out of raw mode.
 *
 * The tests use compiled artifacts (`dist/lib/...js`) to exercise the shipped
 * code path.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..", "..");
const dist = (relative: string): string => path.join(REPO_ROOT, "dist", "lib", relative);

const MENUS = {
  policy: {
    banner: "Policy tier",
    cancellation: "MARK_CANCELLED",
  },
  messaging: {
    banner: "MESSAGING_MENU_OPEN",
    cancellation: "Installation cancelled",
  },
  hermes: {
    banner: "Hermes managed Nous tools",
    cancellation: "Installation cancelled",
  },
} as const;

type MenuName = keyof typeof MENUS;
type Moment = "between" | "inside";

const DRIVER = `
const { runOnboardCommand } = require(${JSON.stringify(dist("onboard/command.js"))});
const { prompt } = require(${JSON.stringify(dist("credentials/store.js"))});

process.on("exit", () => {
  process.stderr.write("\\nRAW_AT_EXIT=" + (process.stdin.isRaw === true) + "\\n");
});

const menus = {
  policy: () => {
    const { createPolicySelectionPromptHelpers } = require(${JSON.stringify(dist("onboard/policy-selection-prompts.js"))});
    const { makeOnboardCancelExit } = require(${JSON.stringify(dist("onboard/cancel-rollback.js"))});
    const { selectFromNumberedMenuOrExit } = require(${JSON.stringify(dist("onboard/prompt-helpers.js"))});
    const tiers = require(${JSON.stringify(dist("policy/tiers.js"))});
    return createPolicySelectionPromptHelpers({
      tiers,
      policyTierEnv: { resolvePolicyTierFromEnv: () => "balanced" },
      isNonInteractive: () => false,
      note: () => undefined,
      prompt,
      selectFromNumberedMenuOrExit,
      makeOnboardCancelExit,
      sandboxCancelRollback: {
        markCancelled: () => process.stderr.write("MARK_CANCELLED\\n"),
      },
      useColor: false,
    }).selectPolicyTier();
  },
  messaging: () => {
    const { readMessagingChannelSelection } = require(${JSON.stringify(dist("onboard/messaging-selector.js"))});
    process.stderr.write("MESSAGING_MENU_OPEN\\n");
    return readMessagingChannelSelection(
      [{ id: "telegram", displayName: "Telegram" }],
      new Set(),
      () => undefined,
    );
  },
  hermes: () => {
    const { setupHermesToolGateways } = require(${JSON.stringify(dist("onboard/hermes-managed-tools.js"))});
    const { HERMES_PROVIDER_NAME } = require(${JSON.stringify(dist("onboard/inference-providers/hermes-provider-identity.js"))});
    return setupHermesToolGateways(HERMES_PROVIDER_NAME, "oauth", null, {
      prompt,
      note: () => undefined,
      isNonInteractive: () => false,
    });
  },
};

runOnboardCommand({
  flags: {},
  env: process.env,
  // The model answer lands, onboarding works for a moment with nobody
  // reading stdin, then the raw-mode menu opens.
  runOnboard: async () => {
    await prompt("  Choose model [1]: ");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await menus[process.env.MENU_UNDER_TEST]();
  },
  error: (message) => console.error(message),
  exit: (code) => process.exit(code),
});
`;

const PTY_RUNNER = `
import os, pty, re, select, sys, termios, time

moment = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    node = os.environ["NODE_UNDER_TEST"]
    os.execvpe(node, [node, "-e", os.environ["DRIVER_SOURCE"]], os.environ)

def raw_mode():
    try:
        return not bool(termios.tcgetattr(fd)[3] & termios.ICANON)
    except termios.error:
        return False

out = bytearray()
answered_at = None
sent = False
exit_code = 124
deadline = time.time() + 20
os.set_blocking(fd, False)
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.05)
    if ready:
        try:
            out.extend(os.read(fd, 4096))
        except (BlockingIOError, OSError):
            pass
    text = re.sub(rb"\\x1b\\[[0-9;?]*[a-zA-Z]", b"", bytes(out))
    if answered_at is None and b"Choose model [1]:" in text:
        time.sleep(0.2)
        os.write(fd, b"1\\n")
        answered_at = time.time()
        continue
    if answered_at is not None and not sent:
        elapsed = time.time() - answered_at
        # Between questions: nothing reads stdin and the terminal is cooked.
        if moment == "between" and elapsed > 0.2:
            os.write(fd, b"\\x04")
            sent = True
        # Inside the menu: wait out the pause between questions, then for the
        # menu to own the terminal in raw mode.
        if moment == "inside" and elapsed > 0.7 and raw_mode():
            time.sleep(0.1)
            os.write(fd, b"\\x04")
            sent = True
    waited = os.waitpid(pid, os.WNOHANG)
    if waited[0] == pid:
        exit_code = os.waitstatus_to_exitcode(waited[1])
        break
else:
    os.kill(pid, 9)
    os.waitpid(pid, 0)

try:
    while True:
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        out.extend(chunk)
except (BlockingIOError, OSError):
    pass

sys.stdout.buffer.write(bytes(out))
print("\\nPTY_CTRL_D_SENT=" + str(sent))
sys.exit(exit_code if exit_code >= 0 else 128 - exit_code)
`;

function runMenu(menu: MenuName, moment: Moment): { status: number | null; output: string } {
  const python =
    spawnSync("bash", ["--noprofile", "--norc", "-c", "command -v python3"], {
      encoding: "utf-8",
    }).stdout.trim() || "python3";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DRIVER_SOURCE: DRIVER,
    MENU_UNDER_TEST: menu,
    NODE_UNDER_TEST: process.execPath,
    NODE_NO_WARNINGS: "1",
  };
  // An inherited preset would bypass the Hermes menu entirely.
  delete env.NEMOCLAW_HERMES_TOOL_GATEWAYS;
  delete env.NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS;
  const result = spawnSync(python, ["-c", PTY_RUNNER, moment], {
    encoding: "utf-8",
    timeout: 30000,
    env,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe.skipIf(process.platform === "win32")("raw-mode menu Ctrl-D cancellation (#12169)", () => {
  const cases = (Object.keys(MENUS) as MenuName[]).flatMap((menu) =>
    (["between", "inside"] as const).map((moment) => [menu, moment] as const),
  );

  it.each(cases)("%s menu cancels on Ctrl-D typed %s", { timeout: 35000 }, (menu, moment) => {
    const { status, output } = runMenu(menu, moment);

    expect(output).toContain("PTY_CTRL_D_SENT=True");
    expect(status, output).toBe(1);
    expect(output).toContain(MENUS[menu].banner);
    expect(output).toContain(MENUS[menu].cancellation);
    expect(output).toContain("RAW_AT_EXIT=false");
    expect(output).not.toContain("Error: Prompt closed before input");
  });
});
