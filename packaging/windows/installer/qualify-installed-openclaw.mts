// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// CI-only browser acceptance of the installed executable. Never imported by the app.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  captureLauncherArtifactSources,
  validateLauncherArtifactSourceSnapshot,
  validateInstalledLauncherInputs,
} from "./installed-launcher-admission.mts";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { signalObserverStop } from "./observer-stop.mts";
import { captureOwned, qualificationEnvironment } from "./qualify-finished-package.mts";
import { sampleInstalledIdle } from "../tests/performance/installed-idle.mts";
import { sanitizeNativeDiagnostic } from "../runtime/native-session-diagnostics.mts";
import { nativeCredentialBinding, readOpenedRegularFile } from "../runtime/native-security.mts";
import {
  acquireNativeStateConfiguration,
  acquireNativeStateInspection,
  acquireNativeStateRemoval,
} from "../runtime/native-state.mts";
import { acceptanceProcessesStopped } from "./qualify-finished-package.mts";

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const runtimeKeys = [
  "runtimeId",
  "manifestSha256",
  "sourceRevision",
  "nodeSha256",
  "nodeVersion",
] as const;

export function openClawRestartMode(args: string[]) {
  const preserve = args.includes("--preserve-configuration");
  const reuse = args.includes("--reuse-configuration");
  assert(!(preserve && reuse), "Select either a cold preserved run or a warm reused run.");
  assert.equal(
    args.includes("--previous-acceptance"),
    reuse,
    "Only a warm run uses a cold receipt.",
  );
  return { preserve, reuse, restart: preserve || reuse };
}

export function openClawTranscriptIdentity(sessionKey: string, history: any) {
  assert.match(sessionKey, /^agent:main:[A-Za-z0-9:._-]{1,256}$/u);
  assert(
    Array.isArray(history?.messages) &&
      history.messages.length > 0 &&
      history.messages.length < 100,
    "The complete controlled conversation must fit within the history bound.",
  );
  const messages = history.messages.map((message: any) => {
    assert(message && ["user", "assistant", "toolResult"].includes(message.role));
    assert(typeof message.content === "string" || Array.isArray(message.content));
    return Object.fromEntries(
      ["role", "content", "toolName", "toolCallId", "stopReason"]
        .filter((key) => Object.hasOwn(message, key))
        .map((key) => [key, message[key]]),
    );
  });
  const serialized = JSON.stringify(messages);
  assert(
    Buffer.byteLength(serialized) <= 20000,
    "The conversation exceeds the controlled history bound.",
  );
  return { sessionKey, messageCount: messages.length, sha256: digest(serialized) };
}

export function assertRecordedOpenClawReply(history: any, prompt: string, reply: string) {
  assert(Array.isArray(history?.messages));
  let matched = false;
  for (const message of history.messages) {
    const text =
      typeof message?.content === "string"
        ? message.content
        : Array.isArray(message?.content)
          ? message.content
              .filter((part: any) => part?.type === "text")
              .map((part: any) => part.text)
              .join("\n")
          : "";
    if (message?.role === "user") matched = text === prompt;
    else if (
      matched &&
      message?.role === "assistant" &&
      message.stopReason !== "error" &&
      text === reply
    )
      return;
  }
  throw new Error("The conversation lacks the selected-provider response to this run's prompt.");
}

export function assertRetainedOpenClawPrefix(
  previous: ReturnType<typeof openClawTranscriptIdentity>,
  history: any,
) {
  assert(
    Array.isArray(history?.messages) && history.messages.length > previous.messageCount,
    "The warm conversation lacks new messages.",
  );
  const retained = openClawTranscriptIdentity(previous.sessionKey, {
    messages: history.messages.slice(0, previous.messageCount),
  });
  assert.deepEqual(retained, previous, "The warm turn changed its retained conversation prefix.");
}

export function validateOpenClawColdReceipt(
  previous: any,
  expected: {
    controllerRun: string;
    handoff: string;
    installation: string;
    runtime: Record<string, any>;
    launcherSha256: string;
    packageBuildSha256: string;
    artifactSourceSnapshotSha256: string;
    controllerSourceRevision: string;
    model: string;
  },
) {
  return validateOpenClawRestartReceipt(previous, expected, false);
}

function validateOpenClawRestartReceipt(
  previous: any,
  expected: Parameters<typeof validateOpenClawColdReceipt>[1],
  warm: boolean,
) {
  assert.match(expected.controllerRun, /^[1-9]\d*:[1-9]\d*$/u);
  assert.match(expected.handoff, /^[a-f0-9]{64}$/u);
  assert.match(expected.artifactSourceSnapshotSha256, /^[a-f0-9]{64}$/u);
  assert.match(expected.controllerSourceRevision, /^[a-f0-9]{40}$/u);
  assert.equal(previous?.schemaVersion, 2, "Restart cannot promote a legacy acceptance receipt.");
  assert.equal(previous.classification, "installed-compiled-openclaw-acceptance");
  assert.equal(previous.verdict, "pass");
  assert.deepEqual(previous.cleanupErrors, []);
  assert.deepEqual(previous.cleanupErrorDetails, []);
  assert.equal(previous.primaryFailure, null);
  const cold = previous.restart;
  assert.equal(cold?.schemaVersion, 1);
  assert.equal(cold.mode, warm ? "warm-reused" : "cold-preserved");
  for (const key of [
    "controllerRun",
    "handoff",
    "installation",
    "launcherSha256",
    "packageBuildSha256",
    "artifactSourceSnapshotSha256",
    "controllerSourceRevision",
    "model",
  ] as const)
    assert.equal(cold[key], expected[key], "Restart input differs from the same-run cold receipt.");
  for (const key of runtimeKeys) {
    assert.match(
      expected.runtime[key],
      key === "nodeVersion"
        ? /^22\.23\.2$/u
        : key === "sourceRevision"
          ? /^[a-f0-9]{40}$/u
          : /^[a-f0-9]{64}$/u,
    );
    assert.equal(previous.runtime?.[key], expected.runtime[key]);
  }
  assert.equal(cold.provider, "nvidia");
  assert.equal(cold.endpoint, "https://integrate.api.nvidia.com/v1");
  assert.equal(cold.configurationReused, warm);
  assert.equal(cold.configurationPreserved, !warm);
  assert.equal(cold.cleanupDisposition, warm ? "removed-owned-state" : "retained-for-warm-run");
  if (warm) assert.equal(cold.cleanupScope, "owned-configuration-state-and-credential");
  assert.equal(cold.processesStopped, true);
  assert.equal(cold.stateOwnerReleased, true);
  assert.equal(cold.backendCleanupConfirmed, true);
  assert.equal(cold.mutationUnconfirmed, false);
  assert.equal(cold.credentialMutationConfirmed, true);
  assert.match(cold.configurationSha256, /^[a-f0-9]{64}$/u);
  assert.match(cold.ownedState?.stateRoot, /^[A-Z]:\\NemoClawState-S-1-(?:\d+-)*\d+-openclaw$/u);
  assert.match(cold.ownedState.device, /^\d+$/u);
  assert.match(cold.ownedState.inode, /^[1-9]\d*$/u);
  assert.match(cold.retainedConversation?.sessionKey, /^agent:main:[A-Za-z0-9:._-]{1,256}$/u);
  assert(
    Number.isSafeInteger(cold.retainedConversation.messageCount) &&
      cold.retainedConversation.messageCount > 0 &&
      cold.retainedConversation.messageCount < 100,
  );
  assert.match(cold.retainedConversation.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(previous.results?.response?.provider, "nvidia");
  assert.equal(previous.results.response.model, expected.model);
  assert.equal(previous.results.response.deterministicModel, false);
  assert.match(previous.results.response.visibleReply, /^NEMOCLAW_NVIDIA_[a-f0-9]{24}$/u);
  assert.equal(previous.results.sessionCleanup?.verdict, "pass");
  for (const flag of [
    "sandboxDeleted",
    "sandboxRegistryAbsent",
    "gatewayStopped",
    "qualificationRootsRemoved",
  ])
    assert.equal(previous.results.sessionCleanup[flag], true);
  return cold;
}

export function validateOpenClawWarmReceipt(
  receipt: any,
  coldReceipt: any,
  expected: Parameters<typeof validateOpenClawColdReceipt>[1],
) {
  const cold = validateOpenClawColdReceipt(coldReceipt, expected);
  const warm = validateOpenClawRestartReceipt(receipt, expected, true);
  assert.equal(warm.configurationSha256, cold.configurationSha256);
  for (const field of ["stateRoot", "device", "inode"])
    assert.equal(warm.ownedState[field], cold.ownedState[field]);
  assert.deepEqual(warm.restoredConversation, cold.retainedConversation);
  assert.equal(warm.retainedConversation.sessionKey, cold.retainedConversation.sessionKey);
  assert(warm.retainedConversation.messageCount > cold.retainedConversation.messageCount);
  assert.notEqual(warm.retainedConversation.sha256, cold.retainedConversation.sha256);
  assert.notEqual(receipt.results.response.visibleReply, coldReceipt.results.response.visibleReply);
  return warm;
}

export function openClawCleanupDisposition(input: {
  owned: boolean;
  processesStopped: boolean;
  stateOwnerReleased: boolean;
  backendCleanupConfirmed: boolean;
  mutationUnconfirmed: boolean;
  preserve: boolean;
  successful: boolean;
}) {
  if (!input.owned) return "not-owned";
  if (
    !input.processesStopped ||
    !input.stateOwnerReleased ||
    !input.backendCleanupConfirmed ||
    input.mutationUnconfirmed
  )
    return "retain-unconfirmed";
  return input.preserve && input.successful ? "retained-for-warm-run" : "remove-owned-state";
}

function readAcceptanceBytes(file: string, maxBytes = 2 * 1024 * 1024) {
  const bytes = readOpenedRegularFile(file, { maxBytes, rejectLinks: true, rejectHardLinks: true });
  assert(bytes !== null, "An acceptance input is missing.");
  return bytes;
}

export function captureOpenClawArtifactSources(
  input: Omit<Parameters<typeof captureLauncherArtifactSources>[0], "agent">,
) {
  return captureLauncherArtifactSources({ ...input, agent: "openclaw" });
}

export function validateOpenClawArtifactSourceSnapshot(
  input: Omit<Parameters<typeof validateLauncherArtifactSourceSnapshot>[0], "agent">,
) {
  return validateLauncherArtifactSourceSnapshot({ ...input, agent: "openclaw" });
}

export function validateOpenClawInspectionInputs(
  input: Omit<Parameters<typeof validateInstalledLauncherInputs>[0], "agent">,
) {
  return validateInstalledLauncherInputs({ ...input, agent: "openclaw" });
}

function ownedDirectoryIdentity(stateRoot: string) {
  const stat = fs.lstatSync(stateRoot, { bigint: true });
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.ino > 0n);
  assert.equal(fs.realpathSync(stateRoot).toLowerCase(), stateRoot.toLowerCase());
  return { stateRoot, device: String(stat.dev), inode: String(stat.ino) };
}

