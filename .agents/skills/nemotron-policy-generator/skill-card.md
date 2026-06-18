## Description: <br>
Generates BYO custom safety policies for NVIDIA Nemotron content-safety guardrails — Nemotron-Content-Safety-Reasoning-4B (text) and multimodal Nemotron-3-Content-Safety — producing a Markdown policy, JSON taxonomy, and drop-in inference prompts. <br>

This skill is ready for commercial/non-commercial use. <br>

## Owner
NVIDIA <br>

### License/Terms of Use: <br>
Apache-2.0 AND CC-BY-4.0 <br>
## Use Case: <br>
Developers and safety engineers creating custom content-safety policies for NVIDIA Nemotron guardrail models, mapping rough requirements into structured policy artifacts compatible with Nemotron-Content-Safety-Reasoning-4B and Nemotron-3-Content-Safety. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: Review before execution as proposals could introduce incorrect or misleading guidance into skills. <br>
Mitigation: Review and scan skill before deployment. <br>

## Reference(s): <br>
- [Content Safety V2 Taxonomy](references/content_safety_taxonomy.md) <br>
- [Policy Patterns](references/policy_patterns.md) <br>
- [Target Models](references/target_models.md) <br>


## Skill Output: <br>
**Output Type(s):** [Files, Configuration instructions] <br>
**Output Format:** [Markdown, JSON, and plain-text system prompts] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [None] <br>

## Evaluation Agents Used: <br>
- Claude Code (`claude-code`) <br>
- Codex (`codex`) <br>



## Evaluation Tasks: <br>
Evaluated against 11 tasks (6 positive activation, 5 negative activation) via NVSkills-Eval external profile with 2 attempts per task and a 50% pass threshold. <br>

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
| Security | 8 | 100% (+15%) | 100% (+9%) |
| Correctness | 8 | 88% (-4%) | 77% (+10%) |
| Discoverability | 8 | 92% (+6%) | 79% (+3%) |
| Effectiveness | 8 | 80% (+2%) | 64% (+19%) |
| Efficiency | 8 | 76% (+8%) | 71% (+3%) |

## Skill Version(s): <br>
0.1.0 (source: frontmatter, pyproject.toml) <br>

## Ethical Considerations: <br>
NVIDIA believes Trustworthy AI is a shared responsibility and we have established policies and practices to enable development for a wide array of AI applications. When downloaded or used in accordance with our terms of service, developers should work with their internal team to ensure this skill meets requirements for the relevant industry and use case and addresses unforeseen product misuse. <br>

(For Release on NVIDIA Platforms Only) <br>
Please report quality, risk, security vulnerabilities or NVIDIA AI Concerns [here](https://app.intigriti.com/programs/nvidia/nvidiavdp/detail). <br>
