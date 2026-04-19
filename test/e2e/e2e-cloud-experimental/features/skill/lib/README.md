# E2E helper libraries (e2e-cloud-experimental)

| File | Role |
|------|------|
| `validate_repo_skills.sh` | Ensures `.agents/skills/*/SKILL.md` has YAML frontmatter (`name`, `description`) and a non-trivial body. Stdlib only. |
| `validate_sandbox_openclaw_skills.sh` | SSH: `/sandbox/.openclaw` + `openclaw.json` required; prints `SKILLS_SUBDIR=present` or `absent`. |

Used by **`test/e2e/test-e2e-cloud-experimental.sh`** (Phase 5c).
