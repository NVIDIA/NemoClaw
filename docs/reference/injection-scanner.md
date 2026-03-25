---
title:
  page: "NemoClaw Injection Scanner — Detect Prompt Injection in Agent Tool Calls"
  nav: "Injection Scanner"
description: "Reference for the prompt injection scanner module that detects role overrides, instruction injection, tool manipulation, and data exfiltration patterns."
keywords: ["nemoclaw injection scanner", "prompt injection detection", "agent security"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "security", "injection", "scanning"]
content:
  type: reference
  difficulty: intermediate
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Injection Scanner

The injection scanner detects prompt injection patterns in agent tool inputs and outputs.
It applies text normalization and pattern matching to identify attempts to override system prompts, inject instructions, manipulate tools, or exfiltrate data.

## How It Works

The scanner runs each input through three preprocessing stages before pattern matching.

1. **NFKC unicode normalization** converts visually similar characters (such as fullwidth Latin letters) to their standard ASCII equivalents.
2. **Zero-width character stripping** removes invisible characters (U+200B, U+200C, U+200D, U+FEFF) that attackers insert to break pattern matching.
3. **Control character stripping** removes non-printable characters below U+0020, except newlines, carriage returns, and tabs.

After normalization, the scanner checks the text against 15 regex patterns.
If the input looks like valid base64 (between 20 and 100,000 characters, valid alphabet), the scanner decodes it and rescans the result.

## Pattern Categories

The scanner includes 15 patterns organized into four categories.

### Role and system prompt overrides

| Pattern | Severity | What it detects |
|---|---|---|
| `role_override_you_are` | high | "you are now" phrases that attempt to reassign the agent's role |
| `role_override_ignore` | high | "ignore previous instructions" phrases |
| `role_override_system_tag` | high | `<\|im_start\|>system` tags used in chat model formats |
| `role_override_system_colon` | medium | `system:` prefix at the start of a line |

### Instruction injection

| Pattern | Severity | What it detects |
|---|---|---|
| `instruction_important` | medium | `IMPORTANT:` followed by an uppercase directive |
| `instruction_critical` | medium | `CRITICAL:` followed by an uppercase directive |
| `instruction_override` | high | `OVERRIDE:` prefix |
| `instruction_inst_tag` | high | `[INST]` tags used in Llama-style prompt formats |
| `instruction_sys_tag` | high | `<<SYS>>` tags used in Llama-style prompt formats |

### Tool manipulation

| Pattern | Severity | What it detects |
|---|---|---|
| `tool_manipulation_call` | medium | "call tool", "invoke tool", or "use tool" phrases |
| `tool_manipulation_function` | medium | "use function" phrases |
| `tool_manipulation_execute` | medium | "execute command" phrases |

### Data exfiltration

| Pattern | Severity | What it detects |
|---|---|---|
| `exfil_base64_encode` | medium | "base64 encode" phrases suggesting data encoding for exfiltration |
| `exfil_send_to` | low | "send to", "post to", or "upload to" phrases |
| `exfil_post_secret` | high | HTTP POST combined with secret, token, key, password, or credential |

## Severity Levels

Each finding has a severity level that indicates how likely the pattern represents an actual attack.

| Level | Count | Meaning |
|---|---|---|
| high | 7 | Direct role overrides, instruction override tags, credential exfiltration via POST |
| medium | 7 | Softer instruction patterns, tool manipulation keywords, base64 encoding references |
| low | 1 | Generic data transfer phrases that may be benign |

## API

The scanner exports the following functions and types from `nemoclaw/src/security/injection-scanner.ts`.

### `scanFields(fields: Record<string, string>): Finding[]`

Scan named string fields for injection patterns.
Returns an array of findings, one per pattern match per field.
Returns an empty array if no patterns match.

```typescript
import { scanFields } from "./security/injection-scanner.js";

const findings = scanFields({
  stdin: userInput,
  stdout: toolOutput,
});

if (findings.length > 0) {
  console.log("Injection patterns detected:", findings);
}
```

### `hasHighSeverity(findings: Finding[]): boolean`

Returns `true` if any finding in the array has `"high"` severity.

### `maxSeverity(findings: Finding[]): Severity | ""`

Returns the highest severity level present in the findings array.
Returns an empty string if the array is empty.

### `Finding`

```typescript
interface Finding {
  field: string;    // which field triggered the match
  pattern: string;  // pattern name (e.g. "role_override_you_are")
  severity: Severity;
  snippet: string;  // truncated match context (max 200 chars)
}
```

### `Severity`

```typescript
type Severity = "high" | "medium" | "low";
```

## Next Steps

- Review the sandbox policy configuration in {doc}`/reference/network-policies` to understand how network-level controls complement application-layer scanning.
- See {doc}`/reference/architecture` for how the scanner fits into the NemoClaw plugin structure.