export async function inspectRetainedOpenClawState(
  input: {
    launcher: string;
    expectedState: ReturnType<typeof ownedDirectoryIdentity>;
    configurationPath: string;
    configurationSha256?: string;
    ownerHeld: (held: boolean) => void;
  },
  dependencies = {
    acquire: acquireNativeStateInspection,
    directoryIdentity: ownedDirectoryIdentity,
    read: readAcceptanceBytes,
  },
) {
  const owner = await dependencies.acquire(input.launcher, "openclaw");
  input.ownerHeld(true);
  try {
    owner.assertHeld();
    assert.equal(owner.present, true, "Restart cannot recreate missing agent data.");
    const ownedState = dependencies.directoryIdentity(owner.stateRoot);
    assert.deepEqual(ownedState, input.expectedState, "Restart cannot adopt replaced agent data.");
    if (input.configurationSha256)
      assert.equal(
        digest(dependencies.read(input.configurationPath, 16 * 1024)),
        input.configurationSha256,
        "Acceptance changed the retained configuration.",
      );
    owner.assertHeld();
    return ownedState;
  } finally {
    await owner.release();
    input.ownerHeld(false);
  }
}

export async function saveFreshOpenClawConfiguration(input: {
  restart: boolean;
  configuration: { agent: string; inference: string; endpoint: string };
  secret: string;
  command: (name: string, args: string[], stdin: string) => Promise<string>;
  rememberBinding: (binding: string) => void;
  mutationUnconfirmed: (unconfirmed: boolean) => void;
}) {
  const configuration = JSON.stringify(input.configuration);
  if (input.restart) {
    input.rememberBinding(nativeCredentialBinding(input.configuration));
    input.mutationUnconfirmed(true);
    await input.command(
      "save-config-transaction",
      ["--configure-native", "--agent", "openclaw", "--transaction"],
      JSON.stringify({
        configuration: input.configuration,
        credentials: { inference: input.secret, services: {} },
      }),
    );
    input.mutationUnconfirmed(false);
    return;
  }
  const prepared = JSON.parse(
    await input.command(
      "prepare-config",
      ["--configure-native", "--agent", "openclaw", "--prepare-all"],
      configuration,
    ),
  );
  assert.equal(prepared.schemaVersion, 1);
  assert.match(prepared.inference, /^[a-f0-9]{64}$/u);
  assert.deepEqual(prepared.services, {});
  input.rememberBinding(prepared.inference);
  await input.command(
    "credential-write",
    ["--credential-write", "nvidia", "--binding", prepared.inference],
    input.secret,
  );
  await input.command("save-config", ["--configure-native", "--agent", "openclaw"], configuration);
}

