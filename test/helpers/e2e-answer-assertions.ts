// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function compactAnswerText(text: string): string {
  return text.replace(/\s+/g, "");
}

export function containsAnswer(text: string, answer: string): boolean {
  const trimmed = text.trim();
  if (/[{[]/u.test(trimmed)) return false;
  return compactAnswerText(trimmed).includes(compactAnswerText(answer));
}

export function containsReplyTokenAllowingWhitespace(text: string, replyToken: string): boolean {
  return compactAnswerText(text).includes(compactAnswerText(replyToken));
}
