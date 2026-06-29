// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MSTEAMS_HINT_PRELOAD = path.join(
  import.meta.dirname,
  "..",
  "src",
  "lib",
  "messaging",
  "channels",
  "teams",
  "runtime",
  "msteams-message-hints.ts",
);

const MSTEAMS_MENTION_HINT =
  "- MSTeams mentions: use `@[Display Name](Teams user id or AAD object id)` in `message`; plain `@name` text is not a native mention and will not notify.";

const ADAPTIVE_CARD_HINT =
  "- Adaptive Cards supported. Use `action=send` with `card={type,version,body}` to send rich cards.";

const TARGETING_HINT =
  "- MSTeams targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:ID` or `user:Display Name` (requires Graph API) for DMs, `conversation:19:...@thread.tacv2` for groups/channels. Prefer IDs over display names for speed.";

const SAN_DANG_AAD_OBJECT_ID = "205f29da-231e-4a0e-a0b2-b398e6302087";

type RealMSTeamsBoundaryProof = {
  activity: {
    text: string;
    entities: Array<Record<string, unknown>>;
  };
  hints: string[];
};

const requireFromTest = createRequire(import.meta.url);

function pluginFixtureSource(moduleType: "commonjs" | "esm", includeMentionHint = false): string {
  const hints = includeMentionHint
    ? [ADAPTIVE_CARD_HINT, MSTEAMS_MENTION_HINT, TARGETING_HINT]
    : [ADAPTIVE_CARD_HINT, TARGETING_HINT];
  const pluginSource = [
    "const msteamsPlugin = {",
    "  agentPrompt: {",
    "    messageToolHints: () => [",
    ...hints.map((hint) => `      ${JSON.stringify(hint)},`),
    "    ],",
    "  },",
    "};",
  ];
  return [
    ...pluginSource,
    moduleType === "esm" ? "export { msteamsPlugin };" : "module.exports = { msteamsPlugin };",
    "",
  ].join("\n");
}

function writeMSTeamsPackage(
  root: string,
  options: { moduleType?: "commonjs" | "esm"; includeMentionHint?: boolean } = {},
): string {
  const moduleType = options.moduleType ?? "commonjs";
  const pkgDir = path.join(root, "node_modules", "@openclaw", "msteams");
  const distDir = path.join(pkgDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/msteams",
      version: "2026.5.27",
      ...(moduleType === "esm" ? { type: "module" } : {}),
    }),
  );
  const channelFile = path.join(distDir, "channel-fixture.js");
  fs.writeFileSync(
    channelFile,
    pluginFixtureSource(moduleType, options.includeMentionHint ?? false),
  );
  return channelFile;
}

function writeUnrelatedMSTeamsLikeModule(root: string): string {
  const moduleDir = path.join(root, "vendor", "msteams", "fake-channel");
  fs.mkdirSync(moduleDir, { recursive: true });
  const moduleFile = path.join(moduleDir, "index.js");
  fs.writeFileSync(moduleFile, pluginFixtureSource("commonjs"));
  return moduleFile;
}