export async function completeOpenClawRestartState(
  input: {
    restart: any;
    owned: boolean;
    preserve: boolean;
    successful: boolean;
    launcher: string;
    ownedState?: ReturnType<typeof ownedDirectoryIdentity>;
    configurationPath: string;
    configurationSha256?: string;
    binding?: string;
    command: (name: string, args: string[], stdin?: string) => Promise<string>;
    cleanupFailed: (action: string, error: unknown) => void;
  },
  dependencies = {
    inspectRetained: inspectRetainedOpenClawState,
    acquire: acquireNativeStateInspection,
    removeRoot: acquireNativeStateRemoval,
    configurationAbsent: openClawConfigurationAbsent,
  },
) {
  const restart = input.restart;
  restart.credentialMutationConfirmed = input.binding !== undefined && !restart.mutationUnconfirmed;
  let disposition = openClawCleanupDisposition({
    owned: input.owned,
    processesStopped: restart.processesStopped,
    stateOwnerReleased: restart.stateOwnerReleased,
    backendCleanupConfirmed: restart.backendCleanupConfirmed,
    mutationUnconfirmed: restart.mutationUnconfirmed,
    preserve: input.preserve,
    successful: input.successful,
  });
  const ownerHeld = (held: boolean) => {
    restart.stateOwnerReleased = !held;
  };
  if (["remove-owned-state", "retained-for-warm-run"].includes(disposition)) {
    try {
      await dependencies.inspectRetained({
        launcher: input.launcher,
        expectedState: input.ownedState!,
        configurationPath: input.configurationPath,
        configurationSha256: input.configurationSha256,
        ownerHeld,
      });
    } catch (error) {
      disposition = "retain-unconfirmed";
      input.cleanupFailed("owned state inspection before handoff or removal", error);
    }
  }
  restart.cleanupDisposition = disposition;
  if (disposition === "remove-owned-state") {
    try {
      if (input.binding === undefined) {
        // No transaction started. Remove only the freshly claimed private root;
        // ordinary agent removal also deletes service keys that we do not own.
        assert.equal(input.configurationSha256, undefined);
        assert(dependencies.configurationAbsent(input.configurationPath));
        const owner = await dependencies.removeRoot(input.launcher, "openclaw");
        ownerHeld(true);
        try {
          owner.assertHeld();
          assert.equal(owner.stateRoot, input.ownedState?.stateRoot);
          assert.equal(owner.removed, true);
          owner.assertHeld();
        } finally {
          await owner.release();
          ownerHeld(false);
        }
        restart.cleanupScope = "fresh-private-root-only-no-credentials-touched";
      } else {
        assert.match(input.binding, /^[a-f0-9]{64}$/u);
        await input.command("remove-configured-data", [
          "--remove-native-data",
          "--agent",
          "openclaw",
        ]);
        await input.command("credential-delete", [
          "--credential-delete",
          "nvidia",
          "--binding",
          input.binding,
        ]);
        restart.cleanupScope = "owned-configuration-state-and-credential";
      }
      const owner = await dependencies.acquire(input.launcher, "openclaw");
      ownerHeld(true);
      try {
        owner.assertHeld();
        assert.equal(owner.stateRoot, input.ownedState?.stateRoot);
        assert.equal(owner.present, false);
      } finally {
        await owner.release();
        ownerHeld(false);
      }
      assert(dependencies.configurationAbsent(input.configurationPath));
      restart.cleanupDisposition = "removed-owned-state";
    } catch (error) {
      restart.cleanupDisposition = "retain-unconfirmed";
      input.cleanupFailed("owned restart data and credential cleanup", error);
    }
  }
  restart.configurationPreserved = restart.cleanupDisposition === "retained-for-warm-run";
  if (restart.cleanupDisposition === "retain-unconfirmed")
    input.cleanupFailed(
      "State or mutation ownership is unconfirmed; data and credentials retained for recovery.",
      new Error("Do not delete state or uninstall the owned helper before recovery."),
    );
}

export function openClawConfigurationAbsent(configurationPath: string) {
  return fs.lstatSync(path.dirname(configurationPath), { throwIfNoEntry: false }) === undefined;
}

export function childEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return qualificationEnvironment(source, true);
}

export function stripInheritedAcceptanceEnvironment(source: NodeJS.ProcessEnv) {
  const environment = childEnvironment(source);
  // Native lease helpers and Playwright inherit this environment. The cold key
  // remains only in the controller variable and the transaction's stdin.
  for (const name of Object.keys(source))
    if (!Object.hasOwn(environment, name)) delete source[name];
  return environment;
}

export function exactChatAddress(value: string, origin: string) {
  const actual = new URL(value),
    expected = new URL(origin);
  return (
    actual.protocol === "http:" &&
    actual.hostname === "127.0.0.1" &&
    !actual.username &&
    !actual.password &&
    actual.origin === expected.origin &&
    actual.pathname === "/chat"
  );
}

// Only errors following this exact nonce-bearing user prompt can end the wait.
export function terminalAgentError(history: unknown, prompt: string): string | null {
  if (
    !history ||
    typeof history !== "object" ||
    !("messages" in history) ||
    !Array.isArray(history.messages)
  )
    return null;
  let matched = false;
  for (const item of history.messages) {
    if (!item || typeof item !== "object") continue;
    const message = item as {
      role?: string;
      content?: unknown;
      stopReason?: string;
      errorMessage?: string;
    };
    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter(
                (part: { type?: string; text?: unknown }) =>
                  part?.type === "text" && typeof part.text === "string",
              )
              .map((part: { text: string }) => part.text)
              .join("\n")
          : "";
    if (message.role === "user") {
      matched = text === prompt;
      continue;
    }
    if (!matched || message.role !== "assistant") continue;
    if (
      message.stopReason === "error" &&
      typeof message.errorMessage === "string" &&
      message.errorMessage.trim()
    )
      return message.errorMessage.slice(0, 8192);
    // Canonical chat-history projection removes errorMessage but retains the
    // terminal stopReason and sanitized display text. Never match ordinary prose.
    if (message.stopReason === "error" && text.trim()) return text.slice(0, 8192);
    if (/^(?:⚠️?\s*)?Agent failed before reply:/u.test(text)) return text.slice(0, 8192);
  }
  return null;
}

export function toolIds(result: unknown): string[] {
  assert.ok(
    result && typeof result === "object" && "agentId" in result && result.agentId === "main",
  );
  assert.ok("groups" in result && Array.isArray(result.groups));
  return result.groups.flatMap((group: { tools: { id: string }[] }) => {
    assert.ok(Array.isArray(group.tools));
    return group.tools.map((tool) => {
      assert.equal(typeof tool.id, "string");
      return tool.id;
    });
  });
}

export function verifyToolOutput(value: unknown, expected: string) {
  assert.ok(value && typeof value === "object" && "ok" in value && value.ok === true);
  assert.ok("output" in value && value.output && typeof value.output === "object");
  const output = value.output as {
    isError?: boolean;
    details?: { exitCode?: number; status?: string };
    content?: { type: string; text?: string }[];
  };
  assert.notEqual(output.isError, true);
  if (output.details && Object.hasOwn(output.details, "exitCode"))
    assert.equal(output.details.exitCode, 0);
  if (output.details && Object.hasOwn(output.details, "status"))
    assert.equal(output.details.status, "completed");
  assert.ok(Array.isArray(output.content));
  const text = output.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
  assert.ok(text.includes(expected), "The actual tool output lacks its controlled result.");
}

export function recordedExec(history: { messages?: unknown[] }, command: string, expected: string) {
  assert.ok(Array.isArray(history.messages));
  const calls = new Set<string>();
  for (const value of history.messages) {
    const message = value as {
      role?: string;
      content?: { type?: string; name?: string; id?: string; arguments?: { command?: string } }[];
    };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content)
      if (
        block.type === "toolCall" &&
        block.name === "exec" &&
        block.arguments?.command === command &&
        typeof block.id === "string"
      )
        calls.add(block.id);
  }
  for (const value of history.messages) {
    const message = value as { role?: string; toolName?: string; toolCallId?: string };
    if (
      message.role !== "toolResult" ||
      message.toolName !== "exec" ||
      !message.toolCallId ||
      !calls.has(message.toolCallId)
    )
      continue;
    verifyToolOutput({ ok: true, output: message }, expected);
    return message;
  }
  throw new Error("The chat lacks the matching successful shell tool execution.");
}

export function recordedFileTool(
  history: { messages?: unknown[] },
  name: "write" | "read",
  file: string,
  content: string,
) {
  assert.ok(Array.isArray(history.messages));
  for (const [index, value] of history.messages.entries()) {
    const message = value as {
      role?: string;
      content?: {
        type?: string;
        name?: string;
        id?: string;
        arguments?: { path?: string; content?: string };
      }[];
    };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const call of message.content) {
      if (
        call.type !== "toolCall" ||
        call.name !== name ||
        typeof call.id !== "string" ||
        call.arguments?.path !== file ||
        (name === "write" && call.arguments.content !== content)
      )
        continue;
      for (const candidate of history.messages.slice(index + 1)) {
        const result = candidate as { role?: string; toolName?: string; toolCallId?: string };
        if (
          result.role !== "toolResult" ||
          result.toolName !== name ||
          result.toolCallId !== call.id
        )
          continue;
        verifyToolOutput({ ok: true, output: result }, name === "write" ? file : content);
        return result;
      }
    }
  }
  throw new Error("The chat lacks the matching successful " + name + " file-tool execution.");
}

