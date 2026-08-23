// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { ADVISOR_INTERESTS, type AdvisorInterest } from "./specialists.mts";

export const SPECIALIST_SESSION_DIRECTORY = ".pr-review-advisor-sessions";

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
    let header: Record<string, unknown>;
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) {
        throw new Error(`Specialist session must be a regular file: ${interest}`);
      }
      if (stat.size === 0) throw new Error(`Specialist session is empty: ${interest}`);
      const buffer = Buffer.alloc(Math.min(stat.size, 4096));
      fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      header = JSON.parse(buffer.toString("utf8").split(/\r?\n/u, 1)[0]!) as Record<
        string,
        unknown
      >;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Specialist session ${interest} has no valid Pi session header`);
      }
      throw error;
    } finally {
      fs.closeSync(descriptor);
    }
    if (header.type !== "session" || typeof header.id !== "string") {
      throw new Error(`Specialist session ${interest} has no valid Pi session header`);
    }
    files[interest] = file;
    available.push(interest);
  }
  return { directory: realDirectory, files, available, missing };
}
