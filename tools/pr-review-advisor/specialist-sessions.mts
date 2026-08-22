// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { ADVISOR_INTERESTS, type AdvisorInterest } from "./specialists.mts";

export const SPECIALIST_SESSION_DIRECTORY = ".pr-review-advisor-sessions";
export const MAX_SPECIALIST_SESSION_BYTES = 8 * 1024 * 1024;
export const MAX_SPECIALIST_SESSIONS_BYTES = 32 * 1024 * 1024;

export function specialistSessionFileName(interest: AdvisorInterest): string {
  return `pr-review-${interest}-session.jsonl`;
}

export type SpecialistSessionInventory = Readonly<{
  directory: string;
  files: Readonly<Record<AdvisorInterest, string>>;
  totalBytes: number;
}>;

export function validateSpecialistSessionDirectory(directory: string): SpecialistSessionInventory {
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Specialist session input must be a regular directory");
  }
  const realDirectory = fs.realpathSync(directory);
  const expected = new Set(ADVISOR_INTERESTS.map(specialistSessionFileName));
  const entries = fs.readdirSync(directory);
  const unexpected = entries.filter((entry) => !expected.has(entry));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected specialist session input: ${unexpected.sort().join(", ")}`);
  }
  const files = {} as Record<AdvisorInterest, string>;
  let totalBytes = 0;
  for (const interest of ADVISOR_INTERESTS) {
    const name = specialistSessionFileName(interest);
    const file = path.join(directory, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      throw new Error(`Missing specialist session: ${interest}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Specialist session must be a regular file: ${interest}`);
    }
    if (stat.size === 0 || stat.size > MAX_SPECIALIST_SESSION_BYTES) {
      throw new Error(
        `Specialist session ${interest} must be between 1 and ${MAX_SPECIALIST_SESSION_BYTES} bytes`,
      );
    }
    const realFile = fs.realpathSync(file);
    const relative = path.relative(realDirectory, realFile);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Specialist session resolves outside its input directory: ${interest}`);
    }
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
    if (lines.length === 0) throw new Error(`Specialist session is empty: ${interest}`);
    for (const [index, line] of lines.entries()) {
      try {
        JSON.parse(line);
      } catch {
        throw new Error(`Specialist session ${interest} has invalid JSONL at line ${index + 1}`);
      }
    }
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    if (header.type !== "session" || typeof header.id !== "string") {
      throw new Error(`Specialist session ${interest} has no valid Pi session header`);
    }
    totalBytes += stat.size;
    files[interest] = file;
  }
  if (totalBytes > MAX_SPECIALIST_SESSIONS_BYTES) {
    throw new Error(
      `Specialist sessions exceed the ${MAX_SPECIALIST_SESSIONS_BYTES} byte total limit`,
    );
  }
  return { directory: realDirectory, files, totalBytes };
}
