<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw Writing Guide

NemoClaw uses the plain-language principles in
[ASD-STE100 Issue 9](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf)
for software engineering. NemoClaw does not claim full ASD-STE100 compliance.

Use repository terms, software identifiers, API names, and necessary domain terms as technical
nouns or technical verbs. Do not copy the ASD-STE100 dictionary or its examples into this
repository. This guide is the NemoClaw source of truth.

## Scope and Review Policy

Apply this guide when you add or modify:

- Code comments.
- Test titles.
- PR descriptions and comments.
- Changelog entries and Announcements.
- Contributor guidance, agent guidance, and user documentation.

Do not request unrelated language cleanup in a feature, fix, or release PR. Put existing language
debt in a focused follow-up PR.

Language findings are suggestions unless ambiguity can change behavior, security, data safety,
test meaning, or release meaning. A blocking comment must name that effect. A suggestion should
include a proposed rewrite.

### Full-Corpus Audits

Use full-corpus audit mode only when the task explicitly requests an audit of existing text.
The changed-text scope does not apply to the assigned author-maintained sources during that audit.

- Review unchanged text in the assigned corpus.
- Preserve literal identifiers, commands, output, API fields, quotations, and official
  third-party names.
- Exclude generated files unless the task assigns their source or generator.
- Preserve accurate historical statements. Report them only when their meaning is incorrect or
  can misdirect a current action.
- Group repeated low-impact language debt into one finding with representative evidence.
- Report findings without editing the audited text unless the task also authorizes edits.

## Writing Rules

1. Use one term for one concept. Do not use synonyms to add variety.
2. Use a term with one meaning in a given context.
3. Use the shortest familiar term that preserves the technical meaning.
4. Name the actor when known. Use passive voice only when the actor is unknown or does not matter.
5. Put one instruction in each sentence. Split actions that occur at different times.
6. Keep instructions at 20 words or fewer when possible. Keep descriptions at 25 words or fewer when possible.
7. State a condition before the action that depends on it.
8. Use `must` for a requirement, `may` for permission, `can` for capability, and `should` for a recommendation.
9. Name the object of relative terms such as `current`, `latest`, `previous`, and `next`.
10. Replace `ready`, `clean`, `safe`, `small`, and similar judgments with the condition that makes them true.
11. Remove `just`, `simply`, `obviously`, `clearly`, `easy`, `robust`, and other words that do not change the meaning.
12. Avoid an idiom or phrasal verb that can have more than one meaning. Use a direct technical term when one is available.
13. Use a vertical list for three or more conditions, actions, or results.
14. In a code comment, explain a constraint, invariant, or reason that the code does not show. Do not restate the code.

Sentence lengths are review targets, not mechanical limits. Do not make a sentence less accurate to
meet a word count. Quoted user text, external text, code, identifiers, commands, URLs, and generated
content are outside the word and sentence rules.

## Controlled Word List

Use the [NemoClaw Controlled Word List](.agents/skills/_shared/controlled-words.md) for approved technical terms,
lifecycle verbs, product names, and engineering evidence terms.
The list gives one meaning to each controlled term and explains how to add or change an entry.

## Rewrite Examples

These examples use recurring NemoClaw concepts. They show the required level of precision.

| Surface | Avoid | Use |
|---|---|---|
| Code comment | `// Handle edge case.` | `// GitHub omits headRepository after a fork is deleted.` |
| Code comment | `// This is needed for safety.` | `// Reject private IP targets to prevent SSRF.` |
| Code comment | `// Keep this in sync.` | `// This list must match requiredChecks in check-gates.ts.` |
| Code comment | `// Use the latest state.` | `// Read headRefOid again before approval.` |
| Code comment | `// Work around a GitHub issue.` | `// GitHub can return no PR association for a deleted fork repository.` |
| Test title | `handles invalid config correctly` | `rejects a config that has no provider` |
| Test title | `works after retry` | `retries evidence download after child cancellation` |
| Test title | `covers edge cases (#1234)` | `rejects an empty policy name (#1234)` |
| Test title | `fixes issue #1234` | `preserves credentials when a sandbox rebuilds (#1234)` |
| Test title | `does the right thing for forks` | `does not expose repository secrets to fork code` |
| PR discussion | `This seems brittle.` | `This catch block hides EACCES. Callers then treat denied access as missing state.` |
| PR discussion | `Can we clean this up?` | `These two parsers implement the same policy. Use parsePolicy in both call sites.` |
| PR discussion | `Make this more robust.` | `Return a typed access error for EACCES and add a denial-path test.` |
| PR discussion | `This is a small change.` | `This change updates one parser and does not change the policy schema.` |
| PR discussion | `The PR is ready.` | `Required checks pass on 1a2b3c4, and GitHub reports MERGEABLE.` |
| Announcement | `Improved onboarding.` | `Onboarding now resumes after provider selection fails.` |
| Announcement | `Added more robust E2E handling.` | `The PR gate now retries evidence download after a child run is cancelled.` |
| Release entry | `Fixed various issues.` | `The CLI now rejects a provider configuration that has no endpoint.` |
| Release entry | `Better error handling.` | `The CLI now reports the provider authentication error without a stack trace.` |
| Procedure | `Refresh and rerun as needed.` | `Push the next commit. Rerun the gate.` |
