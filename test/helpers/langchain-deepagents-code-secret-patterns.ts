// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type CanonicalSecretPatternGroup = "token" | "context" | "block";

export interface CanonicalSecretPositiveVector {
  label: string;
  value: string;
  patternGroup: CanonicalSecretPatternGroup;
  patternIndex: number;
}

const ECMASCRIPT_WHITESPACE_VECTORS = [
  ["tab", "\t"],
  ["line_feed", "\n"],
  ["vertical_tab", "\v"],
  ["form_feed", "\f"],
  ["carriage_return", "\r"],
  ["space", " "],
  ["no_break_space", "\u00a0"],
  ["ogham_space", "\u1680"],
  ["en_quad", "\u2000"],
  ["em_quad", "\u2001"],
  ["en_space", "\u2002"],
  ["em_space", "\u2003"],
  ["three_per_em_space", "\u2004"],
  ["four_per_em_space", "\u2005"],
  ["six_per_em_space", "\u2006"],
  ["figure_space", "\u2007"],
  ["punctuation_space", "\u2008"],
  ["thin_space", "\u2009"],
  ["hair_space", "\u200a"],
  ["line_separator", "\u2028"],
  ["paragraph_separator", "\u2029"],
  ["narrow_no_break_space", "\u202f"],
  ["medium_mathematical_space", "\u205f"],
  ["ideographic_space", "\u3000"],
  ["byte_order_mark", "\ufeff"],
] as const;

/**
 * Positive examples shared by the TypeScript, Bash, and Python parity gates.
 * Each entry names the canonical TypeScript pattern that owns its behavior.
 */
