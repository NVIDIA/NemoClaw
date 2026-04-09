# NemoClaw Risky Code Areas

PRs touching these areas need tests before approval.

| Area | Key paths |
|------|-----------|
| Installer / bootstrap shell | `install.sh`, `setup.sh`, `brev-setup.sh`, `scripts/*.sh` |
| Onboarding / host glue | `bin/lib/onboard.js`, `bin/*.js` |
| Sandbox / policy / SSRF | `nemoclaw/src/blueprint/`, `nemoclaw-blueprint/`, policy presets |
| Workflow / enforcement | `.github/workflows/`, prek hooks, DCO, signing, version/tag flows |
| Credentials / inference / network | credential helpers, inference provider routing, approval flows |

A PR in a risky area is only promoted in the queue when it is actually actionable.
If risky and under-tested, follow the test gaps or security sweep workflows.
