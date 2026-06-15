// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for issue #2273: rebuild should be atomic.
 *
 * Verifies:
 * 1. Layer 1: Non-interactive onboard resolves credentials from
 *    ~/.nemoclaw/credentials.json when process.env is empty.
 * 2. Layer 2: Rebuild preflight aborts BEFORE destroying the sandbox
 *    when the provider credential is missing.
 * 3. Layer 3: If recreate fails after destroy, rebuild prints recovery
 *    instructions instead of silently exiting.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const NODE_BIN = path.dirname(process.execPath);
const tmpFixtures: string[] = [];

afterEach(() => {
  for (const dir of tmpFixtures.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

function makeMessagingPlan(sandboxName: string, agent: string, channelIds: string[]) {
  return {
    schemaVersion: 1,
    sandboxName,
    agent,
    workflow: "onboard",
    channels: channelIds.map((channelId) => ({
      channelId,
      displayName: channelId,
      authMode: "token-paste",
      active: true,
      selected: true,
      configured: true,
      disabled: false,
      inputs: [],
      hooks: [],
    })),
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

/**
 * Create a temp HOME with a sandbox registry, onboard session, and
 * optionally a saved credential in credentials.json.
 *
 * The fake openshell binary responds to sandbox list, ssh-config, and
 * delete commands.  The fake ssh supports backup tar operations.
 */
function createFixture(opts: {
  sandboxName?: string;
  provider?: string;
  credentialEnv?: string;
  /** If set, save this credential in credentials.json */
  savedCredential?: { key: string; value: string };
  /** If set, the onboard-session.json provider_selection step status */
  providerSelectionStatus?: string;
  agent?: string | null;
  hermesAuthMethod?: string | null;
  messagingPlanChannels?: string[] | null;
  dockerBuildExitCode?: number;
  providerRegistered?: boolean;
  registeredProviders?: string[];
  activeSessionCount?: number | null;
}) {
  const {
    sandboxName = "my-assistant",
    provider = "nvidia-prod",
    credentialEnv = "NVIDIA_INFERENCE_API_KEY",
    savedCredential,
    providerSelectionStatus = "complete",
    agent = null,
    hermesAuthMethod = null,
    messagingPlanChannels = null,
    dockerBuildExitCode = 0,
    providerRegistered = true,
    registeredProviders,
    activeSessionCount = 0,
  } = opts;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-2273-"));
  tmpFixtures.push(tmpDir);
  const nemoclawDir = path.join(tmpDir, ".nemoclaw");
  fs.mkdirSync(nemoclawDir, { recursive: true, mode: 0o700 });
  const messagingPlan =
    messagingPlanChannels && messagingPlanChannels.length > 0
      ? makeMessagingPlan(sandboxName, agent ?? "openclaw", messagingPlanChannels)
      : null;

  // ── Registry ──────────────────────────────────────────────────
  fs.writeFileSync(
    path.join(nemoclawDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "meta/llama-3.3-70b-instruct",
          provider,
          gpuEnabled: false,
          policies: [],
          agent,
          ...(messagingPlan ? { messaging: { schemaVersion: 1, plan: messagingPlan } } : {}),
        },
      },
    }),
    { mode: 0o600 },
  );

  // ── Session ───────────────────────────────────────────────────
  fs.writeFileSync(
    path.join(nemoclawDir, "onboard-session.json"),
    JSON.stringify({
      version: 1,
      sessionId: "s",
      resumable: true,
      status: "complete",
      mode: "interactive",
      startedAt: "2026-01-01",
      updatedAt: "2026-01-01",
      lastStepStarted: null,
      lastCompletedStep: "policies",
      failure: null,
      agent: null,
      sandboxName,
      provider,
      model: "meta/llama-3.3-70b-instruct",
      endpointUrl: null,
      credentialEnv,
      hermesAuthMethod,
      preferredInferenceApi: null,
      nimContainer: null,
      webSearchConfig: null,
      policyPresets: [],
      messagingPlan: null,
      metadata: { gatewayName: "nemoclaw", fromDockerfile: null },
      steps: {
        preflight: {
          status: "complete",
          startedAt: null,
          completedAt: null,
          error: null,
        },
        gateway: {
          status: "complete",
          startedAt: null,
          completedAt: null,
          error: null,
        },
        sandbox: {
          status: "complete",
          startedAt: null,
          completedAt: null,
          error: null,
        },
        provider_selection: {
          status: providerSelectionStatus,
          startedAt: null,
          completedAt: null,
          error: null,
        },
        inference: {
          status: "complete",
          startedAt: null,
          completedAt: null,
          error: null,
        },
        openclaw: {
          status: "complete",
          startedAt: null,
          completedAt: null,
          error: null,
        },
        agent_setup: {
          status: "pending",
          startedAt: null,
          completedAt: null,
          error: null,
        },
        policies: {
          status: "complete",
          startedAt: null,
          completedAt: null,
          error: null,
        },
      },
    }),
    { mode: 0o600 },
  );

  // ── Credentials ───────────────────────────────────────────────
  if (savedCredential) {
    fs.writeFileSync(
      path.join(nemoclawDir, "credentials.json"),
      JSON.stringify({ [savedCredential.key]: savedCredential.value }),
      { mode: 0o600 },
    );
  }

  // ── Fake workspace dir for the backup tar call ────────────────
  const fakeRoot = path.join(tmpDir, "fake-sandbox-root");
  const workspaceDir = path.join(fakeRoot, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "marker.txt"), "test-workspace");

  // ── Fake openshell ────────────────────────────────────────────
  const sshConfig = [
    `Host openshell-${sandboxName}`,
    "  HostName 127.0.0.1",
    "  Port 2222",
    "  User sandbox",
    "  StrictHostKeyChecking no",
    "  UserKnownHostsFile /dev/null",
  ].join("\\n");

  const registeredProvidersLiteral = JSON.stringify(registeredProviders ?? null);
  fs.writeFileSync(
    path.join(tmpDir, "openshell"),
    `#!/usr/bin/env node
const a = process.argv.slice(2);
const registeredProviders = ${registeredProvidersLiteral};
if (a[0]==="sandbox" && a[1]==="list")       { process.stdout.write("${sandboxName}\\n"); process.exit(0); }
if (a[0]==="sandbox" && a[1]==="ssh-config") { process.stdout.write("${sshConfig}\\n"); process.exit(0); }
if (a[0]==="sandbox" && a[1]==="delete")     { process.exit(0); }
if (a[0]==="status")                         { process.stdout.write("running\\n"); process.exit(0); }
if (a[0]==="gateway" && a[1]==="info")       { process.stdout.write("nemoclaw\\n"); process.exit(0); }
if (a[0]==="gateway" && a[1]==="select")     { process.exit(0); }
if (a[0]==="inference" && a[1]==="get")      { process.stdout.write('{"provider":"${provider}","model":"meta/llama-3.3-70b-instruct"}\\n'); process.exit(0); }
if (a[0]==="inference" && a[1]==="set")      { process.exit(0); }
if (a[0]==="provider" && a[1]==="get")       {
  if (Array.isArray(registeredProviders)) process.exit(registeredProviders.includes(a[2]) ? 0 : 1);
  process.exit(${providerRegistered ? 0 : 1});
}
if (a[0]==="provider")                       { process.exit(0); }
if (a[0]==="forward")                        { process.exit(0); }
process.exit(0);
`,
    { mode: 0o755 },
  );

  // ── Fake ps for active SSH session detection ──────────────────
  const activeSessionLines = Array.from(
    { length: activeSessionCount ?? 0 },
    (_, index) => `${9000 + index} ssh openshell-${sandboxName}`,
  ).join("\n");
  fs.writeFileSync(
    path.join(tmpDir, "ps"),
    `#!/usr/bin/env node
if (${activeSessionCount === null ? "true" : "false"}) process.exit(1);
process.stdout.write(${JSON.stringify(activeSessionLines)} + (${JSON.stringify(activeSessionLines)} ? "\\n" : ""));
process.exit(0);
`,
    { mode: 0o755 },
  );

  // ── Fake Docker ───────────────────────────────────────────────
  // Hermes rebuild forces a base-image build before backup/delete.
  // This fixture only exercises rebuild session state, so Docker succeeds.
  fs.writeFileSync(
    path.join(tmpDir, "docker"),
    `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0]==="build") { process.exit(${dockerBuildExitCode}); }
if (a[0]==="image" && a[1]==="inspect") { process.exit(0); }
if (a[0]==="inspect") { process.stdout.write("true\\n"); process.exit(0); }
if (a[0]==="ps") { process.exit(0); }
process.stderr.write("unexpected docker call: " + a.join(" ") + "\\n");
process.exit(1);
`,
    { mode: 0o755 },
  );

  // ── Fake ssh ──────────────────────────────────────────────────
  fs.writeFileSync(
    path.join(tmpDir, "ssh"),
    `#!/usr/bin/env node
const cmd = process.argv[process.argv.length - 1] || "";
if (cmd.includes("[ -d")) {
  process.stdout.write("workspace\\n");
  process.exit(0);
}
if (cmd.includes("tar")) {
  const { spawnSync } = require("child_process");
  const r = spawnSync("tar", ["-cf", "-", "-C", ${JSON.stringify("PLACEHOLDER")}, "workspace"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.stdout) process.stdout.write(r.stdout);
  process.exit(r.status || 0);
}
if (cmd.includes("rm -rf")) { process.exit(0); }
if (cmd.includes("chown"))  { process.exit(0); }
process.exit(0);
`,
    { mode: 0o755 },
  );

  // Patch the PLACEHOLDER in the fake ssh to point at the real fakeRoot
  const sshScript = fs.readFileSync(path.join(tmpDir, "ssh"), "utf-8");
  fs.writeFileSync(path.join(tmpDir, "ssh"), sshScript.replace("PLACEHOLDER", fakeRoot), {
    mode: 0o755,
  });

  return { tmpDir, nemoclawDir, sandboxName, fakeRoot };
}

function runRebuild(
  fixture: ReturnType<typeof createFixture>,
  extraEnv: Record<string, string> = {},
  options: { yes?: boolean; input?: string } = {},
) {
  const argv = [path.join(REPO_ROOT, "bin", "nemoclaw.js"), fixture.sandboxName, "rebuild"];
  if (options.yes !== false) argv.push("--yes");
  return spawnSync(process.execPath, argv, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    input: options.input,
    env: {
      HOME: fixture.tmpDir,
      PATH: fixture.tmpDir + ":" + NODE_BIN + ":/usr/bin:/bin",
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_NO_CONNECT_HINT: "1",
      NO_COLOR: "1",
      ...extraEnv,
    },
    timeout: 30_000,
  });
}