function redactKey(value: string, secret: string) {
  return secret ? value.split(secret).join("[REDACTED]") : value;
}

export function sanitizedFailure(error: unknown, secret: string) {
  const bounded = (value: string, bytes: number) =>
    Buffer.from(redactKey(value, secret)).subarray(0, bytes).toString("utf8");
  const chain: { name: string; message: string; stack: string | null }[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && chain.length < 4 && !seen.has(current)) {
    seen.add(current);
    try {
      chain.push({
        name: bounded(current instanceof Error ? current.name : "NonError", 128),
        message: bounded(current instanceof Error ? current.message : String(current), 2048),
        stack:
          current instanceof Error && typeof current.stack === "string"
            ? bounded(current.stack, 6144)
            : null,
      });
      current = current instanceof Error ? current.cause : undefined;
    } catch {
      break;
    }
  }
  return { chain, truncatedOrCyclicCause: current !== undefined };
}

type FailurePage = { screenshot(options: { path: string; timeout: number }): Promise<unknown> };
export async function captureFailure(
  error: unknown,
  page: FailurePage | undefined,
  screenshot: string,
  secret: string,
) {
  const failure = {
    primary: sanitizedFailure(error, secret),
    screenshot: null as string | null,
    screenshotError: null as ReturnType<typeof sanitizedFailure> | null,
  };
  if (page)
    try {
      await page.screenshot({ path: screenshot, timeout: 5000 });
      failure.screenshot = path.basename(screenshot);
    } catch (secondary) {
      failure.screenshotError = sanitizedFailure(secondary, secret);
    }
  return failure;
}

export function decodeDiagnosticOwnerRead(stdout: string): Buffer | null {
  const lines = stdout.split(/\r?\n/u);
  if (lines.length !== 4 || lines[0] !== "READY" || lines[2] !== "OK" || lines[3] !== "")
    throw new Error("The native diagnostic reader returned invalid framing.");
  if (lines[1] === "MISS") return null;
  if (!lines[1].startsWith("OK\t")) throw new Error("The native diagnostic reader rejected ready.");
  const encoded = lines[1].slice(3);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > 1024 * 1024 || bytes.toString("base64") !== encoded)
    throw new Error("The native diagnostic reader returned invalid bounded data.");
  return bytes;
}

