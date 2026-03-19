"use strict";
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRuntimeSummary = getRuntimeSummary;
exports.registerRuntimeContext = registerRuntimeContext;
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const yaml_1 = __importDefault(require("yaml"));
const state_js_1 = require("./blueprint/state.js");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
const OPEN_SHELL_TIMEOUT_MS = 5000;
const MAX_SUMMARY_RULES = 3;
const MAX_SUMMARY_PATHS = 4;
const sessionRuntimeCache = new Map();
function getSandboxName(pluginConfig) {
    return (0, state_js_1.loadState)().sandboxName ?? pluginConfig.sandboxName;
}
async function execOpenShell(args) {
    try {
        const { stdout } = await execFileAsync("openshell", args, {
            timeout: OPEN_SHELL_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
        });
        return stdout.trim() || null;
    }
    catch {
        return null;
    }
}
function parseLabeledLine(output, label) {
    if (!output) {
        return null;
    }
    const line = output
        .split("\n")
        .map((value) => value.trim())
        .find((value) => value.startsWith(`${label}:`));
    if (!line) {
        return null;
    }
    const value = line.slice(label.length + 1).trim();
    return value.length > 0 ? value : null;
}
function coerceStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim());
}
function normalizePolicyYaml(output) {
    if (!output) {
        return null;
    }
    const yamlStartMarkers = ["\n---\n", "---\n", "\nversion:", "version:\n", "\nfilesystem_policy:"];
    for (const marker of yamlStartMarkers) {
        const index = output.indexOf(marker);
        if (index === -1) {
            continue;
        }
        return marker.startsWith("\n") ? output.slice(index + 1).trim() : output.slice(index).trim();
    }
    return output.trim();
}
function describeEndpointAccess(endpoint) {
    if (typeof endpoint["access"] === "string" && endpoint["access"].trim().length > 0) {
        return endpoint["access"].trim();
    }
    const rules = Array.isArray(endpoint["rules"]) ? endpoint["rules"] : [];
    if (rules.length > 0) {
        const ruleCount = String(rules.length);
        return `${ruleCount} custom rule${rules.length === 1 ? "" : "s"}`;
    }
    if (typeof endpoint["protocol"] === "string" && endpoint["protocol"].trim().length > 0) {
        return endpoint["protocol"].trim();
    }
    return "explicit allow";
}
function summarizeNetworkPolicies(policy) {
    const networkPolicies = (policy?.["network_policies"] ?? {});
    const entries = Object.entries(networkPolicies);
    if (entries.length === 0) {
        return [
            "outbound network is deny-by-default; assume no arbitrary internet access",
            "blocked requests can return proxy 403 and may need operator approval or policy changes",
        ];
    }
    const lines = entries.slice(0, MAX_SUMMARY_RULES).map(([ruleId, entry]) => {
        const e = entry;
        const name = (typeof e["name"] === "string" ? e["name"].trim() : null) || ruleId;
        const endpoints = Array.isArray(e["endpoints"]) ? e["endpoints"] : [];
        const endpoint = endpoints[0];
        const host = (typeof endpoint?.["host"] === "string" ? endpoint["host"].trim() : null) || "unknown-host";
        const port = typeof endpoint?.["port"] === "number" ? endpoint["port"] : 0;
        const destination = port > 0 ? `${host}:${String(port)}` : host;
        const access = endpoint ? describeEndpointAccess(endpoint) : "explicit allow";
        const binaries = Array.isArray(e["binaries"]) ? e["binaries"] : [];
        const firstBinary = binaries[0];
        const binary = typeof firstBinary?.["path"] === "string" ? firstBinary["path"].trim() : undefined;
        const binaryNote = binary ? ` via ${binary}` : "";
        return `${name}: ${destination} (${access})${binaryNote}`;
    });
    if (entries.length > MAX_SUMMARY_RULES) {
        lines.push(`${String(entries.length - MAX_SUMMARY_RULES)} additional network rule(s) omitted`);
    }
    lines.unshift("outbound network is deny-by-default except for the active policy rules below");
    lines.push("if a fetch fails with proxy 403, report it as an OpenShell policy block");
    return lines;
}
function summarizeFilesystem(policy) {
    const fsPolicy = policy?.["filesystem_policy"];
    if (!fsPolicy) {
        return ["filesystem/process access is sandboxed; do not assume host-level access"];
    }
    const lines = ["filesystem/process access is sandboxed; do not assume host-level access"];
    if (fsPolicy["include_workdir"] === true) {
        lines.push("working directory is included in the sandbox policy");
    }
    const readWrite = coerceStringArray(fsPolicy["read_write"]).slice(0, MAX_SUMMARY_PATHS);
    if (readWrite.length > 0) {
        lines.push(`writable paths include: ${readWrite.join(", ")}`);
    }
    const readOnly = coerceStringArray(fsPolicy["read_only"]).slice(0, MAX_SUMMARY_PATHS);
    if (readOnly.length > 0) {
        lines.push(`read-only paths include: ${readOnly.join(", ")}`);
    }
    return lines;
}
async function loadPolicyDoc(sandboxName) {
    const output = await execOpenShell(["policy", "get", sandboxName, "--full"]);
    const yamlText = normalizePolicyYaml(output);
    if (!yamlText) {
        return null;
    }
    try {
        const parsed = yaml_1.default.parse(yamlText);
        if (!parsed || typeof parsed !== "object") {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
async function getRuntimeSummaryFromFingerprint(fingerprint) {
    const policyDoc = await loadPolicyDoc(fingerprint.sandboxName);
    return {
        sandboxName: fingerprint.sandboxName,
        sandboxPhase: fingerprint.sandboxPhase,
        networkLines: summarizeNetworkPolicies(policyDoc),
        filesystemLines: summarizeFilesystem(policyDoc),
    };
}
async function getRuntimeFingerprint(pluginConfig) {
    const sandboxName = getSandboxName(pluginConfig);
    const [sandboxOutput, policyOutput] = await Promise.all([
        execOpenShell(["sandbox", "get", sandboxName]),
        execOpenShell(["policy", "get", sandboxName]),
    ]);
    return {
        sandboxName,
        sandboxPhase: parseLabeledLine(sandboxOutput, "Phase"),
        policyVersion: parseLabeledLine(policyOutput, "Version"),
        policyHash: parseLabeledLine(policyOutput, "Hash"),
        policyStatus: parseLabeledLine(policyOutput, "Status"),
    };
}
function serializeFingerprint(fingerprint) {
    return [
        fingerprint.sandboxName,
        fingerprint.sandboxPhase ?? "",
        fingerprint.policyVersion ?? "",
        fingerprint.policyHash ?? "",
        fingerprint.policyStatus ?? "",
    ].join("|");
}
function getSessionCacheKey(pluginConfig, hookContext) {
    if (hookContext && typeof hookContext === "object") {
        const ctx = hookContext;
        const sessionKey = ctx["sessionKey"];
        if (typeof sessionKey === "string" && sessionKey.trim().length > 0) {
            return sessionKey;
        }
    }
    return `nemoclaw:${getSandboxName(pluginConfig)}`;
}
function buildRuntimeContextText(summary) {
    const lines = [
        "<nemoclaw-runtime>",
        `You are running inside OpenShell sandbox "${summary.sandboxName}" via NemoClaw.`,
        "Treat this as a sandboxed environment, not unrestricted host access.",
        summary.sandboxPhase ? `Current sandbox phase: ${summary.sandboxPhase}.` : null,
        "Network policy:",
        ...summary.networkLines.map((line) => `- ${line}`),
        "Filesystem policy:",
        ...summary.filesystemLines.map((line) => `- ${line}`),
        "Behavior:",
        "- do not claim unrestricted internet access",
        "- if access is blocked, say it is blocked and ask the operator to adjust policy or approve it in OpenShell",
        "</nemoclaw-runtime>",
    ].filter((line) => Boolean(line));
    return lines.join("\n");
}
function buildRuntimeDeltaText(previous, nextFingerprint, nextSummary) {
    const lines = [
        "<nemoclaw-runtime-update>",
        "OpenShell sandbox state changed since your earlier NemoClaw context.",
    ];
    if (previous.summary.sandboxPhase !== nextFingerprint.sandboxPhase) {
        lines.push(`- Sandbox phase: ${previous.summary.sandboxPhase ?? "unknown"} -> ${nextFingerprint.sandboxPhase ?? "unknown"}`);
    }
    lines.push("- Re-check the current restrictions before claiming what is allowed.");
    lines.push("- Active network policy now:");
    lines.push(...nextSummary.networkLines.map((line) => `  - ${line}`));
    lines.push("</nemoclaw-runtime-update>");
    return lines.join("\n");
}
async function getCachedRuntimeInjection(pluginConfig, hookContext) {
    const fingerprint = await getRuntimeFingerprint(pluginConfig);
    const fingerprintKey = serializeFingerprint(fingerprint);
    const cacheKey = getSessionCacheKey(pluginConfig, hookContext);
    const cached = sessionRuntimeCache.get(cacheKey);
    if (cached && cached.fingerprintKey === fingerprintKey) {
        return null;
    }
    const summary = await getRuntimeSummaryFromFingerprint(fingerprint);
    sessionRuntimeCache.set(cacheKey, { fingerprintKey, summary });
    if (!cached) {
        return buildRuntimeContextText(summary);
    }
    return buildRuntimeDeltaText(cached, fingerprint, summary);
}
async function getRuntimeSummary(pluginConfig) {
    const fingerprint = await getRuntimeFingerprint(pluginConfig);
    return getRuntimeSummaryFromFingerprint(fingerprint);
}
function registerRuntimeContext(api, pluginConfig) {
    api.on("before_agent_start", async (_event, hookContext) => {
        try {
            const prependContext = await getCachedRuntimeInjection(pluginConfig, hookContext);
            if (!prependContext) {
                return undefined;
            }
            return {
                prependContext,
            };
        }
        catch (err) {
            api.logger.warn(`nemoclaw runtime context injection failed: ${String(err)}`);
            return {
                prependContext: [
                    "<nemoclaw-runtime>",
                    `You are running inside OpenShell sandbox "${getSandboxName(pluginConfig)}" via NemoClaw.`,
                    "Treat network access as deny-by-default and report proxy 403 responses as policy blocks.",
                    "Do not claim unrestricted host or internet access.",
                    "</nemoclaw-runtime>",
                ].join("\n"),
            };
        }
    });
}
//# sourceMappingURL=runtime-context.js.map