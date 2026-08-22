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

export const REQUIRED_SPECIALIST_INTERESTS = [
  "behavior",
  "trust",
] as const satisfies readonly AdvisorInterest[];

export type SpecialistSessionInventory = Readonly<{
  directory: string;
  files: Readonly<Partial<Record<AdvisorInterest, string>>>;
  available: readonly AdvisorInterest[];
  missing: readonly AdvisorInterest[];
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
  const files: Partial<Record<AdvisorInterest, string>> = {};
  const available: AdvisorInterest[] = [];
  const missing: AdvisorInterest[] = [];
  let totalBytes = 0;
  for (const interest of ADVISOR_INTERESTS) {
    const name = specialistSessionFileName(interest);
    const file = path.join(directory, name);
    let descriptor: number;
    try {
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Specialist session must be a regular file: ${interest}`);
      }
      if (REQUIRED_SPECIALIST_INTERESTS.some((required) => required === interest)) {
        throw new Error(`Missing required specialist session: ${interest}`);
      }
      missing.push(interest);
      continue;
    }
    let stat: fs.Stats;
    let text: string;
    try {
      stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) {
        throw new Error(`Specialist session must be a regular file: ${interest}`);
      }
      if (stat.size === 0 || stat.size > MAX_SPECIALIST_SESSION_BYTES) {
        throw new Error(
          `Specialist session ${interest} must be between 1 and ${MAX_SPECIALIST_SESSION_BYTES} bytes`,
        );
      }
      text = fs.readFileSync(descriptor, "utf8");
    } finally {
      fs.closeSync(descriptor);
    }
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
    available.push(interest);
  }
  if (totalBytes > MAX_SPECIALIST_SESSIONS_BYTES) {
    throw new Error(
      `Specialist sessions exceed the ${MAX_SPECIALIST_SESSIONS_BYTES} byte total limit`,
    );
  }
  return { directory: realDirectory, files, available, missing, totalBytes };
}