// Enumeration only selects fixed names. The installed native file owner validates
// the directory/ancestors and reads ready through its existing guarded handles.
export async function retainNativeSessionDiagnostics(
  stateRoot: string,
  readReady: (directory: string) => Promise<Buffer | null>,
  save: (name: string, document: unknown) => void,
  secret: string,
) {
  const retained: { sourceDirectory: string; output: string; sourceSha256: string }[] = [];
  if (!fs.existsSync(stateRoot)) return { status: "missing", retained };
  const root = fs.lstatSync(stateRoot);
  assert(root.isDirectory() && !root.isSymbolicLink());
  const names = fs
    .readdirSync(stateRoot)
    .filter((name) => /^session-diagnostics-[a-f0-9]{20}$/u.test(name))
    .sort();
  assert(names.length <= 8, "The fresh session has too many diagnostic documents.");
  for (const name of names) {
    const directory = path.join(stateRoot, name);
    const stat = fs.lstatSync(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink());
    const bytes = await readReady(directory);
    assert(
      bytes !== null && bytes.length <= 1024 * 1024,
      "The native diagnostic document is absent or oversized.",
    );
    const text = bytes.toString("utf8");
    assert(Buffer.from(text, "utf8").equals(bytes), "The native diagnostic document is not UTF8.");
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      throw new Error("The native diagnostic document is malformed.");
    }
    assert(
      document.schemaVersion === 1 &&
        document.agent === "openclaw" &&
        ["native-session-success", "native-session-failure"].includes(document.classification),
    );
    const output = `native-session-diagnostic-${retained.length}.json`;
    save(output, JSON.parse(sanitizeNativeDiagnostic(text, [secret])));
    retained.push({
      sourceDirectory: name,
      output,
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return { status: retained.length ? "retained" : "missing", retained };
}

function argument(name: string, fallback?: string) {
  const position = process.argv.indexOf(name);
  const value = position < 0 ? fallback : process.argv[position + 1];
  if (!value || value.startsWith("--"))
    throw new Error("Missing installed-acceptance input: " + name);
  return value;
}

type Observation = {
  kind: "observation";
  rootPid: number;
  rootStartedUtc: string;
  hostPid: number;
  hostStartedUtc: string;
  hostPath: string;
  ports: number[];
  sessionPid: number | null;
  openEnabled: boolean;
  windowFound?: boolean;
  openFound?: boolean;
  openName?: string | null;
  openControlEnabled?: boolean;
  phase?: string | null;
  status?: string | null;
};

export function visibleChatReady() {
  const input = globalThis.document.querySelector(".agent-chat__composer-combobox > textarea");
  const sessionKey = (
    globalThis.document.querySelector("openclaw-app-shell") as unknown as {
      activeSessionKey?: string;
    }
  )?.activeSessionKey;
  return (
    input instanceof globalThis.HTMLTextAreaElement &&
    !input.disabled &&
    typeof sessionKey === "string" &&
    /^agent:main:[A-Za-z0-9:._-]+$/u.test(sessionKey)
  );
}

export async function requestVisibleGateway({
  method,
  params,
}: {
  method: string;
  params: Record<string, unknown>;
}) {
  const app = globalThis.document.querySelector("openclaw-app") as unknown as {
    context?: {
      gateway?: {
        snapshot?: {
          phase: string;
          client: { request(method: string, params: unknown): Promise<unknown> };
        };
      };
    };
  };
  const gateway = app?.context?.gateway?.snapshot;
  if (gateway?.phase !== "connected" || !gateway.client)
    throw new Error("The actual browser gateway client is disconnected.");
  return await gateway.client.request(method, params);
}

async function main() {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "arm64");
  assert.equal(process.version, "v22.23.2");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const install = path.resolve(argument("--install-root")),
    output = path.resolve(argument("--output"));
  const identity = JSON.parse(fs.readFileSync(argument("--runtime-identity"), "utf8"));
  const model = argument("--model", "nvidia/nemotron-3-super-120b-a12b");
  assert.match(model, /^[A-Za-z0-9._/-]{1,256}$/u);
  const mode = openClawRestartMode(process.argv);
  const controllerRun = `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`;
  const controllerSourceRevision = process.env.GITHUB_SHA ?? "";
  const handoff = mode.restart ? argument("--restart-handoff") : "";
  if (mode.restart) {
    assert.match(controllerRun, /^[1-9]\d*:[1-9]\d*$/u);
    assert.match(handoff, /^[a-f0-9]{64}$/u);
  }
  const secret = process.env.NVIDIA_API_KEY || process.env.NVIDIA_INFERENCE_API_KEY || "";
  if (!mode.reuse)
    assert.ok(
      secret.startsWith("nvapi-") && secret.length <= 2048 && !/[\r\n\0]/u.test(secret),
      "An authorized NVIDIA credential is required.",
    );
  const stateRoot = path.join(
    process.env.LOCALAPPDATA ?? "",
    "NVIDIA",
    "NemoClaw",
    "agents",
    "openclaw",
  );
  if (!mode.reuse)
    assert.equal(
      mode.restart
        ? openClawConfigurationAbsent(path.join(stateRoot, "native-windows.json"))
        : !fs.existsSync(stateRoot),
      true,
      "Acceptance requires an unconfigured disposable runner.",
    );
  const runnerTempValue = process.env.RUNNER_TEMP;
  assert(runnerTempValue && path.isAbsolute(runnerTempValue), "RUNNER_TEMP must be absolute.");
  const runnerTemp = path.resolve(runnerTempValue);
  const outputFromRunnerTemp = path.relative(runnerTemp, output);
  assert(
    outputFromRunnerTemp !== ".." &&
      !outputFromRunnerTemp.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(outputFromRunnerTemp),
    "The observer output must remain beneath RUNNER_TEMP.",
  );
  assert.equal(fs.existsSync(output), false);
  fs.mkdirSync(output, { recursive: true });
  const observerStopSentinel = path.join(
    output,
    `observer-stop-${randomBytes(32).toString("hex")}.sentinel`,
  );
  const environment = stripInheritedAcceptanceEnvironment(process.env);
  const launcher = path.join(install, "bin", "NemoClaw.exe");
  const ps = path.join(
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const redact = (text: string) => redactKey(text, secret);
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(output, name), redact(JSON.stringify(value, null, 2)) + "\n", {
      flag: "wx",
    });
  const results: Record<string, unknown> = {};
  const cleanupErrors: string[] = [];
  const cleanupErrorDetails: { action: string; failure: ReturnType<typeof sanitizedFailure> }[] =
    [];
  const cleanupFailed = (action: string, error: unknown) => {
    cleanupErrors.push(action);
    cleanupErrorDetails.push({ action, failure: sanitizedFailure(error, secret) });
  };
  let primary: unknown,
    phase = "configure",
    binding: string | undefined;
  let agent: ChildProcess | undefined, observer: ChildProcess | undefined;
  let agentClosed: Promise<number> | undefined, observerClosed: Promise<number> | undefined;
  let browser: { close(): Promise<void> } | undefined;
  let failurePage: FailurePage | undefined;
  let latest: Observation | undefined, observerFailure: Error | undefined;
  let stopInvoked = false,
    stopped = false;
  let configurationOwned = false,
    stateOwnerReleased = true,
    mutationUnconfirmed = false;
  let ownedState: ReturnType<typeof ownedDirectoryIdentity> | undefined;
  let previous: any, restart: any;
  let configurationSha256: string | undefined;
  let inspectionAdmission: ReturnType<typeof validateOpenClawInspectionInputs> | undefined;
  const logs = { agentStdout: "", agentStderr: "", observerStderr: "" };
  const observerStarted = performance.now();
  const observerRecords: { receivedMs: number; record: unknown }[] = [];
  let omittedObserverRecords = 0;
  const httpProbes: Record<string, unknown>[] = [];
  let omittedHttpProbes = 0;
  const processEvents: Record<
    string,
    { pid: number | undefined; exit?: unknown; close?: unknown }
  > = {};
  const observerSnapshot = () =>
    structuredClone({
      lastObservation: latest ?? null,
      records: [...observerRecords],
      omittedRecords: omittedObserverRecords,
      httpProbes: [...httpProbes],
      omittedHttpProbes,
      stopInvoked,
      stopped,
      processes: processEvents,
      observerFailure: observerFailure ? sanitizedFailure(observerFailure, secret) : null,
    });
  const command = async (name: string, args: string[], input = "") => {
    const result = await captureOwned(launcher, args, environment, input, 60_000);
    results[name] = { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) };
    assert.equal(result.failure, null, name);
    assert.equal(result.exitCode, 0, name);
    return result.stdout;
  };
  const boundedClose = async <T,>(closed: Promise<T>, milliseconds: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("The installed session did not finish cleanup.")),
            milliseconds,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  };
  const closed = (child: ChildProcess, label: string) =>
    new Promise<number>((resolve) => {
      const events: { pid: number | undefined; exit?: unknown; close?: unknown } = {
        pid: child.pid,
      };
      processEvents[label] = events;
      child.once("exit", (code, signal) => {
        events.exit = { code, signal, elapsedMs: performance.now() - observerStarted };
      });
      child.once("error", (error) => {
        observerFailure ??= error;
      });
      child.once("close", (code, signal) => {
        events.close = { code, signal, elapsedMs: performance.now() - observerStarted };
        resolve(code ?? 1);
      });
    });
  const capture = (child: ChildProcess, channel: "stdout" | "stderr", key: keyof typeof logs) => {
    child[channel]!.on("data", (chunk: Buffer) => {
      if (logs[key].length + chunk.length > 4 * 1024 * 1024) {
        observerFailure ??= new Error("The installed acceptance output exceeded its bound.");
        return;
      }
      logs[key] += chunk.toString("utf8");
    });
  };
  try {
    if (mode.restart) {
      phase = "inspection-input-admission";
      const packageRoot = path.resolve(argument("--package-root"));
      inspectionAdmission = validateOpenClawInspectionInputs({
        buildBytes: readAcceptanceBytes(path.join(packageRoot, "immutable-package-build.json")),
        sourceBytes: readAcceptanceBytes(path.join(packageRoot, "launcher-build-inputs.json")),
        capabilityBytes: readAcceptanceBytes(
          path.join(packageRoot, "build", "launcher-capabilities.json"),
          4096,
        ),
        materializationBytes: readAcceptanceBytes(
          path.join(packageRoot, "compiled-launcher.json"),
          65536,
        ),
        launcherBytes: readAcceptanceBytes(
          path.join(packageRoot, "build", "compiled-native", "NemoClaw.exe"),
          32 * 1024 * 1024,
        ),
        packagedBytes: readAcceptanceBytes(
          path.join(packageRoot, "build", "payload", "bin", "NemoClaw.exe"),
          32 * 1024 * 1024,
        ),
        installedBytes: readAcceptanceBytes(launcher, 32 * 1024 * 1024),
        sourceRevision: identity.sourceRevision,
        controllerRun,
        artifactSourceSnapshotBytes: readAcceptanceBytes(
          argument("--artifact-source-snapshot"),
          256 * 1024,
        ),
        artifactSourceSnapshotSha256: argument("--artifact-source-snapshot-sha256"),
        controllerSourceRevision,
      });
      restart = {
        schemaVersion: 1,
        mode: mode.reuse ? "warm-reused" : "cold-preserved",
        controllerRun,
        handoff,
        installation: install,
        ...inspectionAdmission,
        model,
        provider: "nvidia",
        endpoint: "https://integrate.api.nvidia.com/v1",
        configurationReused: mode.reuse,
        configurationPreserved: false,
        stateOwnerReleased: true,
        processesStopped: false,
        cleanupDisposition: "not-owned",
      };
      if (mode.reuse) {
        previous = JSON.parse(
          readAcceptanceBytes(argument("--previous-acceptance"), 4 * 1024 * 1024).toString("utf8"),
        );
        validateOpenClawColdReceipt(previous, {
          controllerRun,
          handoff,
          installation: install,
          runtime: identity,
          ...inspectionAdmission,
          model,
        });
        binding = nativeCredentialBinding({
          agent: "openclaw",
          inference: "nvidia",
          endpoint: restart.endpoint,
        });
        phase = "retained-state-inspection";
        ownedState = await inspectRetainedOpenClawState({
          launcher,
          expectedState: previous.restart.ownedState,
          configurationPath: path.join(stateRoot, "native-windows.json"),
          configurationSha256: previous.restart.configurationSha256,
          ownerHeld: (held) => {
            stateOwnerReleased = !held;
          },
        });
        configurationSha256 = previous.restart.configurationSha256;
        configurationOwned = true;
      } else {
        phase = "claim-fresh-state";
        const owner = await acquireNativeStateConfiguration(launcher, "openclaw");
        stateOwnerReleased = false;
        try {
          owner.assertHeld();
          assert.equal(owner.created, true, "Fresh acceptance cannot adopt existing agent data.");
          ownedState = ownedDirectoryIdentity(owner.stateRoot);
          configurationOwned = true;
          write("owned-openclaw-state.json", {
            schemaVersion: 1,
            controllerRun,
            handoff,
            ...inspectionAdmission,
            installation: install,
            ownedState,
            credentialBinding: nativeCredentialBinding({
              agent: "openclaw",
              inference: "nvidia",
              endpoint: restart.endpoint,
            }),
            classification: "openclaw-restart-owned-state",
            installedAcceptance: false,
          });
          owner.assertHeld();
        } finally {
          await owner.release();
          stateOwnerReleased = true;
        }
      }
      restart.ownedState = ownedState;
    }
    const configurationRecord = {
      schemaVersion: 1,
      classification: "nemoclaw-native-windows-agent-configuration",
      agent: "openclaw",
      inference: "nvidia",
      endpoint: "https://integrate.api.nvidia.com/v1",
      model,
      credentialStored: true,
      profile: "personal",
      options: {},
    };
    if (!mode.reuse) {
      phase = "configure";
      await saveFreshOpenClawConfiguration({
        restart: mode.restart,
        configuration: configurationRecord,
        secret,
        command,
        rememberBinding: (value) => {
          binding = value;
        },
        mutationUnconfirmed: (value) => {
          mutationUnconfirmed = value;
        },
      });
    }
    const savedBytes = readAcceptanceBytes(path.join(stateRoot, "native-windows.json"), 16 * 1024);
    const saved = JSON.parse(savedBytes.toString("utf8"));
    assert.equal(saved.inference, "nvidia");
    assert.equal(saved.model, model);
    assert.equal(saved.credentialStored, true);
    if (mode.restart) {
      assert.deepEqual(saved, configurationRecord);
      configurationSha256 ??= digest(savedBytes);
      assert.equal(digest(savedBytes), configurationSha256);
      restart.configurationSha256 = configurationSha256;
    }
    const lease = JSON.parse(
      await command("installed-identity", ["--runtime-session", "openclaw"], "release\n"),
    );
    for (const key of [
      "runtimeId",
      "manifestSha256",
      "sourceRevision",
      "nodeSha256",
      "nodeVersion",
    ])
      assert.equal(lease[key], identity[key]);
    if (mode.restart) {
      assert.equal(lease.schemaVersion, 1);
      assert.equal(lease.kind, "native-runtime-session");
      assert.equal(lease.agent, "openclaw");
      assert.equal(lease.integrity, "installer-sealed-content");
      assert.equal(lease.leaseHeld, true);
    }
    phase = "launch";
    agent = spawn(
      launcher,
      [
        "--configured",
        "--agent",
        "openclaw",
        "--wait",
        "--artifact-directory",
        path.join(output, "session"),
      ],
      { env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    agentClosed = closed(agent, "guardian");
    agent.stdin!.end();
    capture(agent, "stdout", "agentStdout");
    capture(agent, "stderr", "agentStderr");
    assert.ok(agent.pid);
    // Keep the existing observer deadline; the optional sample must leave its Stop budget.
    const observerDeadline = performance.now() + 600_000;
    observer = spawn(
      ps,
      [
        "-NoProfile",
        "-File",
        path.join(path.dirname(fileURLToPath(import.meta.url)), "control-installed-openclaw.ps1"),
        "-RootProcessId",
        String(agent.pid),
        "-InstallRoot",
        install,
      ],
      {
        env: {
          ...environment,
          RUNNER_TEMP: runnerTemp,
          NEMOCLAW_OBSERVER_CONTROLLER_PID: String(process.pid),
          NEMOCLAW_OBSERVER_STOP_SENTINEL: observerStopSentinel,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    observerClosed = closed(observer, "observer");
    capture(observer, "stderr", "observerStderr");
    let pending = "",
      observedBytes = 0;
    observer.stdout!.on("data", (chunk: Buffer) => {
      observedBytes += chunk.length;
      if (observedBytes > 256 * 1024) {
        observerFailure ??= new Error("The owned observer output exceeded its bound.");
        return;
      }
      pending += chunk.toString("utf8");
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const value = JSON.parse(line);
          if (value.kind === "observation") {
            assert.equal(value.rootPid, agent!.pid);
            assert.equal(
              path.resolve(value.hostPath),
              path.join(install, "runtimes", identity.runtimeId, "app", "NemoClaw.Runtime.exe"),
            );
            assert.ok(
              Array.isArray(value.ports) &&
                value.ports.every(
                  (port: number) => Number.isSafeInteger(port) && port > 0 && port <= 65535,
                ),
            );
            latest = value;
          } else if (value.kind === "stop-invoked") stopInvoked = true;
          else if (value.kind === "stop-snapshot") {
            assert.equal(value.rootPid, agent!.pid);
            assert.ok(typeof value.label === "string" && Number.isFinite(value.stopElapsedMs));
            assert.ok(Buffer.byteLength(line) <= 64 * 1024);
          } else if (value.kind === "closed") {
            assert.equal(value.exitCode, 0);
            results.nativeStop = value;
            stopped = true;
          } else throw new Error("Unexpected installed session observer record.");
          if (observerRecords.length === 128) {
            observerRecords.shift();
            omittedObserverRecords++;
          }
          observerRecords.push({ receivedMs: performance.now() - observerStarted, record: value });
        } catch (error) {
          observerFailure ??=
            error instanceof Error ? error : new Error("Invalid observer record.");
        }
      }
    });
    const started = performance.now(),
      deadline = started + 180_000;
    let origin: string | undefined;
    while (!origin && performance.now() < deadline) {
      if (observerFailure) throw observerFailure;
      assert.equal(agent.exitCode, null, "The installed session exited during startup.");
      assert.equal(observer.exitCode, null, "The owned UI observer exited during startup.");
      if (latest?.openEnabled)
        for (const port of latest.ports) {
          const candidate = `http://127.0.0.1:${port}`;
          const probe: Record<string, unknown> = {
            port,
            startedMs: performance.now() - observerStarted,
          };
          try {
            const response = await fetch(candidate + "/chat", {
              redirect: "error",
              signal: AbortSignal.timeout(1000),
            });
            probe.status = response.status;
            const type = response.headers.get("content-type") ?? "";
            probe.contentType = type.startsWith("text/html")
              ? "html"
              : type.startsWith("application/json")
                ? "json"
                : type
                  ? "other"
                  : "absent";
            const html = await response.text();
            probe.bodyBytes = Buffer.byteLength(html, "utf8");
            probe.bodyCharacters = html.length;
            probe.dashboardMarker = /<openclaw-app(?:\s|>)/u.test(html);
            if (response.ok && html.length < 65536 && /<openclaw-app(?:\s|>)/u.test(html)) {
              origin = candidate;
              break;
            }
          } catch (error) {
            // No response body, raw header, URL query or arbitrary error text is retained.
            probe.errorName = error instanceof Error ? error.name : "UnknownError";
            const cause = error instanceof Error ? error.cause : null;
            const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
            probe.errorCode =
              typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : null;
          } finally {
            probe.completedMs = performance.now() - observerStarted;
            if (httpProbes.length === 128) {
              httpProbes.shift();
              omittedHttpProbes++;
            }
            httpProbes.push(probe);
          }
        }
      if (!origin) await sleep(500);
    }
    assert.ok(origin, "The owned installed gateway did not publish its real dashboard.");
    results.startup = { elapsedMs: performance.now() - started, observation: latest, origin };
    phase = "browser";
    const driverRoot = path.resolve(argument("--browser-driver-root"));
    const require = createRequire(path.join(driverRoot, "package.json"));
    const { chromium } = require(driverRoot);
    const edge = [
      process.env["ProgramFiles(x86)"],
      process.env.ProgramFiles,
      process.env.PROGRAMFILES,
    ]
      .filter(Boolean)
      .map((root) => path.join(root!, "Microsoft", "Edge", "Application", "msedge.exe"))
      .find((file) => fs.existsSync(file));
    assert.ok(edge, "Microsoft Edge is required for the actual browser control.");
    const activeBrowser = await chromium.launch({
      executablePath: edge,
      headless: false,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    browser = activeBrowser;
    const page = await activeBrowser.newPage({ viewport: { width: 1440, height: 900 } });
    failurePage = page;
    await page.goto(
      origin +
        "/chat" +
        (mode.reuse
          ? "?session=" + encodeURIComponent(previous.restart.retainedConversation.sessionKey)
          : ""),
      { waitUntil: "domcontentloaded", timeout: 90_000 },
    );
    await page.waitForURL((url: URL) => exactChatAddress(url.href, origin!), { timeout: 30_000 });
    const composer = page.locator(".agent-chat__composer-combobox > textarea").first();
    await composer.waitFor({ state: "visible", timeout: 90_000 });
    await page.waitForFunction(visibleChatReady, undefined, { timeout: 90_000 });
    const rpc = (method: string, params: Record<string, unknown>) =>
      boundedClose(
        page.evaluate(requestVisibleGateway, { method, params }),
        45_000,
      ) as Promise<any>;
    const sessionKey = await page.evaluate(
      () =>
        (
          globalThis.document.querySelector("openclaw-app-shell") as unknown as {
            activeSessionKey?: string;
          }
        )?.activeSessionKey,
    );
    assert.ok(
      typeof sessionKey === "string" && /^agent:main:[A-Za-z0-9:._-]+$/u.test(sessionKey),
      "The visible chat session identity is missing.",
    );
    if (mode.reuse) {
      phase = "conversation-retention";
      assert.equal(sessionKey, previous.restart.retainedConversation.sessionKey);
      const retained = openClawTranscriptIdentity(
        sessionKey,
        await rpc("chat.history", { sessionKey, limit: 100, maxChars: 20000 }),
      );
      assert.deepEqual(
        retained,
        previous.restart.retainedConversation,
        "The prior conversation changed or disappeared across restart.",
      );
      await page
        .getByText(previous.results.response.visibleReply, { exact: true })
        .last()
        .waitFor({ state: "visible", timeout: 30_000 });
      restart.restoredConversation = retained;
    }
    const waitForReply = async (prompt: string, expected: string) => {
      const diagnosticStop = new AbortController();
      const terminal = (async () => {
        while (!diagnosticStop.signal.aborted) {
          await sleep(1000);
          if (diagnosticStop.signal.aborted) return;
          let history: unknown;
          try {
            history = await rpc("chat.history", { sessionKey, limit: 100, maxChars: 20000 });
          } catch {
            continue;
          } // A failed diagnostic read cannot replace the ordinary reply deadline.
          if (diagnosticStop.signal.aborted) return;
          const error = terminalAgentError(history, prompt);
          if (error) throw new Error("The installed agent failed: " + error);
        }
      })();
      try {
        await Promise.race([
          page
            .getByText(expected, { exact: true })
            .last()
            .waitFor({ state: "visible", timeout: 180_000 }),
          terminal,
        ]);
      } finally {
        diagnosticStop.abort();
      }
    };
    phase = "nvidia-response";
    const responseStarted = performance.now();
    const nonce = randomBytes(12).toString("hex"),
      reply = "NEMOCLAW_NVIDIA_" + nonce;
    const responsePrompt = "Reply with exactly this text and no other text: " + reply;
    await composer.fill(responsePrompt);
    await composer.press("Enter");
    await waitForReply(responsePrompt, reply);
    await page.screenshot({ path: path.join(output, "nvidia-response.png") });
    results.response = {
      provider: "nvidia",
      model,
      visibleReply: reply,
      deterministicModel: false,
      elapsedMs: performance.now() - responseStarted,
    };
    phase = "tools";
    const toolsStarted = performance.now();
    const catalog = await rpc("tools.catalog", { agentId: "main", includePlugins: true });
    const effective = await rpc("tools.effective", { agentId: "main", sessionKey });
    const catalogIds = toolIds(catalog),
      effectiveIds = toolIds(effective);
    results.tools = {
      catalogIds,
      effectiveIds,
      search: {
        catalogRegistered: catalogIds.includes("web_search"),
        effectiveAvailable: effectiveIds.includes("web_search"),
        configured: false,
        liveLookup: "waived-no-key",
        liveQualified: false,
      },
    };
    for (const name of ["read", "write", "exec"])
      assert.ok(effectiveIds.includes(name), "Required effective tool unavailable: " + name);
    assert.ok(catalogIds.includes("web_search"), "The web search catalog registration is missing.");
    const file = "nemoclaw-acceptance-" + nonce + ".txt";
    // Gateway tools.invoke constructs gateway-visible tools, not the agent's
    // base coding tools. Exercise write/read through the same real model turn.
    // Local code uses the packaged Node executable through the actual shell tool.
    // OpenClaw's unrelated code_execution tool needs xAI; no extra provider is invented.
    const nodeCommand =
      "& '" +
      path.join(install, "bin", "node.exe").replaceAll("'", "''") +
      "' -e \"process.stdout.write('NEMOCLAW_CODE_" +
      nonce +
      ":'+String(6*7))\"";
    const shellCommand = "Write-Output 'NEMOCLAW_SHELL_" + nonce + "'";
    const completed = "NEMOCLAW_TOOLS_" + nonce;
    const toolPrompt =
      "Use the write tool with these exact arguments: " +
      JSON.stringify({ path: file, content: nonce }) +
      ". Then use the read tool with these exact arguments and verify the file content: " +
      JSON.stringify({ path: file }) +
      ". Then use the exec tool to run each of these exact PowerShell commands separately. Do not change the arguments or commands, or simulate tool output. First command: " +
      JSON.stringify(shellCommand) +
      ". Second: " +
      JSON.stringify(nodeCommand) +
      ". After all four tool calls succeed, reply with exactly " +
      completed;
    await composer.fill(toolPrompt);
    await composer.press("Enter");
    await waitForReply(toolPrompt, completed);
    const history = await rpc("chat.history", { sessionKey, limit: 100, maxChars: 20000 });
    assertRecordedOpenClawReply(history, responsePrompt, reply);
    assertRecordedOpenClawReply(history, toolPrompt, completed);
    results["tool-write"] = recordedFileTool(history, "write", file, nonce);
    results["tool-read"] = recordedFileTool(history, "read", file, nonce);
    results["tool-shell"] = recordedExec(history, shellCommand, "NEMOCLAW_SHELL_" + nonce);
    results["tool-local-code"] = recordedExec(
      history,
      nodeCommand,
      "NEMOCLAW_CODE_" + nonce + ":42",
    );
    await page.screenshot({ path: path.join(output, "tool-response.png") });
    results.toolsElapsedMs = performance.now() - toolsStarted;
    if (mode.restart)
      restart.retainedConversation = openClawTranscriptIdentity(sessionKey, history);
    if (mode.reuse) assertRetainedOpenClawPrefix(previous.restart.retainedConversation, history);
    results.browser = {
      version: activeBrowser.version(),
      realDashboard: true,
      containedGateway: true,
    };
    // Model/tool results and their durations are already recorded. This read-only
    // companion is independent diagnostic evidence and never owns application Stop.
    if (performance.now() > observerDeadline - 45_000 - 130_000) {
      results.idleObservation = {
        status: "censored",
        reason: "The existing observer deadline must retain its normal Stop budget.",
      };
    } else {
      try {
        assert.ok(latest && agent.pid);
        results.idleObservation = await sampleInstalledIdle(
          {
            installRoot: install,
            guardianPid: agent.pid,
            guardianStartedUtc: latest.rootStartedUtc,
            hostPid: latest.hostPid,
            hostStartedUtc: latest.hostStartedUtc,
            runtimeId: identity.runtimeId,
            sourceRevision: identity.sourceRevision,
            manifestSha256: identity.manifestSha256,
          },
          path.join(output, "installed-idle.json"),
        );
      } catch (error) {
        results.idleObservation = {
          status: "failed",
          error: sanitizedFailure(error, secret),
        };
      }
    }
  } catch (error) {
    primary = error;
    results.observerAtFailure = observerSnapshot();
    try {
      write("owned-observer-at-failure.json", observerSnapshot());
    } catch (failure) {
      results.observerEvidenceFailure = sanitizedFailure(failure, secret);
    }
    results.failureDiagnostics = await captureFailure(
      error,
      failurePage,
      path.join(output, "failure.png"),
      secret,
    );
  } finally {
    const cleanupStarted = performance.now();
    if (browser)
      try {
        await browser.close();
        results.automationBrowserClosed = true;
      } catch (error) {
        cleanupFailed("automation browser", error);
      }
    if (observer && agentClosed && observerClosed) {
      try {
        signalObserverStop(observerStopSentinel);
        assert.equal(await boundedClose(agentClosed, 130_000), 0);
        assert.equal(await boundedClose(observerClosed, 5000), 0);
        fs.unlinkSync(observerStopSentinel);
        assert.equal(stopInvoked, true);
        assert.equal(stopped, true);
        const session = path.join(output, "session");
        const receipts = fs
          .readdirSync(session)
          .filter((name) => /^native-windows-web-ui-[a-f0-9]+\.json$/u.test(name));
        assert.equal(receipts.length, 1);
        const result = JSON.parse(fs.readFileSync(path.join(session, receipts[0]), "utf8"));
        assert.equal(result.verdict, "pass");
        assert.equal(result.deterministicLocalModel, false);
        assert.equal(result.runtimeBytesCopied, 0);
        for (const key of ["runtimeId", "manifestSha256", "sourceRevision"])
          assert.equal(result.runtimeIdentity[key], identity[key]);
        assert.equal(result.backend, "process_container");
        assert.equal(result.architecture, "arm64");
        assert.notEqual(result.inferenceTransport, "contained-deterministic-model");
        for (const name of [
          "sandboxDeleted",
          "sandboxRegistryAbsent",
          "gatewayStopped",
          "qualificationRootsRemoved",
        ])
          assert.equal(result[name], true);
        results.sessionCleanup = result;
      } catch (error) {
        cleanupFailed("native Stop or backend cleanup", error);
      }
    }
    if (agent && agent.exitCode === null && agent.pid) {
      try {
        const taskkill = path.join(
          process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "",
          "System32",
          "taskkill.exe",
        );
        const killed = await captureOwned(
          taskkill,
          ["/PID", String(agent.pid), "/T", "/F"],
          environment,
          "",
          15_000,
        );
        assert.equal(killed.exitCode, 0);
        if (agentClosed) await boundedClose(agentClosed, 5000);
      } catch (error) {
        cleanupFailed("owned launcher emergency termination", error);
      }
    }
    if (observer && observer.exitCode === null) {
      try {
        observer.kill();
        if (observerClosed) await boundedClose(observerClosed, 5000);
      } catch (error) {
        cleanupFailed("owned observer", error);
      }
    }
    try {
      write("owned-session-observer.json", observerSnapshot());
      if (mode.restart && !configurationOwned)
        results.nativeSessionDiagnostics = { status: "unowned-not-read", retained: [] };
      else
        results.nativeSessionDiagnostics = await retainNativeSessionDiagnostics(
          stateRoot,
          async (directory) => {
            const reply = await captureOwned(
              launcher,
              ["--native-ui-file-owner", directory],
              environment,
              "read\tready\nclose\n",
              10_000,
            );
            assert.equal(reply.failure, null);
            assert.equal(reply.exitCode, 0);
            return decodeDiagnosticOwnerRead(reply.stdout);
          },
          write,
          secret,
        );
    } catch (error) {
      results.nativeSessionDiagnosticFailure = sanitizedFailure(error, secret);
    }
    if (mode.restart && restart) {
      restart.processesStopped = acceptanceProcessesStopped(agent, observer);
      restart.stateOwnerReleased = stateOwnerReleased;
      restart.mutationUnconfirmed = mutationUnconfirmed;
      restart.backendCleanupConfirmed = !agent || results.sessionCleanup !== undefined;
      await completeOpenClawRestartState({
        restart,
        owned: configurationOwned,
        preserve: mode.preserve,
        successful: primary === undefined && cleanupErrors.length === 0,
        launcher,
        ownedState,
        configurationPath: path.join(stateRoot, "native-windows.json"),
        configurationSha256,
        binding,
        command,
        cleanupFailed,
      });
    } else if (binding) {
      try {
        await command("remove-configured-data", ["--remove-native-data", "--agent", "openclaw"]);
      } catch (error) {
        cleanupFailed("configured agent data", error);
      }
      try {
        await command("credential-delete", ["--credential-delete", "nvidia", "--binding", binding]);
      } catch (error) {
        cleanupFailed("NVIDIA credential deletion", error);
      }
    }
    results.cleanupElapsedMs = performance.now() - cleanupStarted;
    try {
      write("owned-process-output.json", logs);
    } catch (error) {
      primary ??= error;
    }
  }
  if (cleanupErrors.length) primary ??= new Error("Installed acceptance cleanup did not finish.");
  try {
    write("installed-openclaw-acceptance.json", {
      schemaVersion: mode.restart ? 2 : 1,
      classification: "installed-compiled-openclaw-acceptance",
      runtime: identity,
      ...(mode.restart ? { restart } : {}),
      verdict: primary === undefined ? "pass" : "fail",
      failedStage: primary === undefined ? null : phase,
      error:
        primary instanceof Error
          ? primary.message
          : primary === undefined
            ? null
            : "Installed acceptance failed.",
      results,
      cleanupErrors,
      cleanupErrorDetails,
      primaryFailure: primary === undefined ? null : sanitizedFailure(primary, secret),
      fullProductQualification: false,
      liveSearchQualified: false,
      defaultBrowserLifetime: "delegated-to-Windows; automation browser closed separately",
    });
  } catch (error) {
    primary ??= error;
  }
  if (primary !== undefined)
    throw new Error(
      redact(primary instanceof Error ? primary.message : "Installed acceptance failed."),
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--capture-artifact-source")) {
    const snapshot = captureOpenClawArtifactSources({
      artifactSourceRoot: argument("--artifact-source-root"),
      controllerSourceRoot: argument("--controller-source-root"),
      artifactSourceRevision: argument("--artifact-source-revision"),
      controllerSourceRevision: argument("--controller-source-revision"),
      controllerRun: argument("--controller-run"),
    });
    const bytes = Buffer.from(JSON.stringify(snapshot) + "\n");
    assert(bytes.length <= 256 * 1024, "The candidate source snapshot exceeds its bound.");
    fs.writeFileSync(argument("--output"), bytes, { flag: "wx" });
    process.stdout.write(digest(bytes) + "\n");
  } else await main();
}
