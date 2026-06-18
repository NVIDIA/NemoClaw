## Description: <br>
Find Earth2Studio models, data sources, and examples for a weather/climate use case. <br>

This skill is ready for commercial/non-commercial use. <br>

## Owner
NVIDIA <br>

### License/Terms of Use: <br>
Apache 2.0 <br>
## Use Case: <br>
Developers and engineers use this skill to identify the right Earth2Studio models, data sources, and gallery examples for their weather and climate workflows, including filtering by GPU/VRAM requirements and verifying data-source compatibility via lexicons. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: Review before execution as proposals could introduce incorrect or misleading guidance into skills. <br>
Mitigation: Review and scan skill before deployment. <br>

## Reference(s): <br>
- [Earth2Studio Documentation](https://nvidia.github.io/earth2studio/) <br>
- [Prognostic Models](https://nvidia.github.io/earth2studio/modules/models_px.html) <br>
- [Diagnostic Models](https://nvidia.github.io/earth2studio/modules/models_dx.html) <br>
- [Data Sources (Analysis)](https://nvidia.github.io/earth2studio/modules/datasources_analysis.html) <br>
- [Examples Gallery](https://nvidia.github.io/earth2studio/examples/index.html) <br>
- [GitHub Repository](https://github.com/NVIDIA/earth2studio) <br>


## Skill Output: <br>
**Output Type(s):** [Analysis, Configuration instructions] <br>
**Output Format:** [Markdown with structured recommendation tables and documentation links] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [None] <br>

## Evaluation Agents Used: <br>
- claude-code <br>
- codex <br>



## Evaluation Tasks: <br>
Evaluated against 5 skill-activation tasks with 2 attempts per task (pass threshold: 50%). <br>

## Evaluation Metrics Used: <br>
Reported benchmark dimensions: <br>
- Security: Checks whether skill-assisted execution avoids unsafe behavior such as secret leakage, destructive commands, or unauthorized access. <br>
- Correctness: Checks whether the agent follows the expected workflow and produces the correct final output. <br>
- Discoverability: Checks whether the agent loads the skill when relevant and avoids using it when irrelevant. <br>
- Effectiveness: Checks whether the agent performs measurably better with the skill than without it. <br>
- Efficiency: Checks whether the agent uses fewer tokens and avoids redundant work. <br>

Underlying evaluation signals used in this run: <br>
- `security`: Checks for unsafe operations, secret leakage, and unauthorized access. <br>
- `skill_execution`: Verifies that the agent loaded the expected skill and workflow. <br>
- `skill_efficiency`: Checks routing quality, decoy avoidance, and redundant tool usage. <br>
- `accuracy`: Grades final-answer correctness against the reference answer. <br>
- `goal_accuracy`: Checks whether the overall user task completed successfully. <br>
- `behavior_check`: Verifies expected behavior steps, including safety expectations. <br>
- `token_efficiency`: Compares token usage with and without the skill. <br>



## Evaluation Results: <br>
| Dimension | Num | `claude-code` | `codex` |
|---|---:|---:|---:|
| Security | 8 | 100% (+0%) | 100% (+0%) |
| Correctness | 8 | 99% (+0%) | 90% (+8%) |
| Discoverability | 8 | 78% (-2%) | 51% (-3%) |
| Effectiveness | 8 | 92% (+2%) | 85% (+5%) |
| Efficiency | 8 | 55% (-1%) | 36% (-4%) |

## Skill Version(s): <br>
0.16.0 (source: frontmatter) <br>

## Ethical Considerations: <br>
NVIDIA believes Trustworthy AI is a shared responsibility and we have established policies and practices to enable development for a wide array of AI applications. When downloaded or used in accordance with our terms of service, developers should work with their internal team to ensure this skill meets requirements for the relevant industry and use case and addresses unforeseen product misuse. <br>

(For Release on NVIDIA Platforms Only) <br>
Please report quality, risk, security vulnerabilities or NVIDIA AI Concerns [here](https://app.intigriti.com/programs/nvidia/nvidiavdp/detail). <br>
