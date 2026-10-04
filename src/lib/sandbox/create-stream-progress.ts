// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type CreatePhase = "pull" | "build" | "upload" | "create" | "ready";

export const BUILD_PROGRESS_PATTERNS: readonly RegExp[] = [
  /^ {2}Building image /,
  /^ {2}Step \d+\/\d+ : /,
  /^#\d+ \[/,
  /^#\d+ (DONE|CACHED)\b/,
];

export const UPLOAD_PROGRESS_PATTERNS: readonly RegExp[] = [
  /^ {2}Pushing image /,
  /^\s*\[progress\]/,
  /^\s*(?:✓\s*)?Image .*available in the gateway/,
];

// Pull-phase indicators. Detect classic Docker pull output (`<tag>: Pulling
// from <ref>`, `<id>: Pulling fs layer / Downloading / Extracting / Pull
// complete`, `Status: Downloaded`, `Digest:`) plus BuildKit pull progress
// (`#N resolve <ref>`, `#N sha256:<id> <size> / <total>`). The tag prefix
// regex uses [^:\s]+ so non-lowercase tags (`v1.2.3`, `cuda-12.5`, `12.4`)
// also match. See #1829.
export const PULL_PROGRESS_PATTERNS: readonly RegExp[] = [
  /^\s*(?:[^:\s]+:\s+)?Pulling from \S+/,
  /^\s*[a-f0-9]{6,}: (?:Pulling fs layer|Waiting|Downloading|Extracting|Pull complete|Verifying Checksum|Download complete)\b/,
  /^\s*Status: (?:Downloaded|Image is up to date)/,
  /^\s*Digest: sha256:[a-f0-9]{8,}/,
  /^\s*#\d+\s+(?:resolve\s+\S+|sha256:[a-f0-9]+\s+[\d.]+\s*(?:B|KB|MB|GB)\s*\/)/,
];

export const VISIBLE_PROGRESS_PATTERNS: readonly RegExp[] = [
  ...BUILD_PROGRESS_PATTERNS,
  /^ {2}Context: /,
  /^ {2}Gateway: /,
  /^Successfully built /,
  /^Successfully tagged /,
  /^ {2}Built image /,
  ...UPLOAD_PROGRESS_PATTERNS,
  ...PULL_PROGRESS_PATTERNS,
  /^Created sandbox: /,
  /^Creating sandbox/i,
  /^Starting sandbox/i,
  /^✓ /,
];

export function matchesAny(line: string, patterns: readonly RegExp[]) {
  return patterns.some((pattern) => pattern.test(line));
}
