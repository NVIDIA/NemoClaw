---
name: "__SKILL_ID__"
description: "__SKILL_DESCRIPTION__"
---

# E2E smoke skill fixture

## Purpose

This fixture verifies that skill content can be written into the target sandbox
and queried back immediately.

## Use when

The user asks to verify the **skill-smoke-fixture** / **E2E smoke skill** / **read/write validation** skill,
or asks for the **agent verification token** from this skill.

## Usage

- Treat this as an E2E smoke-test fixture.
- Do not rely on it for production behavior.

## Expected Output

When queried, this file should exist and include this section.

## Agent verification

When this skill is applied, if the user asks for the verification token, respond with **only** this exact string (no quotes, no extra words):

`SKILL_SMOKE_VERIFY_K9X2`