export const CANONICAL_SECRET_POSITIVE_VECTORS: readonly CanonicalSecretPositiveVector[] = [
  { label: "nvapi", value: "nvapi-abcdefghijklmnop", patternGroup: "token", patternIndex: 0 },
  { label: "nvcf", value: "nvcf-abcdefghijklmnopq", patternGroup: "token", patternIndex: 1 },
  { label: "ghp", value: "ghp_abcdefghijklmnopqr", patternGroup: "token", patternIndex: 2 },
  {
    label: "github_pat",
    value: "github_pat_abcdefghijklmnopqrstuvwxyz0123",
    patternGroup: "token",
    patternIndex: 3,
  },
  { label: "sk_proj", value: "sk-proj-abcdefghij", patternGroup: "token", patternIndex: 4 },
  { label: "sk_ant", value: "sk-ant-abcdefghijk", patternGroup: "token", patternIndex: 5 },
  {
    label: "sk",
    value: "sk-abcdefghijklmnopqrstuvwx",
    patternGroup: "token",
    patternIndex: 6,
  },
  {
    label: "xoxb",
    value: ["xoxb", "1234567890"].join("-"),
    patternGroup: "token",
    patternIndex: 7,
  },
  {
    label: "xoxp",
    value: ["xoxp", "1234567890"].join("-"),
    patternGroup: "token",
    patternIndex: 7,
  },
  {
    label: "xoxa",
    value: ["xoxa", "1234567890"].join("-"),
    patternGroup: "token",
    patternIndex: 7,
  },
  {
    label: "xoxs",
    value: ["xoxs", "1234567890"].join("-"),
    patternGroup: "token",
    patternIndex: 7,
  },
  {
    label: "xapp",
    value: ["xapp", "1", "A1B2C3", "12345", "abcde"].join("-"),
    patternGroup: "token",
    patternIndex: 7,
  },
  {
    label: "akia",
    value: ["AKIA", "ABCDEFGHIJKLMNOP"].join(""),
    patternGroup: "token",
    patternIndex: 8,
  },
  {
    label: "asia",
    value: ["ASIA", "ABCDEFGHIJKLMNOP"].join(""),
    patternGroup: "token",
    patternIndex: 8,
  },
  { label: "hf", value: "hf_abcdefghijklmnopq", patternGroup: "token", patternIndex: 9 },
  {
    label: "glpat",
    value: "glpat-abcdefghijklmn",
    patternGroup: "token",
    patternIndex: 10,
  },
  { label: "gsk", value: "gsk_abcdefghijklmnop", patternGroup: "token", patternIndex: 11 },
  {
    label: "pypi",
    value: "pypi-abcdefghijklmnop",
    patternGroup: "token",
    patternIndex: 12,
  },
  {
    label: "telegram_bot",
    value: "bot123456789:AbcDefGhiJklMnoPqrStuVwxYz012345678",
    patternGroup: "token",
    patternIndex: 13,
  },
  {
    label: "telegram",
    value: "123456789:AbcDefGhiJklMnoPqrStuVwxYz012345678",
    patternGroup: "token",
    patternIndex: 14,
  },
  {
    label: "discord",
    value: "ABCDEFGHIJKLMNOPQRSTUVWX.Abcdef.ZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
    patternGroup: "token",
    patternIndex: 15,
  },
  {
    label: "tavily",
    value: "tvly-abcdefghijklmnop",
    patternGroup: "token",
    patternIndex: 16,
  },
  {
    label: "langsmith_pt",
    value: `lsv2_pt_${"a".repeat(36)}_${"b".repeat(10)}`,
    patternGroup: "token",
    patternIndex: 17,
  },
  {
    label: "langsmith_sk",
    value: `lsv2_sk_${"a".repeat(36)}_${"b".repeat(10)}`,
    patternGroup: "token",
    patternIndex: 17,
  },
  ...ECMASCRIPT_WHITESPACE_VECTORS.map(([label, whitespace]) => ({
    label: `bearer_${label}`,
    value: `bEaReR${whitespace}opaqueRandomSessionTokenZ1234567890`,
    patternGroup: "context" as const,
    patternIndex: 0,
  })),
  {
    label: "credential_context",
    value: "API_KEY=opaqueCredentialPayloadZ1234567890",
    patternGroup: "context",
    patternIndex: 1,
  },
  {
    label: "credential_json_context",
    value: '{"API_KEY":"opaqueCredentialPayloadZ1234567890"}',
    patternGroup: "context",
    patternIndex: 1,
  },
  {
    label: "credential_spaced_context",
    value: "API_KEY = opaqueCredentialPayloadZ1234567890",
    patternGroup: "context",
    patternIndex: 1,
  },
  {
    label: "credential_punctuation_leading",
    value: "API_KEY=,OpaqueCredentialPayloadZ1234567890",
    patternGroup: "context",
    patternIndex: 1,
  },
  {
    label: "hyphenated_api_key_context",
    value: "api-key=opaqueCredentialPayloadZ1234567890",
    patternGroup: "context",
    patternIndex: 1,
  },
  {
    label: "mixed_case_x_api_key_context",
    value: "X-Api-Key=opaqueCredentialPayloadZ1234567890",
    patternGroup: "context",
    patternIndex: 1,
  },
  {
    label: "python_extra_next_line_context",
    value: "API_KEY=12345\u00856789012345",
    patternGroup: "context",
    patternIndex: 1,
  },
  {
    label: "python_extra_file_separator_context",
    value: "API_KEY=12345\u001c6789012345",
    patternGroup: "context",
    patternIndex: 1,
  },
  {
    label: "uppercase_key_context",
    value: "KEY=opaqueCredentialPayloadZ1234567890",
    patternGroup: "context",
    patternIndex: 3,
  },
  {
    label: "pass_context",
    value: "CUSTOM_PASS=opaqueCredentialPayloadZ1234567890",
    patternGroup: "context",
    patternIndex: 1,
  },
  {
    label: "passwd_context",
    value: "CUSTOM_PASSWD=opaqueCredentialPayloadZ1234567890",
    patternGroup: "context",
    patternIndex: 1,
  },
  {
    label: "pass_punctuation_leading",
    value: "CUSTOM_PASS=!OpaquePassword123",
    patternGroup: "context",
    patternIndex: 1,
  },
  {
    label: "pass_punctuation_tail",
    value: "CUSTOM_PASS=abcdefghij!tail-secret",
    patternGroup: "context",
    patternIndex: 1,
  },
  {
    label: "pass_json_context",
    value: '{"PASS":"opaqueCredentialPayloadZ1234567890"}',
    patternGroup: "context",
    patternIndex: 1,
  },
  {
    label: "pass_spaced_context",
    value: "PASS = opaqueCredentialPayloadZ1234567890",
    patternGroup: "context",
    patternIndex: 1,
  },
  {
    label: "pass_colon_context",
    value: "PASS: opaqueCredentialPayloadZ1234567890",
    patternGroup: "context",
    patternIndex: 1,
  },
  {
    label: "client_secret_context",
    value: "clientSecret=opaqueCredentialPayloadZ1234567890",
    patternGroup: "context",
    patternIndex: 2,
  },
  {
    label: "github_token_context",
    value: "githubToken=opaqueCredentialPayloadZ1234567890",
    patternGroup: "context",
    patternIndex: 2,
  },
  {
    label: "webhook_secret_context",
    value: "webhookSecret=opaqueCredentialPayloadZ1234567890",
    patternGroup: "context",
    patternIndex: 2,
  },
  {
    label: "database_credential_context",
    value: "databaseCredential=opaqueCredentialPayloadZ1234567890",
    patternGroup: "context",
    patternIndex: 2,
  },
  {
    label: "custom_pass_context",
    value: "customPass=opaqueCredentialPayloadZ1234567890",
    patternGroup: "context",
    patternIndex: 2,
  },
  {
    label: "acronym_pass_context",
    value: "DBPass=opaqueCredentialPayloadZ1234567890",
    patternGroup: "context",
    patternIndex: 2,
  },
  {
    label: "camel_api_key_context",
    value: "apiKey=opaqueCredentialPayloadZ1234567890",
    patternGroup: "context",
    patternIndex: 2,
  },
  {
    label: "private_key_block",
    value: "-----BEGIN TEST PRIVATE KEY-----\nopaque-test-body\n-----END TEST PRIVATE KEY-----",
    patternGroup: "block",
    patternIndex: 0,
  },
];
