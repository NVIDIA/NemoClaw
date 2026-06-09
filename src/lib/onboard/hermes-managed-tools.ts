// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HermesAuthMethod } from "../hermes-provider-auth";
import * as hermesProviderAuth from "../hermes-provider-auth";

type PromptFn = (message: string) => Promise<string>;
type RawInput = NodeJS.ReadStream & {
  setRawMode?: (mode: boolean) => void;
  ref?: () => void;
  unref?: () => void;
};

type SelectDeps = {
  prompt: PromptFn;
  note: (message: string) => void;
  isNonInteractive: () => boolean;
  input?: RawInput;
  output?: NodeJS.WriteStream;
};

export const HERMES_TOOL_GATEWAY_PRESETS = [
  {
    name: "nous-web",
    label: "Web search/extract",
    description: "Firecrawl via Nous managed gateway",
    defaultSelected: true,
  },
  {
    name: "nous-image",
    label: "Image generation",
    description: "FAL queue via Nous managed gateway",
    defaultSelected: true,
  },
  {
    name: "nous-audio",
    label: "Audio TTS/STT",
    description: "OpenAI-compatible audio via Nous managed gateway",
    defaultSelected: true,
  },
  {
    name: "nous-browser",
    label: "Cloud browser",
    description: "Browser Use via Nous managed gateway",
    defaultSelected: true,
  },
  {
    name: "nous-code",
    label: "Managed code execution",
    description: "Modal via Nous managed gateway",
    defaultSelected: false,
  },
] as const;

export const HERMES_TOOL_GATEWAY_PRESET_NAMES = new Set<string>(
  HERMES_TOOL_GATEWAY_PRESETS.map((preset) => preset.name),
);

export function parseHermesToolGatewayPresetEnv(raw: string | null | undefined): string[] {
  const values = String(raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const selected: string[] = [];
  for (const value of values) {
    const normalized = value.toLowerCase();
    const name = normalized.startsWith("nous-") ? normalized : `nous-${normalized}`;
    if (!HERMES_TOOL_GATEWAY_PRESET_NAMES.has(name)) {
      console.error(`  Unknown Hermes managed tool gateway: ${value}`);
      console.error(
        `  Valid values: ${HERMES_TOOL_GATEWAY_PRESETS.map((preset) => preset.name).join(", ")}`,
      );
      process.exit(1);
    }
    if (!selected.includes(name)) selected.push(name);
  }
  return selected;
}

export function getRequestedHermesToolGateways(
  env: NodeJS.ProcessEnv = process.env,
): string[] | null {
  const raw = env.NEMOCLAW_HERMES_TOOL_GATEWAYS || env.NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS || "";
  if (!raw) return null;
  return parseHermesToolGatewayPresetEnv(raw);
}

export function hermesToolGatewayLabels(presets: string[] | null | undefined): string {
  if (!Array.isArray(presets) || presets.length === 0) return "none";
  const byName = new Map<string, string>(
    HERMES_TOOL_GATEWAY_PRESETS.map((preset) => [preset.name, preset.label]),
  );
  return presets.map((name) => byName.get(name) || name).join(", ");
}

export function defaultHermesToolGatewaySelection(): string[] {
  return HERMES_TOOL_GATEWAY_PRESETS.filter((preset) => preset.defaultSelected).map(
    (preset) => preset.name,
  );
}

export function allHermesToolGatewayPolicyPresets(): string[] {
  return HERMES_TOOL_GATEWAY_PRESETS.map((preset) => preset.name);
}

function resolveHermesToolGatewaySelection(part: string) {
  const index = /^[0-9]+$/.test(part) ? Number(part) - 1 : -1;
  if (index >= 0) return HERMES_TOOL_GATEWAY_PRESETS[index] || null;
  const normalized = part.toLowerCase();
  return (
    HERMES_TOOL_GATEWAY_PRESETS.find(
      (candidate) =>
        candidate.name === normalized ||
        candidate.name === `nous-${normalized}` ||
        candidate.label.toLowerCase() === normalized,
    ) || null
  );
}

async function selectHermesToolGatewaysInteractive(
  initialSelected: string[],
  deps: SelectDeps,
): Promise<string[]> {
  const selected = new Set(
    initialSelected.filter((name) => HERMES_TOOL_GATEWAY_PRESET_NAMES.has(name)),
  );
  const output = deps.output || process.stdout;
  const input = deps.input || (process.stdin as RawInput);

  if (!input.isTTY || !output.isTTY) {
    console.log("");
    console.log("  Hermes managed Nous tools (OAuth subscription only):");
    HERMES_TOOL_GATEWAY_PRESETS.forEach((preset, index) => {
      const marker = selected.has(preset.name) ? "[✓]" : "[ ]";
      console.log(`    ${index + 1}) ${marker} ${preset.label} — ${preset.description}`);
    });
    console.log("");
    console.log("  Enter comma-separated numbers/names, Enter for current selection, or 'none'.");
    const answer = (await deps.prompt("  Managed tools: ")).trim();
    if (!answer) return [...selected];
    if (/^(none|no|skip)$/i.test(answer)) return [];

    const resolved: string[] = [];
    for (const part of answer
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)) {
      const preset = resolveHermesToolGatewaySelection(part);
      if (!preset) {
        console.error(`  Unknown managed tool selection: ${part}`);
        process.exit(1);
      }
      if (!resolved.includes(preset.name)) resolved.push(preset.name);
    }
    return resolved;
  }

  const linesAbovePrompt = HERMES_TOOL_GATEWAY_PRESETS.length + 3;
  let firstDraw = true;
  const showList = () => {
    if (!firstDraw) {
      output.write(`\r\x1b[${linesAbovePrompt}A\x1b[J`);
    }
    firstDraw = false;
    output.write("\n");
    output.write("  Hermes managed Nous tools (OAuth subscription only):\n");
    HERMES_TOOL_GATEWAY_PRESETS.forEach((preset, index) => {
      const marker = selected.has(preset.name) ? "[✓]" : "[ ]";
      output.write(`    [${index + 1}] ${marker} ${preset.label} — ${preset.description}\n`);
    });
    output.write("\n");
    output.write(
      `  Press 1-${HERMES_TOOL_GATEWAY_PRESETS.length} to toggle, a for all/none, Enter when done: `,
    );
  };

  showList();

  await new Promise<void>((resolve, reject) => {
    let rawModeEnabled = false;
    let finished = false;

    function cleanup() {
      input.removeListener("data", onData);
      if (rawModeEnabled && typeof input.setRawMode === "function") {
        input.setRawMode(false);
      }
      if (typeof input.pause === "function") input.pause();
      if (typeof input.unref === "function") input.unref();
    }

    function finish(): void {
      if (finished) return;
      finished = true;
      cleanup();
      output.write("\n");
      resolve();
    }

    function toggleAll(): void {
      if (selected.size === HERMES_TOOL_GATEWAY_PRESETS.length) selected.clear();
      else for (const preset of HERMES_TOOL_GATEWAY_PRESETS) selected.add(preset.name);
    }

    function onData(chunk: Buffer | string): void {
      const text = chunk.toString("utf8");
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === "\u0003") {
          cleanup();
          reject(Object.assign(new Error("Prompt interrupted"), { code: "SIGINT" }));
          process.kill(process.pid, "SIGINT");
          return;
        }
        if (ch === "\r" || ch === "\n") {
          finish();
          return;
        }
        if (ch === "a" || ch === "A") {
          toggleAll();
          showList();
          continue;
        }
        const num = Number.parseInt(ch, 10);
        if (num >= 1 && num <= HERMES_TOOL_GATEWAY_PRESETS.length) {
          const preset = HERMES_TOOL_GATEWAY_PRESETS[num - 1];
          if (selected.has(preset.name)) selected.delete(preset.name);
          else selected.add(preset.name);
          showList();
        }
      }
    }

    if (typeof input.ref === "function") input.ref();
    input.setEncoding("utf8");
    if (typeof input.resume === "function") input.resume();
    if (typeof input.setRawMode === "function") {
      input.setRawMode(true);
      rawModeEnabled = true;
    }
    input.on("data", onData);
  });

  return [...selected];
}

