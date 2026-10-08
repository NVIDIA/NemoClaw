// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it, vi } from "vitest";
import { parseMessagingFixturePayload as parseStdoutJson } from "../helpers/messaging-plan-fixtures";
import { runBoundedOnboardScriptAsync } from "../helpers/onboard-child-process-harness";
import { writeOkOpenshell } from "../helpers/onboard-openshell-fixture";

type CommandEntry = { command: string };
const repoRoot = path.join(import.meta.dirname, "../..");
const onboardScriptMocksPath = JSON.stringify(
  path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"),
);
beforeEach(() => {
  vi.stubEnv("NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG", "1");
  vi.stubEnv("NEMOCLAW_TEST_FORWARD_SERVICE_FIXTURE", "1");
  vi.stubEnv("NEMOCLAW_SANDBOX_PREBUILD", "1");
});
describe("onboard messaging reuse", () => {
  it.sequential(
    "reuses sandbox without refreshing unselected ambient messaging providers (#10277)",
    {
      timeout: 60_000,
    },
    async (context) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-reuse-providers-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "reuse-with-providers.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin);

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const fixtureMocks = require(${onboardScriptMocksPath});

// This test owns a simulated standalone gateway, not the host service installation.
fixtureMocks.mockStandaloneGatewayTeardownAuthority();
const commands = [];
const existingSandbox = fixtureMocks.createCreatedSandboxFixture({ lifecycleState: "created" }); existingSandbox.installRuntimeObservation();
const messagingProviderRunner = require(${onboardScriptMocksPath}).createStatefulMessagingProviderRunner({
  commands,
  createdSandbox: existingSandbox,
  initialProviders: [
    ["my-assistant-discord-bridge", "nemoclaw-mcp-v1", "DISCORD_BOT_TOKEN"],
    ["my-assistant-slack-bridge", "nemoclaw-mcp-v1", "SLACK_BOT_TOKEN"],
    ["my-assistant-slack-app", "nemoclaw-mcp-v1", "SLACK_APP_TOKEN"],
  ],
});
runner.run = messagingProviderRunner;
runner.runCapture = (command) => {
  const sandboxCapture = existingSandbox.capture(command);
  if (sandboxCapture !== null) return sandboxCapture;
  // All messaging providers already exist in gateway
  if (_n(command).includes("provider get")) return "Provider: exists";
  if (_n(command).includes("forward list")) return "SANDBOX BIND PORT PID STATUS";
  return "";
};
registry.getSandbox = () => fixtureMocks.sandboxLifecycleFixture(
  { name: "my-assistant", toolDisclosure: "progressive" },
  { sandboxId: existingSandbox.state.sandboxId },
);
const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.DISCORD_BOT_TOKEN = "test-discord-token";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-slack-token";
  process.env.SLACK_APP_TOKEN = "xapp-test-slack-token";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = await runBoundedOnboardScriptAsync(scriptPath, {
        context,
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payload = parseStdoutJson(result.stdout);

      assert.equal(payload.sandboxName, "my-assistant", "should reuse existing sandbox");
      assert.ok(
        payload.commands.every((entry: CommandEntry) => !entry.command.includes("sandbox create")),
        "should NOT recreate sandbox when providers already exist in gateway",
      );
      assert.ok(
        payload.commands.every((entry: CommandEntry) => !entry.command.includes("sandbox delete")),
        "should NOT delete sandbox when providers already exist in gateway",
      );

      // Existing gateway providers do not select messaging for this onboarding request.
      const providerUpserts = payload.commands.filter((entry: CommandEntry) =>
        /provider (?:create|update|delete)\b.*my-assistant-(?:discord-bridge|slack-bridge|slack-app)\b/u.test(
          entry.command,
        ),
      );
      assert.equal(
        providerUpserts.length,
        0,
        "should not refresh ambient messaging providers without a selected channel plan",
      );
    },
  );
});
