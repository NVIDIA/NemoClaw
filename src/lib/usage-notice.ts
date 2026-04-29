// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import noticeConfig from "../../bin/lib/usage-notice.json";

export const NOTICE_ACCEPT_FLAG = "--yes-i-accept-third-party-software";
export const NOTICE_ACCEPT_ENV = "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE";
export const NOTICE_CONFIG_FILE = path.join(
  __dirname,
  "..",
  "..",
  "bin",
  "lib",
  "usage-notice.json",
);

const OSC8_OPEN = "\u001B]8;;";
const OSC8_CLOSE = "\u001B]8;;\u001B\\";
const OSC8_TERM = "\u001B\\";

type NoticeLink = {
  label?: string;
  url?: string;
};

type NoticeConfig = {
  version: string;
  title: string;
  referenceUrl?: string;
  body?: string[];
  links?: NoticeLink[];
  interactivePrompt: string;
};

type PromptFn = (question: string) => Promise<string>;
type WriteLineFn = (line: string) => void;

type EnsureUsageNoticeConsentOptions = {
  nonInteractive?: boolean;
  acceptedByFlag?: boolean;
  promptFn?: PromptFn | null;
  writeLine?: WriteLineFn;
};

type NoticeConfigSource = {
  version?: string;
  title?: string;
  referenceUrl?: string;
  body?: string[];
  links?: NoticeLink[];
  interactivePrompt?: string;
};

function parseJson<T>(text: string): T {
  return JSON.parse(text);
}

// Reflect.get is used throughout the codebase as a type-safe alternative to
// direct property access on loosely-typed objects.  Unlike an `as Record<…>`
// cast it never widens the target type and avoids eslint no-unsafe-member-access
// warnings.  See also: deploy.ts, onboard.ts, ws-proxy-fix.ts.
function readStringProperty(value: object | null, key: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const property = Reflect.get(value, key);
  return typeof property === "string" ? property : undefined;
}

function readStringArrayProperty(value: object | null, key: string): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const property = Reflect.get(value, key);
  return Array.isArray(property)
    ? property.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function readLinksProperty(value: object | null, key: string): NoticeLink[] | undefined {
  if (!value) {
    return undefined;
  }
  const property = Reflect.get(value, key);
  if (!Array.isArray(property)) {
    return undefined;
  }
  return property.map((entry) => ({
    label: readStringProperty(typeof entry === "object" && entry !== null ? entry : null, "label"),
    url: readStringProperty(typeof entry === "object" && entry !== null ? entry : null, "url"),
  }));
}

export function getUsageNoticeStateFile(): string {
  return path.join(process.env.HOME || os.homedir(), ".nemoclaw", "usage-notice.json");
}

export function loadUsageNoticeConfig(): NoticeConfig {
  const rawConfig: NoticeConfigSource = noticeConfig;
  return {
    version: rawConfig.version || "",
    title: rawConfig.title || "",
    referenceUrl: rawConfig.referenceUrl,
    body: rawConfig.body,
    links: rawConfig.links,
    interactivePrompt: rawConfig.interactivePrompt || "",
  };
}

export function hasAcceptedUsageNotice(version: string): boolean {
  try {
    const saved = parseJson<{ acceptedVersion?: string }>(
      fs.readFileSync(getUsageNoticeStateFile(), "utf8"),
    );
    return saved.acceptedVersion === version;
  } catch {
    return false;
  }
}

export function saveUsageNoticeAcceptance(version: string): void {
  const stateFile = getUsageNoticeStateFile();
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ acceptedVersion: version, acceptedAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
  fs.chmodSync(stateFile, 0o600);
}

export function supportsTerminalHyperlinks(): boolean {
  const tty = process.stderr?.isTTY || process.stdout?.isTTY;
  if (!tty) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === "dumb") return false;
  return true;
}

export function formatTerminalHyperlink(label: string, url: string): string {
  return `${OSC8_OPEN}${url}${OSC8_TERM}${label}${OSC8_CLOSE}`;
}

export function printUsageNotice(
  config: NoticeConfig = loadUsageNoticeConfig(),
  writeLine: WriteLineFn = console.error,
): void {
  writeLine("");
  writeLine(`  ${config.title}`);
  writeLine("  ──────────────────────────────────────────────────");
  for (const line of config.body || []) {
    const renderedLine =
      /^https?:\/\//.test(line) && supportsTerminalHyperlinks()
        ? formatTerminalHyperlink(line, line)
        : line;
    writeLine(`  ${renderedLine}`);
  }
  for (const link of config.links || []) {
    writeLine("");
    const label =
      supportsTerminalHyperlinks() && link?.url && link?.label
        ? formatTerminalHyperlink(link.label, link.url)
        : link?.label || "";
    if (label) {
      writeLine(`  ${label}`);
    }
    if (link?.url) {
      writeLine(`  ${link.url}`);
    }
  }
  writeLine("");
}

export async function ensureUsageNoticeConsent({
  nonInteractive = false,
  acceptedByFlag = false,
  promptFn = null,
  writeLine = console.error,
}: EnsureUsageNoticeConsentOptions = {}): Promise<boolean> {
  const config = loadUsageNoticeConfig();
  if (hasAcceptedUsageNotice(config.version)) {
    return true;
  }

  printUsageNotice(config, writeLine);

  if (nonInteractive) {
    if (!acceptedByFlag) {
      writeLine(
        `  Non-interactive onboarding requires ${NOTICE_ACCEPT_FLAG} or ${NOTICE_ACCEPT_ENV}=1.`,
      );
      return false;
    }
    writeLine(
      `  [non-interactive] Third-party software notice accepted via ${NOTICE_ACCEPT_FLAG}.`,
    );
    saveUsageNoticeAcceptance(config.version);
    return true;
  }

  if (!process.stdin.isTTY) {
    writeLine(
      `  Interactive onboarding requires a TTY. Re-run in a terminal or use --non-interactive with ${NOTICE_ACCEPT_FLAG}.`,
    );
    return false;
  }

  // credentials is still CJS
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ask = promptFn || require("./credentials").prompt;
  const answer = String(await ask(`  ${config.interactivePrompt}`))
    .trim()
    .toLowerCase();
  if (answer !== "yes") {
    writeLine("  Installation cancelled");
    return false;
  }

  saveUsageNoticeAcceptance(config.version);
  return true;
}

export async function cli(args = process.argv.slice(2)): Promise<void> {
  const acceptedByFlag =
    args.includes(NOTICE_ACCEPT_FLAG) || String(process.env[NOTICE_ACCEPT_ENV] || "") === "1";
  const nonInteractive = args.includes("--non-interactive");
  const ok = await ensureUsageNoticeConsent({
    nonInteractive,
    acceptedByFlag,
    writeLine: console.error,
  });
  process.exit(ok ? 0 : 1);
}
