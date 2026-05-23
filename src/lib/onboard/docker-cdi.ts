// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { dockerInfoFormat } from "../adapters/docker";

export function parseDockerCdiSpecDirs(value: string | null | undefined): string[] {
  const raw = String(value || "").trim();
  if (!raw || raw === "<no value>") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
  } catch {
    return raw
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
}

export function getDockerCdiSpecDirs(): string[] {
  return parseDockerCdiSpecDirs(
    dockerInfoFormat("{{json .CDISpecDirs}}", { ignoreError: true }),
  );
}

function isLikelyNvidiaCdiSpecFile(filePath: string): boolean {
  if (!/\.(json|ya?ml)$/i.test(filePath)) return false;
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }
  return /nvidia\.com\/gpu|nvidia-container|libcuda|cuda/i.test(content);
}

export function findReadableNvidiaCdiSpecFiles(dirs: string[]): string[] {
  const specs: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry);
      if (isLikelyNvidiaCdiSpecFile(candidate)) specs.push(candidate);
    }
  }
  return specs.sort();
}
