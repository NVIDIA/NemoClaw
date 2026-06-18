## Description: <br>
Pre-migration readiness assessor that inspects NumPy source code, cross-references the cuPyNumeric API support manifest, and produces a structured scaling verdict with concrete refactor pointers before substantial GPU porting work begins. <br>

This skill is ready for commercial/non-commercial use. <br>

## Owner
NVIDIA <br>

### License/Terms of Use: <br>
CC-BY-4.0 OR Apache-2.0 <br>
## Use Case: <br>
Developers and engineers evaluating whether their existing NumPy codebases will scale on cuPyNumeric and identifying which patterns must be refactored before committing to a GPU migration. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: Review before execution as proposals could introduce incorrect or misleading guidance into skills. <br>
Mitigation: Review and scan skill before deployment. <br>

## Reference(s): <br>
- [cuPyNumeric Documentation](https://docs.nvidia.com/cupynumeric/latest/) <br>
- [cuPyNumeric API Comparison Table](https://nv-legate.github.io/cupynumeric/api/comparison.html) <br>
- [cuPyNumeric GitHub Repository](https://github.com/nv-legate/cupynumeric) <br>
- [Decision Framework](references/decision-framework.md) <br>
- [Idioms That Block Scaling](references/idioms-that-block.md) <br>
- [Idioms That Scale](references/idioms-that-scale.md) <br>
- [Refactor Recipes](references/refactor-recipes.md) <br>
- [GPU Stack Overview](references/gpu-stack.md) <br>
- [Execution Model](references/execution-model.md) <br>


## Skill Output: <br>
**Output Type(s):** [Analysis] <br>
**Output Format:** [Markdown] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [Structured assessment with verdict (READY / LIGHT REFACTOR / SIGNIFICANT REFACTOR / NOT RECOMMENDED), per-finding file:line citations, and recipe pointers] <br>

## Evaluation Agents Used: <br>
- claude-code <br>
- codex <br>



## Evaluation Tasks: <br>
Evaluated against 27 tasks (23 positive activation, 4 negative activation) with 2 attempts per task at 50% pass threshold. <br>

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
| Security | 8 | 100% (+0%) | 100% (+1%) |
| Correctness | 8 | 98% (+24%) | 87% (+13%) |
| Discoverability | 8 | 96% (+42%) | 66% (+8%) |
| Effectiveness | 8 | 81% (+16%) | 70% (+15%) |
| Efficiency | 8 | 81% (+28%) | 52% (+2%) |

## Testing Completed: <br>
**[x] Agent Red-Teaming** <br>
**[ ] Network Security** <br>
**[ ] Product Security** <br>

## Skill Version(s): <br>
2.0.0 (source: frontmatter) <br>

## Ethical Considerations: <br>
NVIDIA believes Trustworthy AI is a shared responsibility and we have established policies and practices to enable development for a wide array of AI applications. When downloaded or used in accordance with our terms of service, developers should work with their internal team to ensure this skill meets requirements for the relevant industry and use case and addresses unforeseen product misuse. <br>

(For Release on NVIDIA Platforms Only) <br>
Please report quality, risk, security vulnerabilities or NVIDIA AI Concerns [here](https://app.intigriti.com/programs/nvidia/nvidiavdp/detail). <br>
