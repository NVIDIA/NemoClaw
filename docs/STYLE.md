<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Documentation Style and Structure

## Format

- Fern pages use MDX with YAML frontmatter.
- Use flat `title` and `description` fields. Add `sidebar-title`, `keywords`, and `position` when the page needs them.
- Do not duplicate the page title as a body H1 in MDX pages because Fern renders the title from frontmatter.
- Include the SPDX license header in MDX frontmatter as comments:

```yaml
---
# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
title: "NemoClaw Page Title with Context"
sidebar-title: "Short Nav Title"
description: "One-sentence summary for readers, SEO, and doc search snippets."
keywords: "primary keyword, secondary keyword phrase"
position: 1
---
```

When the page intentionally applies to fewer than OpenClaw, Hermes, and Deep Agents, or when it appears in the Pi guide, add the exact subset to frontmatter:

```yaml
agent-variants: ["openclaw", "hermes"]
```

## Page Structure

1. Start MDX pages with a one- or two-sentence introduction stating what the page covers.
2. Organize sections by task or concept, using H2 and H3. Start each section with an introductory sentence that orients the reader.
3. Use Fern components like `<Note>`, `<Tip>`, `<Warning>`, `<Cards>`, and `<Card>` for callouts and landing-page navigation.
4. Add a "Next Steps" or "Related Topics" section at the bottom when it helps users continue.

## Procedure Structure

Present an operational procedure in this order:

1. State the prerequisites and risks.
2. Show the command or action.
3. State the resulting state changes, external traffic, credential changes, and other effects.
4. Give the verification command or observation and its acceptance criterion.
5. Give recovery or rollback instructions when failure can leave state behind or create risk.

Put warnings about destructive or replacement behavior, security relaxation, data loss, credential
exposure, external traffic, and public ingress before the action that creates the risk.

## Documentation-Specific Style

The [NemoClaw Writing Guide](../WRITING.md) owns general plain language, active voice, word choice,
sentence structure, claim accuracy, and review policy. The rules below apply only to documentation
pages.

### Voice and Tone

- Use second person ("you") when addressing the reader.
- Use present tense. "The command returns an error" not "The command will return an error."
- Avoid contractions. Write "do not," "cannot," and "it is."
- Spell out an uncommon abbreviation at first use.
  Spell out LLM, RAG, SLM, VLM, and MoE at first use.
- Replace Latinisms with plain English.
  Use "for example," "that is," "and so on," "through," and "compared to."
- Use "refer to" instead of "see," "can" instead of "may" for capability, and "after" instead of
  "once" for time.
- Do not use "please" in technical instructions.

### Product Names and Usage

- Write "NVIDIA" in all caps and use "an NVIDIA," not "a NVIDIA."
- Use NVIDIA spellings such as data center, dataset, open source, pretrained, startup, webpage,
  website, and Wi-Fi.
- Preserve quoted UI labels, API field names, and audience role labels instead of rewriting them to
  enforce second person.

### Formatting Rules

- End prose sentences with a period.
- Put one prose sentence per source line.
- Exempt frontmatter, headings, navigation labels, diagrams, code, output, UI labels, and compact
  table fragments from the prose sentence rules.
- Use `code` formatting for commands, code, filenames, paths, flags, environment variables, API
  identifiers, and literal values.
- Use numerals for specific values, parameters, measurements, and values of 10 or more.
  Spell out zero through nine in general prose.
- Include a space between a number and its unit.
  Use a comma in numbers with four or more digits.
- Use title case for headings.
  Do not style headings with code, bold, italics, quotation marks, ampersands, or exclamation marks.
- Use the Oxford comma.
  Put periods inside quotation marks in U.S. style.
- Use hyphens only for compound modifiers before nouns.
  Do not hyphenate an adverb that ends in "ly."
- Use bold for UI elements and the greater-than sign for UI navigation.
- Introduce lists, tables, code examples, and images with a complete sentence.
  Use parallel construction in lists.
- Use descriptive link text.
  Do not use raw URLs in running text or generic link text such as "click here" or "read more."
- Write dates as Month DD, YYYY.
  Omit the year when it matches the publication year.
  Write time with a 12-hour clock and include minutes only when needed.
- Provide useful alt text and preserve a logical heading hierarchy.
- Use language-specific code blocks for commands that readers should copy.
  Put only the command text in copyable blocks:

  ```bash
  npm run docs
  ```

- Apply the [agent variant generation rules](AUTOMATION.md#agent-variant-generation) to code samples that differ
  between guide variants.

- Use `powershell` for Windows PowerShell commands.
  Use `bash` or `sh` for Linux, macOS, and WSL shell commands.
  Use `bash` for generic copyable shell commands when a single tag is needed.
  Do not use prompt markers such as `$` in copyable command blocks.
  Keep command and output in separate fenced code blocks.
  Introduce output blocks with `Expected output:`.
  For output blocks, use `json` when the output is valid JSON, otherwise use `text`.
  Reserve `console` for rare transcript-style examples that intentionally mix command and output, including prompts or interactive sessions, and label the section as transcript-only so readers do not treat it as copy/paste input.

- Use tables for structured comparisons. Keep tables simple (no nested formatting).
- Use Fern callout components (`<Note>`, `<Tip>`, `<Warning>`) for callouts in MDX pages, not bold text.
- Avoid nested admonitions.
- Do not number section titles. Write "Deploy a Gateway" not "Section 1: Deploy a Gateway" or "Step 3: Verify."
- Do not use colons in titles. Write "Deploy and Manage Gateways" not "Gateways: Deploy and Manage."
- Use colons to introduce a list or define a term or value.
  Do not use a colon to join independent clauses.