export function normalizeHermesToolGatewaySelections(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const selected = new Set<string>();
  for (const preset of value) {
    if (typeof preset === "string" && HERMES_TOOL_GATEWAY_PRESET_NAMES.has(preset)) {
      selected.add(preset);
    }
  }
  return [...selected].sort();
}

export function stringSetsEqual(
  a: string[] | null | undefined,
  b: string[] | null | undefined,
): boolean {
  const left = new Set(Array.isArray(a) ? a : []);
  const right = new Set(Array.isArray(b) ? b : []);
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

export async function setupHermesToolGateways(
  provider: string | null,
  hermesAuthMethod: HermesAuthMethod | null,
  existing: string[] | null = null,
  deps: SelectDeps,
): Promise<string[]> {
  if (provider !== hermesProviderAuth.HERMES_PROVIDER_NAME) return [];
  if (hermesAuthMethod === "api_key") {
    const requested = getRequestedHermesToolGateways();
    if (requested && requested.length > 0) {
      deps.note(
        "  Hermes managed tool gateways require Nous Portal OAuth/subscription; API-key mode is inference-only.",
      );
    }
    return [];
  }

  const requested = getRequestedHermesToolGateways();
  if (requested) {
    if (requested.length > 0) {
      deps.note(`  [env] Hermes managed tools: ${hermesToolGatewayLabels(requested)}`);
    }
    return requested;
  }
  if (Array.isArray(existing) && existing.length > 0) {
    return existing.filter((name) => HERMES_TOOL_GATEWAY_PRESET_NAMES.has(name));
  }
  if (deps.isNonInteractive()) return [];

  const selected = await selectHermesToolGatewaysInteractive(
    defaultHermesToolGatewaySelection(),
    deps,
  );
  if (selected.length === 0) {
    console.log("  Skipping Hermes managed tools.");
  }
  return selected;
}

export function mergeRequiredHermesToolGatewayPolicyPresets(
  policyPresets: string[] = [],
  hermesToolGateways: string[] | null | undefined = null,
  allowedPresetNames: string[] | Set<string> | null = null,
): string[] {
  const allowed =
    allowedPresetNames instanceof Set
      ? allowedPresetNames
      : Array.isArray(allowedPresetNames)
        ? new Set(allowedPresetNames)
        : null;
  const merged = [...policyPresets];
  const seen = new Set(merged);
  if (!Array.isArray(hermesToolGateways)) return merged;

  for (const presetName of hermesToolGateways) {
    if (!HERMES_TOOL_GATEWAY_PRESET_NAMES.has(presetName)) continue;
    if (allowed && !allowed.has(presetName)) continue;
    if (seen.has(presetName)) continue;
    merged.push(presetName);
    seen.add(presetName);
  }
  return merged;
}
