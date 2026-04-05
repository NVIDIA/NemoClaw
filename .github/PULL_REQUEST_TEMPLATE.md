<!-- markdownlint-disable MD041 -->
<!-- Replace the placeholder guidance below and remove sections that do not apply before requesting review. -->
## Summary
<!-- 1-3 bullets or short paragraphs: what changed, why it changed, and the user/developer impact. -->

## Related Issues
<!-- Use GitHub keywords when applicable: Fixes #NNN, Closes #NNN, Addresses #NNN. Remove this section if none. -->

## Why
<!-- Root cause, motivation, or design constraint. For bug fixes, explain why the old behavior was wrong. For features, explain why this shape was chosen. -->

## Changes
<!-- Bullet list of the concrete code/docs/test changes in this PR. -->

## Type of Change
<!-- Check the one that applies. -->
- [ ] Code change for a new feature, bug fix, or refactor.
- [ ] Code change with doc updates.
- [ ] Doc only. Prose changes without code sample modifications.
- [ ] Doc only. Includes code sample changes.

## Validation
<!-- Check the broad validations that ran, then list the exact targeted commands below. If something could not be run, say so. -->
- [ ] `npx prek run --all-files` passes (or equivalently `make check`).
- [ ] `npm test` passes.
- [ ] `make docs` builds without warnings. (for doc-only changes)
- [ ] Additional targeted validation commands are listed below.

```console
# Paste the exact commands you ran, for example:
# npx vitest run test/onboard.test.js
# npm run build:cli
```

## Risks / Notes
<!-- Optional. Call out rollout concerns, known gaps, follow-ups, or environment-specific caveats. Remove this section if none. -->

## Checklist

### General

- [ ] I have read and followed the [contributing guide](https://github.com/NVIDIA/NemoClaw/blob/main/CONTRIBUTING.md).
- [ ] I have read and followed the [style guide](https://github.com/NVIDIA/NemoClaw/blob/main/docs/CONTRIBUTING.md). (for doc-only changes)

### Code Changes
<!-- Skip if this is a doc-only PR. -->
- [ ] Formatters applied — `npx prek run --all-files` auto-fixes formatting (or `make format` for targeted runs).
- [ ] Tests added or updated for new or changed behavior.
- [ ] No secrets, API keys, or credentials committed.
- [ ] Doc pages updated for any user-facing behavior changes (new commands, changed defaults, new features, bug fixes that contradict existing docs).

### Doc Changes
<!-- Skip if this PR has no doc changes. -->
- [ ] Follows the [style guide](https://github.com/NVIDIA/NemoClaw/blob/main/docs/CONTRIBUTING.md). Try running the `update-docs` agent skill to draft changes while complying with the style guide. For example, prompt your agent with "`/update-docs` catch up the docs for the new changes I made in this PR."
- [ ] New pages include SPDX license header and frontmatter, if creating a new page.
- [ ] Cross-references and links verified.

---
<!-- DCO sign-off (required by CI). Replace with your real name and email before opening the PR. -->
Signed-off-by: Your Name <your-email@example.com>
