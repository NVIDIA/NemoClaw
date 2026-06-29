<!-- markdownlint-disable MD041 -->
## Summary
<!-- 1-3 sentences: what this PR does and why. -->

## Related Issue
<!-- Fixes #NNN or Closes #NNN. Remove this section if none. -->

## Changes
<!-- Bullet list of key changes. -->

## Type of Change

- [ ] Code change (feature, bug fix, or refactor)
- [ ] Code change with doc updates
- [ ] Doc only (prose changes, no code sample modifications)
- [ ] Doc only (includes code sample changes)

## Quality Gates
<!-- Check all that apply. For any "covered by existing tests", "not applicable", or waiver entry, add a brief justification on the same line or in the Changes section. -->
- [ ] Tests added or updated for changed behavior
- [ ] Existing tests cover changed behavior — justification:
- [ ] Tests not applicable — justification:
- [ ] Docs updated for user-facing behavior changes
- [ ] Docs not applicable — justification:
- [ ] Sensitive paths changed (security, policy, credentials, preflight, onboarding, inference, runner, sandbox, or messaging)
- [ ] Sensitive-path review completed or maintainer-approved waiver recorded — reviewer/approval link/justification:
- [ ] Non-success, skipped, or missing CI check accepted by maintainer — check name, approval link, and follow-up issue:

## Verification
<!-- Check each item you ran and confirmed. Leave unchecked items you skipped. Doc-only changes do not require npm test unless you ran it. -->
- [ ] PR description includes the DCO sign-off declaration and every commit appears as `Verified` in GitHub
- [ ] Git hooks passed during commit and push, or `npx prek run --from-ref main --to-ref HEAD` passes
- [ ] Targeted tests pass for changed behavior
- [ ] Full `npm test` passes (broad runtime changes only)
- [ ] Quality Gates section completed with required justifications or waivers
- [ ] No secrets, API keys, or credentials committed
- [ ] `npm run docs` builds without warnings (doc changes only)
- [ ] Doc pages follow the [style guide](https://github.com/NVIDIA/NemoClaw/blob/main/docs/CONTRIBUTING.md) (doc changes only)
- [ ] New doc pages include SPDX header and frontmatter (new pages only)

---
<!-- DCO sign-off is required in this PR description, and every commit must appear as Verified in GitHub. Run: git config user.name && git config user.email -->
Signed-off-by: Your Name <your-email@example.com>
