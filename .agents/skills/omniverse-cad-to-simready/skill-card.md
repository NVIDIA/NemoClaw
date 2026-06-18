## Description: <br>
Coordinate the end-to-end CAD/source-asset to SimReady workflow including conversion, material/physics assignment, SimReady conformance, validation, and optional package creation. <br>

This skill is ready for commercial/non-commercial use. <br>

## Owner
NVIDIA <br>

### License/Terms of Use: <br>
Apache 2.0 <br>
## Use Case: <br>
Developers and engineers converting CAD and source assets to simulation-ready OpenUSD with automated material/physics property assignment, SimReady profile conformance, validation, and packaging. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: Review before execution as proposals could introduce incorrect or misleading guidance into skills. <br>
Mitigation: Review and scan skill before deployment. <br>

## Reference(s): <br>
- [Workflow Reference](references/workflow.md) <br>
- [Commands Reference](references/commands.md) <br>
- [Preflight Setup](references/preflight/README.md) <br>
- [Convert to USD](references/convert-to-usd/README.md) <br>
- [Content Agents](references/content-agents/README.md) <br>
- [SimReady Conform Profile](references/simready-conform-profile/README.md) <br>
- [SimReady Validate](references/simready-validate/README.md) <br>
- [Assemble Package Source](references/assemble-package-source/README.md) <br>
- [OVRTX Render Service](references/ovrtx-render-service/README.md) <br>


## Skill Output: <br>
**Output Type(s):** [Files, Shell commands, Analysis] <br>
**Output Format:** [Markdown with JSON structured artifacts] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [None] <br>

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
