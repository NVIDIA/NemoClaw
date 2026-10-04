# E2E helper libraries (e2e-cloud-experimental)

| File | Role |
|------|------|
| `validate_repo_skills.sh` | Ensures `.agents/skills/*/SKILL.md` has YAML frontmatter (`name`, `description`) and a non-trivial body. Stdlib only. |

`test/repository/repo-skills-validation.test.ts` runs this contract in ordinary CI.
