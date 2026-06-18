## Description: <br>
Top-level workflow skill for USD performance diagnosis and optimization, used for slow loading, high memory, low FPS, or generic scene optimization requests. <br>

This skill is ready for commercial/non-commercial use. <br>

## Owner
NVIDIA <br>

### License/Terms of Use: <br>
Apache-2.0 <br>
## Use Case: <br>
Developers and engineers working with USD scenes who need to diagnose and resolve performance issues such as slow loading, high memory usage, low FPS, or GPU crashes in NVIDIA Omniverse workflows. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: Review before execution as proposals could introduce incorrect or misleading guidance into skills. <br>
Mitigation: Review and scan skill before deployment. <br>

## Reference(s): <br>
- [Workflow Reference](references/workflow.md) <br>
- [Skill Map](references/skill-map.md) <br>
- [USD Structure Assessment](references/usd-structure-assessment/README.md) <br>
- [Scene Optimizer Operations](references/operations/README.md) <br>
- [Setup USD Performance Tuning](references/setup-usd-performance-tuning/README.md) <br>
- [USD Validation Runner](references/usd-validation-runner/README.md) <br>
- [Optimization Report](references/optimization-report/README.md) <br>
- [Scene Optimizer Run Operations](references/so-run-operations/README.md) <br>
- [Compare Profiles](references/compare-profiles/README.md) <br>
- [Profile Stage](references/profile-stage/README.md) <br>


## Skill Output: <br>
**Output Type(s):** [Analysis, Shell commands, Configuration instructions, Files] <br>
**Output Format:** [Markdown with structured JSON reports] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [Produces optimization-report.schema.json-conforming reports and HTML previews via render_preview.py] <br>

## Evaluation Tasks: <br>
NVSkills-Eval 3-Tier evaluation (external profile): Tier 1 static validation (9 checks, 10 findings), Tier 2 deduplication analysis (2 checks, 17 findings). Tier 3 live agent evaluation not available in this report. <br>

## Evaluation Metrics Used: <br>
Reported benchmark dimensions: <br>
- Security: Checks whether skill-assisted execution avoids unsafe behavior such as secret leakage, destructive commands, or unauthorized access. <br>
- Correctness: Checks whether the agent follows the expected workflow and produces the correct final output. <br>
- Discoverability: Checks whether the agent loads the skill when relevant and avoids using it when irrelevant. <br>
- Effectiveness: Checks whether the agent performs measurably better with the skill than without it. <br>
- Efficiency: Checks whether the agent uses fewer tokens and avoids redundant work. <br>



## Skill Version(s): <br>
0.1.0 (source: frontmatter, pyproject.toml) <br>

## Ethical Considerations: <br>
NVIDIA believes Trustworthy AI is a shared responsibility and we have established policies and practices to enable development for a wide array of AI applications. When downloaded or used in accordance with our terms of service, developers should work with their internal team to ensure this skill meets requirements for the relevant industry and use case and addresses unforeseen product misuse. <br>

(For Release on NVIDIA Platforms Only) <br>
Please report quality, risk, security vulnerabilities or NVIDIA AI Concerns [here](https://app.intigriti.com/programs/nvidia/nvidiavdp/detail). <br>
