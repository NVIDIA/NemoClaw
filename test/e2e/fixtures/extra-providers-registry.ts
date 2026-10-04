// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REGISTRY_FILE = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");

export function readRegistry(): { extraProviders?: unknown; [key: string]: unknown } {
  return fs.existsSync(REGISTRY_FILE)
    ? (JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as {
        extraProviders?: unknown;
        [key: string]: unknown;
      })
    : { sandboxes: {}, defaultSandbox: null };
}

export function readExtraProviders(): string[] {
  const value = readRegistry().extraProviders;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function updateExtraProviders(update: (providers: Set<string>) => void): string[] {
  const registry = readRegistry();
  const providers = new Set(readExtraProviders());
  update(providers);
  const sorted = [...providers].sort();
  const nextRegistry = Object.assign(
    Object.fromEntries(Object.entries(registry).filter(([key]) => key !== "extraProviders")),
    sorted.length > 0 ? { extraProviders: sorted } : {},
  );
  fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, `${JSON.stringify(nextRegistry, null, 2)}\n`, "utf8");
  return sorted;
}
