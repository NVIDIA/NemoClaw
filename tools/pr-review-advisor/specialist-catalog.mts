// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SPECIALIST_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const MAX_SPECIALIST_NAME_LENGTH = 48;
const MARKDOWN_SPDX_HEADER = `<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->`;
const DEFAULT_SPECIALIST_DIRECTORY = fileURLToPath(new URL("specialists", import.meta.url));

export type AdvisorInterest = string;

export type AdvisorSpecialist = Readonly<{
  interest: AdvisorInterest;
  label: string;
  prompt: string;
  sandboxName: string;
}>;

function specialistLabel(interest: string): string {
  return interest
    .split("-")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" / ");
}

function specialistSandboxName(interest: string): string {
  const stem = interest.replaceAll("-", "").slice(0, 4);
  const suffix = createHash("sha256").update(interest).digest("hex").slice(0, 4);
  return `pr-adv-sp-${stem}-${suffix}`;
}

export function readAdvisorSpecialists(
  directory = DEFAULT_SPECIALIST_DIRECTORY,
): readonly AdvisorSpecialist[] {
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Specialist prompt input must be a regular directory");
  }

  const specialists = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const interest = entry.name.slice(0, -3);
      if (
        interest.length > MAX_SPECIALIST_NAME_LENGTH ||
        !SPECIALIST_NAME.test(interest) ||
        !entry.isFile() ||
        entry.isSymbolicLink()
      ) {
        throw new Error(`Invalid specialist prompt file: ${entry.name}`);
      }
      const file = path.join(directory, entry.name);
      const content = fs.readFileSync(file, "utf8").trim();
      const markdown = content.startsWith(MARKDOWN_SPDX_HEADER)
        ? content.slice(MARKDOWN_SPDX_HEADER.length).trim()
        : content;
      const [heading, ...promptLines] = markdown.split("\n");
      const label = heading?.startsWith("# ") ? heading.slice(2).trim() : specialistLabel(interest);
      const prompt = heading?.startsWith("# ") ? promptLines.join("\n").trim() : markdown;
      if (!label) throw new Error(`Specialist label is empty: ${interest}`);
      if (!prompt) throw new Error(`Specialist prompt is empty: ${interest}`);
      return {
        interest,
        label,
        prompt,
        sandboxName: specialistSandboxName(interest),
      };
    });

  if (specialists.length === 0) throw new Error("No specialist prompt files found");
  const sandboxNames = specialists.map(({ sandboxName }) => sandboxName);
  if (new Set(sandboxNames).size !== sandboxNames.length) {
    throw new Error("Specialist prompt names must produce unique sandbox names");
  }
  return specialists;
}

export const ADVISOR_SPECIALISTS = readAdvisorSpecialists();
export const ADVISOR_INTERESTS = ADVISOR_SPECIALISTS.map(({ interest }) => interest);

export function parseAdvisorInterest(value: string): AdvisorInterest {
  if (ADVISOR_INTERESTS.includes(value)) return value;
  throw new Error(`interest must be one of: ${ADVISOR_INTERESTS.join(", ")}`);
}
