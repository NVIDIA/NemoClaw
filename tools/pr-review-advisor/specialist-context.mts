// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export const SPECIALIST_DIFF_FILE_NAME = "diff.patch";
export const SPECIALIST_FOLLOW_UP_DIFF_FILE_NAME = "follow-up-diff.patch";

function rejectSymbolicLink(target: string, message: string): void {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error(message);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function writeSpecialistPatch(directory: string, fileName: string, diff: string): string {
  rejectSymbolicLink(directory, "Specialist diff directory must not be a symbolic link");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, fileName);
  rejectSymbolicLink(file, "Specialist diff file must not be a symbolic link");
  const descriptor = fs.openSync(
    file,
    fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, diff);
    fs.fchmodSync(descriptor, 0o600);
  } finally {
    fs.closeSync(descriptor);
  }
  return file;
}

export function writeSpecialistDiff(directory: string, diff: string): string {
  return writeSpecialistPatch(directory, SPECIALIST_DIFF_FILE_NAME, diff);
}

export function writeSpecialistFollowUpDiff(directory: string, diff: string): string {
  return writeSpecialistPatch(directory, SPECIALIST_FOLLOW_UP_DIFF_FILE_NAME, diff);
}