function registryHasSandbox(fixture: ReturnType<typeof createFixture>): boolean {
  const regPath = path.join(fixture.nemoclawDir, "sandboxes.json");
  if (!fs.existsSync(regPath)) return false;
  try {
    const reg = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    return Boolean(reg.sandboxes?.[fixture.sandboxName]);
  } catch {
    return false;
  }
}

describe("Issue #2273: atomic rebuild", () => {
  describe("Layer 2: preflight credential check", () => {
    it("cancels interactive rebuild before credential preflight or backup on non-affirmative input", {
      timeout: 60_000,
    }, () => {
      const f = createFixture({
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        providerRegistered: false,
      });

      const result = runRebuild(f, {}, { yes: false, input: "n\n" });
      const output = (result.stderr || "") + (result.stdout || "");

      expect(result.status).toBe(0);
      expect(output).toContain("Proceed? [y/N]:");
      expect(output).toContain("Cancelled.");
      expect(output).not.toContain("preflight failed");
      expect(output).not.toContain("Backing up sandbox state");
      expect(registryHasSandbox(f)).toBe(true);
    });

    it("accepts trimmed case-insensitive yes input before continuing rebuild", {
      timeout: 60_000,
    }, () => {
      const f = createFixture({
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        savedCredential: {
          key: "NVIDIA_INFERENCE_API_KEY",
          value: "nvapi-test-key-for-rebuild",
        },
      });

      const result = runRebuild(f, {}, { yes: false, input: " YES \n" });
      const output = (result.stderr || "") + (result.stdout || "");

      expect(output).toContain("Proceed? [y/N]:");
      expect(output).not.toContain("Cancelled.");
      expect(output).not.toContain("preflight failed");
      expect(output).toContain("Backing up sandbox state");
    });

    it("prints active SSH session warning before interactive confirmation", {
      timeout: 60_000,
    }, () => {
      const f = createFixture({
        activeSessionCount: 2,
        savedCredential: {
          key: "NVIDIA_INFERENCE_API_KEY",
          value: "nvapi-test-key-for-rebuild",
        },
      });

      const result = runRebuild(f, {}, { yes: false, input: "n\n" });
      const output = (result.stderr || "") + (result.stdout || "");

      expect(result.status).toBe(0);
      expect(output).toContain("Active SSH sessions detected (2 connections)");
      expect(output).toContain("terminate all active sessions with a Broken pipe error");
      expect(output).toContain("Proceed? [y/N]:");
      expect(output).toContain("Cancelled.");
      expect(output).not.toContain("Backing up sandbox state");
    });

    it("omits active SSH warning when detection is unavailable", {
      timeout: 60_000,
    }, () => {
      const f = createFixture({
        activeSessionCount: null,
        savedCredential: {
          key: "NVIDIA_INFERENCE_API_KEY",
          value: "nvapi-test-key-for-rebuild",
        },
      });

      const result = runRebuild(f, {}, { yes: false, input: "n\n" });
      const output = (result.stderr || "") + (result.stdout || "");

      expect(result.status).toBe(0);
      expect(output).not.toContain("Active SSH");
      expect(output).toContain("Proceed? [y/N]:");
      expect(output).toContain("Cancelled.");
      expect(output).not.toContain("Backing up sandbox state");
    });

    it("aborts rebuild BEFORE destroying sandbox when credential is missing", {
      timeout: 60_000,
    }, () => {
      // No credential in env or credentials.json AND no gateway-registered
      // provider — preflight must still abort so the sandbox is preserved.
      const f = createFixture({
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        providerRegistered: false,
        // no savedCredential
      });

      const result = runRebuild(f);
      const output = (result.stderr || "") + (result.stdout || "");

      // Should mention preflight failure
      expect(output).toContain("preflight failed");
      expect(output).toContain("NVIDIA_INFERENCE_API_KEY");
      // Should say sandbox is untouched
      expect(output).toContain("untouched");
      // Sandbox should still be in the registry (not destroyed)
      expect(registryHasSandbox(f)).toBe(true);
    });

    it("proceeds when credential is saved in credentials.json (not in env)", {
      timeout: 60_000,
    }, () => {
      // Credential saved in credentials.json but NOT in process.env
      const f = createFixture({
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        savedCredential: {
          key: "NVIDIA_INFERENCE_API_KEY",
          value: "nvapi-test-key-for-rebuild",
        },
      });

      const result = runRebuild(f);
      const output = (result.stderr || "") + (result.stdout || "");

      // Should NOT show preflight failure
      expect(output).not.toContain("preflight failed");
      // Should proceed to backup step
      expect(output).toContain("Backing up sandbox state");
    });

    it("copies Hermes messaging channels from the registry into the rebuild resume session", {
      timeout: 60_000,
    }, () => {
      const f = createFixture({
        agent: "hermes",
        messagingPlanChannels: ["discord"],
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        savedCredential: {
          key: "NVIDIA_INFERENCE_API_KEY",
          value: "nvapi-test-key-for-rebuild",
        },
      });

      const result = runRebuild(f);
      const output = (result.stderr || "") + (result.stdout || "");
      expect(output).toContain("Creating new sandbox with current image");

      const session = JSON.parse(
        fs.readFileSync(path.join(f.nemoclawDir, "onboard-session.json"), "utf-8"),
      );
      expect(session.agent).toBe("hermes");
      expect(
        session.messagingPlan?.channels.map((channel: { channelId: string }) => channel.channelId),
      ).toEqual(["discord"]);
    });

    it("aborts rebuild before backup when forced Hermes base image build fails", {
      timeout: 60_000,
    }, () => {
      const f = createFixture({
        agent: "hermes",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        savedCredential: {
          key: "NVIDIA_INFERENCE_API_KEY",
          value: "nvapi-test-key-for-rebuild",
        },
        dockerBuildExitCode: 23,
      });

      const result = runRebuild(f);
      const output = (result.stderr || "") + (result.stdout || "");

      expect(result.status).not.toBe(0);
      expect(output).toContain("Rebuild preflight failed");
      expect(output).toContain("agent base image could not be built");
      expect(output).toContain("Failed to build Hermes Agent base image (exit 23)");
      expect(output).toContain("Sandbox is untouched");
      expect(output).not.toContain("Backing up sandbox state");
      expect(registryHasSandbox(f)).toBe(true);
    });

    it("skips credential preflight for local inference (no credentialEnv in session)", {
      timeout: 60_000,
    }, () => {
      // Ollama/vLLM — no credentialEnv in session
      const f = createFixture({
        provider: "ollama-local",
        credentialEnv: undefined as unknown as string,
      });

      // Patch the session to have null credentialEnv
      const sessionPath = path.join(f.nemoclawDir, "onboard-session.json");
      const session = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
      session.credentialEnv = null;
      session.provider = "ollama-local";
      fs.writeFileSync(sessionPath, JSON.stringify(session), { mode: 0o600 });

      const result = runRebuild(f);
      const output = (result.stderr || "") + (result.stdout || "");

      // Should NOT show preflight failure
      expect(output).not.toContain("preflight failed");
      // Should proceed to backup step
      expect(output).toContain("Backing up sandbox state");
    });

    it.each([
      ["ollama-local"],
      ["vllm-local"],
    ])("migrates legacy %s sandbox off OPENAI_API_KEY (GH #2519)", (provider) => {
      // Pre-fix sandboxes recorded credentialEnv="OPENAI_API_KEY" even
      // though local inference never actually needed it. After the fix,
      // the wizard records null. Rebuild must accept the legacy value,
      // print a one-time migration notice, and proceed even when no
      // OPENAI_API_KEY exists in env or credentials.json.
      const f = createFixture({
        provider,
        credentialEnv: "OPENAI_API_KEY",
        // no savedCredential — host has no OPENAI_API_KEY anywhere
      });

      const result = runRebuild(f);
      const output = (result.stderr || "") + (result.stdout || "");

      // Must NOT bail with the usual missing-credential failure
      expect(output).not.toContain("preflight failed");
      expect(output).not.toContain("Missing credential: OPENAI_API_KEY");
      // Must surface the migration notice so testers know the legacy
      // behaviour was intentionally bypassed
      expect(output).toContain("GH #2519");
      expect(output).toContain(provider);
      // Must continue into the backup step
      expect(output).toContain("Backing up sandbox state");
    }, 60_000);

    it("fails closed when a matching session omits the remote target provider credential", {
      timeout: 60_000,
    }, () => {
      const f = createFixture({
        provider: "openai-api",
        credentialEnv: "OPENAI_API_KEY",
        providerRegistered: false,
      });
      const sessionPath = path.join(f.nemoclawDir, "onboard-session.json");
      const session = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
      session.credentialEnv = null;
      fs.writeFileSync(sessionPath, JSON.stringify(session), { mode: 0o600 });

      const result = runRebuild(f);
      const output = (result.stderr || "") + (result.stdout || "");

      expect(result.status).not.toBe(0);
      expect(output).toContain("preflight failed");
      expect(output).toContain("requires OPENAI_API_KEY");
      expect(output).not.toContain("Backing up sandbox state");
      expect(output).not.toContain("Old sandbox deleted");
      expect(registryHasSandbox(f)).toBe(true);
    });

    it("uses the target registry provider when a matching session has a stale registered provider", {
      timeout: 60_000,
    }, () => {
      const f = createFixture({
        provider: "openai-api",
        credentialEnv: "OPENAI_API_KEY",
        registeredProviders: ["nvidia-prod"],
      });
      const sessionPath = path.join(f.nemoclawDir, "onboard-session.json");
      const session = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
      session.provider = "nvidia-prod";
      session.credentialEnv = null;
      fs.writeFileSync(sessionPath, JSON.stringify(session), { mode: 0o600 });

      const result = runRebuild(f);
      const output = (result.stderr || "") + (result.stdout || "");

      expect(result.status).not.toBe(0);
      expect(output).toContain("preflight failed");
      expect(output).toContain("requires OPENAI_API_KEY");
      expect(output).not.toContain("Backing up sandbox state");
      expect(output).not.toContain("Old sandbox deleted");
      expect(registryHasSandbox(f)).toBe(true);
    });

    it("does not let a mismatched stale local session bypass the target OPENAI_API_KEY preflight", {
      timeout: 60_000,
    }, () => {
      const f = createFixture({
        provider: "openai-api",
        credentialEnv: "OPENAI_API_KEY",
        providerRegistered: false,
      });
      const sessionPath = path.join(f.nemoclawDir, "onboard-session.json");
      const session = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
      session.sandboxName = "other-local-sandbox";
      session.provider = "ollama-local";
      session.credentialEnv = "OPENAI_API_KEY";
      fs.writeFileSync(sessionPath, JSON.stringify(session), { mode: 0o600 });

      const result = runRebuild(f);
      const output = (result.stderr || "") + (result.stdout || "");

      expect(result.status).not.toBe(0);
      expect(output).toContain("preflight failed");
      expect(output).toContain("requires OPENAI_API_KEY");
      expect(output).not.toContain("GH #2519");
      expect(output).not.toContain("Backing up sandbox state");
      expect(output).not.toContain("Old sandbox deleted");
      expect(registryHasSandbox(f)).toBe(true);
    });

    it("preflight works for non-NVIDIA providers (OpenAI, Anthropic, etc.)", {
      timeout: 60_000,
    }, () => {
      // OpenAI provider with no credential AND no gateway registration —
      // should abort.
      const f = createFixture({
        provider: "openai-api",
        credentialEnv: "OPENAI_API_KEY",
        providerRegistered: false,
        // no savedCredential
      });

      const result = runRebuild(f);
      const output = (result.stderr || "") + (result.stdout || "");

      expect(output).toContain("preflight failed");
      expect(output).toContain("OPENAI_API_KEY");
      expect(output).toContain("untouched");
      expect(registryHasSandbox(f)).toBe(true);
    });

    it("uses the registered Hermes Provider in OpenShell instead of requiring OPENAI_API_KEY", {
      timeout: 60_000,
    }, () => {
      const f = createFixture({
        agent: "hermes",
        provider: "hermes-provider",
        credentialEnv: "OPENAI_API_KEY",
        hermesAuthMethod: "oauth",
      });

      const result = runRebuild(f);
      const output = (result.stderr || "") + (result.stdout || "");

      expect(output).not.toContain("Missing credential: OPENAI_API_KEY");
      expect(output).not.toContain("provider credential not found");
      expect(output).toContain("Backing up sandbox state");
    });

    it("registers an exported Hermes API key in OpenShell when the provider is missing", {
      timeout: 60_000,
    }, () => {
      const f = createFixture({
        agent: "hermes",
        provider: "hermes-provider",
        credentialEnv: "NOUS_API_KEY",
        hermesAuthMethod: "api_key",
        providerRegistered: false,
      });

      const result = runRebuild(f, { NOUS_API_KEY: "nous-key-from-env" });
      const output = (result.stderr || "") + (result.stdout || "");

      expect(output).not.toContain("Missing credential: NOUS_API_KEY");
      expect(output).not.toContain("provider credential not found");
      expect(output).toContain("Backing up sandbox state");
    });

    it("uses the registered nvidia-prod provider in OpenShell instead of requiring NVIDIA_INFERENCE_API_KEY", {
      timeout: 60_000,
    }, () => {
      // After `nemohermes channels add wechat` the rebuild preflight used to
      // abort because NVIDIA_INFERENCE_API_KEY was not set in the environment, even
      // though `nvidia-prod` was already registered in the OpenShell
      // gateway. Reuse the gateway-stored credential instead.
      const f = createFixture({
        provider: "nvidia-prod",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        providerRegistered: true,
        // no savedCredential — host env has no NVIDIA_INFERENCE_API_KEY
      });

      const result = runRebuild(f);
      const output = (result.stderr || "") + (result.stdout || "");

      expect(output).not.toContain("Missing credential: NVIDIA_INFERENCE_API_KEY");
      expect(output).not.toContain("provider credential not found");
      expect(output).toContain("Backing up sandbox state");
    });

    it("still aborts when nvidia-prod is missing from the gateway AND the env", {
      timeout: 60_000,
    }, () => {
      // Negative gate on gateway-credential reuse: if the gateway also lost
      // the provider (cold install, gateway state lost) and the env is
      // empty, the preflight must still bail so the sandbox is preserved.
      const f = createFixture({
        provider: "nvidia-prod",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        providerRegistered: false,
      });

      const result = runRebuild(f);
      const output = (result.stderr || "") + (result.stdout || "");

      expect(result.status).not.toBe(0);
      expect(output).toContain("preflight failed");
      expect(output).toContain("NVIDIA_INFERENCE_API_KEY");
      expect(output).toContain("untouched");
      expect(registryHasSandbox(f)).toBe(true);
    });

    it("aborts Hermes OAuth rebuild before backup when the OpenShell provider is missing", {
      timeout: 60_000,
    }, () => {
      const f = createFixture({
        agent: "hermes",
        provider: "hermes-provider",
        credentialEnv: "OPENAI_API_KEY",
        hermesAuthMethod: "oauth",
        providerRegistered: false,
      });

      const result = runRebuild(f);
      const output = (result.stderr || "") + (result.stdout || "");

      expect(result.status).not.toBe(0);
      expect(output).toContain("Hermes Provider is not registered in OpenShell");
      expect(output).toContain("credentials must be stored in OpenShell");
      expect(output).not.toContain("Missing credential: OPENAI_API_KEY");
      expect(output).not.toContain("Backing up sandbox state");
      expect(registryHasSandbox(f)).toBe(true);
    });
  });

  describe("Layer 3: recovery on recreate failure", () => {
    it("prints recovery instructions when recreate fails after destroy", {
      timeout: 60_000,
    }, () => {
      // Credential IS present so preflight passes, but onboard will
      // fail because the fake openshell doesn't support full onboard.
      // The key thing: rebuild should catch the failure and print
      // recovery instructions instead of silently exiting.
      const f = createFixture({
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        savedCredential: {
          key: "NVIDIA_INFERENCE_API_KEY",
          value: "nvapi-test-key-for-rebuild",
        },
        // Force provider_selection to re-run (not resume) so onboard
        // actually exercises the provider flow, which will fail in our
        // fake environment.
        providerSelectionStatus: "pending",
      });

      const result = runRebuild(f);
      const output = (result.stderr || "") + (result.stdout || "");

      // Should show the backup was created
      expect(output).toContain("State backed up");
      // Should show sandbox was deleted
      expect(output).toContain("Old sandbox deleted");
      // Should show recovery instructions (not just die silently)
      expect(output).toContain("Recreate failed");
      expect(output).toContain("recover manually");
      expect(output).toContain("onboard --resume");
      // Should mention where the backup is
      expect(output).toContain("rebuild-backups");
    });

    it("preflight failure exits non-zero when credential is missing", { timeout: 60_000 }, () => {
      // Verifies that missing credentials cause rebuild to exit non-zero
      // when no fallback exists in the gateway either. This is the
      // observable CLI behavior — the preflight check fails and bail()
      // calls process.exit with a non-zero code.
      const f = createFixture({
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        providerRegistered: false,
        // No credential — preflight will fail and exit non-zero
      });

      const result = runRebuild(f);
      expect(result.status).not.toBe(0);
    });
  });
});