function writeOpenClawSdkStub(root: string) {
  const packageDir = path.join(root, "node_modules", "openclaw");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "openclaw",
      type: "module",
      exports: {
        "./plugin-sdk/*": "./plugin-sdk/*.js",
      },
    }),
  );

  const genericSdkStub = `
export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1048576;
export const MSTeamsConfigSchema = {};
export const PAIRING_APPROVED_MESSAGE = "approved";
export function adaptMessagePresentationForChannel(value) { return value; }
export function buildChannelKeyCandidates() { return []; }
export function buildChannelOutboundSessionRoute(value) { return value; }
export function buildChannelProgressDraftLine() { return ""; }
export function buildChannelProgressDraftLineForEntry() { return ""; }
export function buildProbeChannelStatusSummary() { return {}; }
export function buildStreamInfoEntity() { return {}; }
export function createAllowlistProviderGroupPolicyWarningCollector() { return () => []; }
export function createChannelDirectoryAdapter(value) { return value || {}; }
export function createChannelMessageAdapterFromOutbound(value) { return value || {}; }
export function createChannelMessageReplyPipeline() { return {}; }
export function createChannelPairingController(value) { return value || {}; }
export function createChannelProgressDraftGate() { return {}; }
export function createChatChannelPlugin(value) { return { ...value, ...(value && value.base ? value.base : {}) }; }
export function createComputedAccountStatusAdapter(value) { return value || {}; }
export function createDangerousNameMatchingMutableAllowlistWarningCollector() { return () => []; }
export function createDefaultChannelRuntimeState() { return {}; }
export function createDraftStreamLoop() { return {}; }
export function createLazyRuntimeNamedExport() { return async () => ({}); }
export function createLiveMessageState() { return {}; }
export function createPairingPrefixStripper() { return (value) => value; }
export function createPreviewMessageReceipt() { return {}; }
export function createResolvedApproverActionAuthAdapter(value) { return value || {}; }
export function createRuntimeDirectoryLiveAdapter(value) { return value || {}; }
export function createRuntimeOutboundDelegates(value) { return value || {}; }
export function createSetupTranslator() { return (value) => value; }
export function createStandardChannelSetupStatus() { return {}; }
export function createTopLevelChannelAllowFromSetter() { return {}; }
export function createTopLevelChannelConfigAdapter(value) { return value || {}; }
export function createTopLevelChannelDmPolicy() { return {}; }
export function createTopLevelChannelGroupPolicySetter() { return {}; }
export function defineBundledChannelEntry(value) { return value; }
export function defineBundledChannelSetupEntry(value) { return value; }
export function defineFinalizableLivePreviewAdapter(value) { return value || {}; }
export function deliverWithFinalizableLivePreviewAdapter(value) { return value; }
export function describeAccountSnapshot() { return ""; }
export function dispatchReplyFromConfigWithSettledDispatcher() {}
export function filterSupplementalContextItems(value) { return value || []; }
export function formatAllowFromLowercase(value) { return String(value || ""); }
export function formatChannelProgressDraftText(value) { return String(value || ""); }
export function formatDocsLink(value) { return value; }
export function isChannelProgressDraftWorkToolName() { return false; }
export function isDangerousNameMatchingEnabled() { return false; }
export function keepHttpServerTaskAlive() {}
export function listDirectoryEntriesFromSources() { return []; }
export function logInboundDrop() {}
export function logTypingFailure() {}
export function mapAllowlistResolutionInputs(value) { return value; }
export function markLiveMessageFinalized(value) { return value; }
export function mergeAllowFromEntries(a, b) { return [...(a || []), ...(b || [])]; }
export function mergeAllowlist(a, b) { return [...(a || []), ...(b || [])]; }
export function mergeChannelProgressDraftLine(value) { return value; }
export function normalizeChannelProgressDraftLineIdentity(value) { return value; }
export function normalizeChannelSlug(value) { return String(value || ""); }
export function normalizeMessagePresentation(value) { return value; }
export function projectConfigWarningCollector(fn) { return fn; }
export function resolveAllowlistMatchSimple() { return { allowed: true }; }
export function resolveApprovalApprovers() { return []; }
export function resolveChannelContextVisibilityMode() { return "default"; }
export function resolveChannelEntryMatchWithFallback() { return null; }
export function resolveChannelProgressDraftMaxLines() { return 20; }
export function resolveChannelStreamingBlockEnabled() { return false; }
export function resolveChannelStreamingPreviewToolProgress() { return {}; }
export function resolveDefaultGroupPolicy() { return "open"; }
export function resolveInboundMentionDecision() { return {}; }
export function resolveInboundReplyDispatchCounts() { return {}; }
export function resolveInboundSessionEnvelopeContext() { return {}; }
export function resolveNestedAllowlistDecision() { return { allowed: true }; }
export function resolveStableChannelMessageIngress() { return {}; }
export function resolveThreadSessionKeys() { return []; }
export function resolveToolsBySender() { return []; }
export function stripChannelTargetPrefix(value) { return value; }
export function stripTargetKindPrefix(value) { return value; }
export function summarizeMapping() { return ""; }
export function splitSetupEntries(value) { return Array.isArray(value) ? value : []; }
export const channelIngressRoutes = {};
`;

  const stubSources: Record<string, string> = {
    "account-helpers": genericSdkStub,
    "account-id": genericSdkStub,
    "allow-from": genericSdkStub,
    "approval-auth-runtime": genericSdkStub,
    "bundled-channel-config-schema": `${genericSdkStub}
export function buildChannelConfigSchema() { return {}; }
`,
    "channel-config-helpers": genericSdkStub,
    "channel-core": genericSdkStub,
    "channel-entry-contract": genericSdkStub,
    "channel-inbound": genericSdkStub,
    "channel-ingress-runtime": genericSdkStub,
    "channel-outbound": `${genericSdkStub}
export function createMessageReceiptFromOutboundResults(value) { return value; }
export function resolveOutboundSendDep(deps, channel) { return deps && (deps[channel] || deps.send); }
`,
    "channel-pairing": genericSdkStub,
    "channel-policy": genericSdkStub,
    "channel-send-result": `${genericSdkStub}
export function attachChannelToResult(channel, result) { return { ...(result || {}), channel }; }
export function createAttachedChannelResultAdapter(value) { return value || {}; }
`,
    "channel-status": genericSdkStub,
    "channel-targets": genericSdkStub,
    "context-visibility-runtime": genericSdkStub,
    "dangerous-name-runtime": genericSdkStub,
    "directory-runtime": genericSdkStub,
    "file-lock": "export async function withFileLock(_file, _opts, fn) { return await fn(); }\n",
    "interactive-runtime": genericSdkStub,
    "json-store": `
import { promises as fs } from "node:fs";
import path from "node:path";
export async function readJsonFileWithFallback(file, fallback) {
  try {
    return { value: JSON.parse(await fs.readFile(file, "utf8")), exists: true };
  } catch {
    return { value: fallback, exists: false };
  }
}
export async function writeJsonFileAtomically(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}
`,
    "lazy-runtime": genericSdkStub,
    "markdown-table-runtime": 'export function resolveMarkdownTableMode() { return "code"; }\n',
    "media-runtime": `
export async function detectMime() { return "application/octet-stream"; }
export function extensionForMime() { return ".bin"; }
export function extractOriginalFilename(value) {
  return String(value).split(/[\\\\/]/).pop() || "file.bin";
}
export function getFileExtension(value) {
  const text = String(value);
  const index = text.lastIndexOf(".");
  return index >= 0 ? text.slice(index) : "";
}
export function resolveChannelMediaMaxBytes() { return 1000000; }
export async function saveResponseMedia() {}
`,
    "outbound-media":
      'export async function loadOutboundMediaFromUrl() { throw new Error("unexpected outbound media load"); }\n',
    "provider-http":
      "export async function readProviderJsonResponse(response) { return await response.json(); }\n",
    "reply-chunking": `
export const SILENT_REPLY_TOKEN = "__silent__";
export function isSilentReplyText(text, token) { return text === token; }
`,
    "reply-history": genericSdkStub,
    "reply-payload": `
export function buildMediaPayload(value) { return value; }
export function resolvePayloadMediaUrls(value) {
  return value.mediaUrls || (value.mediaUrl ? [value.mediaUrl] : []);
}
export function resolveSendableOutboundReplyParts(payload, opts = {}) {
  const mediaUrls = resolvePayloadMediaUrls(payload);
  const text = opts.text ?? payload.text ?? "";
  return { hasContent: Boolean(text || mediaUrls.length), hasMedia: mediaUrls.length > 0, text, mediaUrls };
}
export function resolveTextChunksWithFallback(text, fallback) {
  return Array.isArray(fallback) && fallback.length ? fallback : [text];
}
export async function sendPayloadMediaSequence({ text, mediaUrls, send }) {
  let result = text || !(mediaUrls && mediaUrls.length) ? await send({ text }) : undefined;
  for (const mediaUrl of mediaUrls || []) result = await send({ text, mediaUrl });
  return result;
}
`,
    routing: genericSdkStub,
    "runtime-env": genericSdkStub,
    "runtime-group-policy": genericSdkStub,
    "runtime-store": `
let runtime;
export function createPluginRuntimeStore({ errorMessage }) {
  return {
    setRuntime(value) { runtime = value; },
    getRuntime() { return runtime || (() => { throw new Error(errorMessage || "runtime missing"); })(); },
    tryGetRuntime() { return runtime; },
  };
}
`,
    "secret-input": `
export function normalizeSecretInputString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export function normalizeResolvedSecretInputString(value) { return normalizeSecretInputString(value); }
export function hasConfiguredSecretInput(value) { return Boolean(normalizeSecretInputString(value)); }
`,
    "security-runtime": `
import { promises as fs } from "node:fs";
export async function appendRegularFile() {}
export async function pathExists(value) {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}
export function privateFileStoreSync() {
  return { readJson: () => null, writeJson: () => {} };
}
`,
    setup: genericSdkStub,
    "setup-tools": genericSdkStub,
    "ssrf-policy": `
export function buildHostnameAllowlistPolicyFromSuffixAllowlist(value) { return { allowHosts: value }; }
export function isPrivateIpAddress() { return false; }
export function isHttpsUrlAllowedByHostnameSuffixAllowlist(url, list = []) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && list.some((suffix) => {
      const normalized = String(suffix).replace(/^\\./, "");
      return parsed.hostname === normalized || parsed.hostname.endsWith(normalized);
    });
  } catch {
    return false;
  }
}
export function normalizeHostnameSuffixAllowlist(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}
`,
    "ssrf-runtime": `
export async function fetchWithSsrFGuard({ url, fetchImpl, init }) {
  const response = await fetchImpl(url, init);
  return { response, release: async () => {} };
}
`,
    "status-helpers": genericSdkStub,
    "string-coerce-runtime": `
export function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
export function normalizeLowercaseStringOrEmpty(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
export function normalizeOptionalLowercaseString(value) {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  return normalized || undefined;
}
export function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export function normalizeStringEntries(value) {
  return Array.isArray(value) ? value.map(String).map((entry) => entry.trim()).filter(Boolean) : [];
}
export function readStringValue(value) { return typeof value === "string" ? value : undefined; }
export function uniqueStrings(value) { return [...new Set(value)]; }
`,
    "string-normalization-runtime": `
export function normalizeStringEntries(value) {
  return Array.isArray(value) ? value.map(String).map((entry) => entry.trim()).filter(Boolean) : [];
}
`,
    "text-chunking": `
export function chunkTextForOutbound(text) { return [text]; }
export function convertMarkdownTables(text) { return text; }
`,
    "text-utility-runtime": "export async function sleep() {}\n",
    "webhook-ingress": "export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1048576;\n",
    "web-media":
      'export async function loadWebMedia() { throw new Error("unexpected media load"); }\n',
  };

  for (const [name, source] of Object.entries(stubSources)) {
    const file = path.join(packageDir, "plugin-sdk", `${name}.js`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
}

function linkRealMSTeamsPackage(root: string): string {
  const packageJson = requireFromTest.resolve("@openclaw/msteams/package.json");
  const packageDir = path.dirname(packageJson);
  const scopeDir = path.join(root, "node_modules", "@openclaw");
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(packageDir, path.join(scopeDir, "msteams"), "dir");
  return packageDir;
}

function runRealMSTeamsBoundaryProbe(): {
  result: ReturnType<typeof spawnSync>;
  proof: RealMSTeamsBoundaryProof | null;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-real-msteams-boundary-"));
  try {
    linkRealMSTeamsPackage(tmp);
    writeOpenClawSdkStub(tmp);
    const script = `
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const packageDir = path.dirname(require.resolve("@openclaw/msteams/package.json"));
const distDir = path.join(packageDir, "dist");
const probeEntry = fs
  .readdirSync(distDir)
  .map((name) => ({ name, source: fs.readFileSync(path.join(distDir, name), "utf8") }))
  .find((entry) => /^probe-.*\\.js$/.test(entry.name) && entry.source.includes("sendMSTeamsMessages as"));
const exportName = /sendMSTeamsMessages as ([A-Za-z_$][\\w$]*)/.exec(probeEntry.source)[1];
const probeModule = await import(pathToFileURL(path.join(distDir, probeEntry.name)).href);
const sendMSTeamsMessages = probeModule[exportName];
const aadObjectId = ${JSON.stringify(SAN_DANG_AAD_OBJECT_ID)};
const sent = [];

await sendMSTeamsMessages({
  replyStyle: "thread",
  adapter: {
    continueConversation: async () => {},
    process: async () => {},
    updateActivity: async () => {},
    deleteActivity: async () => {},
  },
  appId: "app",
  conversationRef: {
    activityId: "activity123",
    user: { id: "29:user", name: "San Dang", aadObjectId },
    agent: { id: "28:bot", name: "Bot" },
    conversation: { id: "19:probe@thread.v2", conversationType: "groupChat" },
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
  },
  context: {
    sendActivity: async (activity) => {
      sent.push(activity);
      return { id: "id:one" };
    },
    updateActivity: async () => {},
    deleteActivity: async () => {},
  },
  messages: [{ text: "Please review this, @[San Dang](" + aadObjectId + ")." }],
  retry: false,
});

require(${JSON.stringify(MSTEAMS_HINT_PRELOAD)});
const plugin = require("@openclaw/msteams/dist/channel-plugin-api.js").msteamsPlugin;
const hints = plugin.agentPrompt.messageToolHints({ cfg: {} });
console.log(JSON.stringify({ activity: sent[0], hints }));
`;
    const result = spawnSync(process.execPath, ["--preserve-symlinks", "-e", script], {
      cwd: tmp,
      encoding: "utf-8",
      env: { ...process.env, NODE_OPTIONS: "" },
      timeout: 20_000,
    });
    return {
      result,
      proof:
        result.status === 0 && result.stdout.trim()
          ? (JSON.parse(result.stdout) as RealMSTeamsBoundaryProof)
          : null,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function runHintsProbe(fixtureFile: string, options: { requirePreloadTwice?: boolean } = {}) {
  const script = `
const preload = ${JSON.stringify(MSTEAMS_HINT_PRELOAD)};
require(preload);
${options.requirePreloadTwice ? "require(preload);" : ""}
const plugin = require(process.env.MSTEAMS_FILE).msteamsPlugin;
console.log(JSON.stringify(plugin.agentPrompt.messageToolHints({ cfg: {} })));
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      MSTEAMS_FILE: fixtureFile,
    },
    timeout: 10_000,
  });
  return {
    result,
    hints:
      result.status === 0 && result.stdout.trim() ? (JSON.parse(result.stdout) as string[]) : [],
  };
}

describe("OpenClaw Microsoft Teams message hint patch", () => {
  it("injects native mention syntax into CommonJS @openclaw/msteams hints", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-msteams-hints-cjs-"));
    const fixtureFile = writeMSTeamsPackage(tmp);
    try {
      const { result, hints } = runHintsProbe(fixtureFile, { requirePreloadTwice: true });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(hints).toEqual([ADAPTIVE_CARD_HINT, MSTEAMS_MENTION_HINT, TARGETING_HINT]);
      expect(fs.readFileSync(fixtureFile, "utf-8")).not.toContain(MSTEAMS_MENTION_HINT);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("injects native mention syntax into native require(esm) @openclaw/msteams hints", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-msteams-hints-esm-"));
    const fixtureFile = writeMSTeamsPackage(tmp, { moduleType: "esm" });
    try {
      const { result, hints } = runHintsProbe(fixtureFile);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(hints).toEqual([ADAPTIVE_CARD_HINT, MSTEAMS_MENTION_HINT, TARGETING_HINT]);
      expect(fs.readFileSync(fixtureFile, "utf-8")).not.toContain(MSTEAMS_MENTION_HINT);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("leaves upstream mention hints idempotent when OpenClaw already includes them", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-msteams-hints-present-"));
    const fixtureFile = writeMSTeamsPackage(tmp, { includeMentionHint: true });
    try {
      const { result, hints } = runHintsProbe(fixtureFile, { requirePreloadTwice: true });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(hints.filter((hint) => hint === MSTEAMS_MENTION_HINT)).toHaveLength(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not patch unrelated modules whose path merely contains msteams", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-msteams-hints-unrelated-"));
    const fixtureFile = writeUnrelatedMSTeamsLikeModule(tmp);
    try {
      const { result, hints } = runHintsProbe(fixtureFile);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(hints).toEqual([ADAPTIVE_CARD_HINT, TARGETING_HINT]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses the real @openclaw/msteams send path for native mention entities", () => {
    const { result, proof } = runRealMSTeamsBoundaryProbe();

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(proof).toBeTruthy();
    expect(proof?.hints).toContain(MSTEAMS_MENTION_HINT);
    expect(proof?.activity.text).toBe("Please review this, <at>San Dang</at>.");
    expect(proof?.activity.text).not.toContain(SAN_DANG_AAD_OBJECT_ID);
    expect(proof?.activity.entities).toContainEqual({
      type: "mention",
      text: "<at>San Dang</at>",
      mentioned: {
        id: SAN_DANG_AAD_OBJECT_ID,
        name: "San Dang",
      },
    });
  });

  it("does not install an ESM load hook that breaks relative module linking", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-msteams-relative-esm-"));
    const indexFile = path.join(tmp, "index.mjs");
    fs.writeFileSync(path.join(tmp, "max.js"), "export const max = 7;\n");
    fs.writeFileSync(indexFile, 'export { max } from "./max.js";\n');
    try {
      const script = `
require(${JSON.stringify(MSTEAMS_HINT_PRELOAD)});
import(${JSON.stringify(path.toNamespacedPath(indexFile))}).then((mod) => {
  console.log(String(mod.max));
}).catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`;
      const result = spawnSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        timeout: 10_000,
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toBe("7");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
