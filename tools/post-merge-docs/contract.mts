// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const ROLLING_BRANCH = "automation/post-merge-docs";
export const ROLLING_TITLE = "docs: catch up merged changes";
export const MANAGED_START = "<!-- nemoclaw-post-merge-docs:start -->";
export const MANAGED_END = "<!-- nemoclaw-post-merge-docs:end -->";
export const BOT_LOGIN = "github-actions[bot]";
export const BOT_SIGN_OFF =
  "Signed-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>";
export const PR_BODY_MAX_BYTES = 60_000;

export function retiredEmptyMarker(mainSha: string, headSha: string): string {
  return `<!-- nemoclaw-post-merge-docs:retired-empty main=${mainSha} head=${headSha} -->`;
}

export function retirementPendingMarker(mainSha: string, headSha: string): string {
  return `<!-- nemoclaw-post-merge-docs:retirement-pending main=${mainSha} head=${headSha} -->`;
}

export function parseRetiredEmptyMarker(body: string): { mainSha: string; headSha: string } | null {
  const matches = [
    ...body.matchAll(
      /<!-- nemoclaw-post-merge-docs:retired-empty main=([0-9a-f]{40}) head=([0-9a-f]{40}) -->/gu,
    ),
  ];
  if (matches.length !== 1) return null;
  const markerIndex = matches[0].index ?? -1;
  const start = body.indexOf(MANAGED_START);
  const end = body.indexOf(MANAGED_END);
  if (markerIndex <= start || markerIndex >= end) return null;
  return { mainSha: matches[0][1], headSha: matches[0][2] };
}

export function parseRetirementPendingMarker(
  body: string,
): { mainSha: string; headSha: string } | null {
  const matches = [
    ...body.matchAll(
      /<!-- nemoclaw-post-merge-docs:retirement-pending main=([0-9a-f]{40}) head=([0-9a-f]{40}) -->/gu,
    ),
  ];
  if (matches.length !== 1) return null;
  const markerIndex = matches[0].index ?? -1;
  const start = body.indexOf(MANAGED_START);
  const end = body.indexOf(MANAGED_END);
  if (markerIndex <= start || markerIndex >= end) return null;
  return { mainSha: matches[0][1], headSha: matches[0][2] };
}

export function countMarker(body: string, marker: string): number {
  return body.split(marker).length - 1;
}

export function validateManagedBlock(body: string): void {
  if (Buffer.byteLength(body, "utf8") > PR_BODY_MAX_BYTES) {
    throw new Error(`rolling documentation PR body exceeds ${PR_BODY_MAX_BYTES} bytes`);
  }
  if (
    countMarker(body, MANAGED_START) !== 1 ||
    countMarker(body, MANAGED_END) !== 1 ||
    body.indexOf(MANAGED_START) > body.indexOf(MANAGED_END)
  ) {
    throw new Error("rolling documentation PR body must contain one ordered managed block");
  }
}
