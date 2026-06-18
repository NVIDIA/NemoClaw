## Description: <br>
Run AutoML / hyperparameter optimization (HPO) for NVIDIA TAO networks using AutoMLRunner, handling algorithm selection, WandB experiment tracking, job execution on any TAO SDK platform, result interpretation, and per-rec custom evaluation hooks. <br>

This skill is ready for commercial/non-commercial use. <br>

## Owner
NVIDIA <br>

### License/Terms of Use: <br>
Apache 2.0 <br>
## Use Case: <br>
Developers and engineers who need to automatically tune training hyperparameters for NVIDIA TAO networks across multiple compute backends (DGX Cloud, SLURM, Kubernetes, Brev, Docker) without manually configuring search spaces or managing trial orchestration. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: Review before execution as proposals could introduce incorrect or misleading guidance into skills. <br>
Mitigation: Review and scan skill before deployment. <br>

## Reference(s): <br>
- [algorithms.md](references/algorithms.md) <br>
- [automl-settings.md](references/automl-settings.md) <br>
- [custom-param-ranges.md](references/custom-param-ranges.md) <br>
- [examples.md](references/examples.md) <br>
- [hooks-and-wandb.md](references/hooks-and-wandb.md) <br>
- [intake-and-inputs.md](references/intake-and-inputs.md) <br>
- [mandatory-rules.md](references/mandatory-rules.md) <br>
- [monitoring-and-resume.md](references/monitoring-and-resume.md) <br>
- [nl-config-and-research.md](references/nl-config-and-research.md) <br>
- [pitfalls.md](references/pitfalls.md) <br>
- [prerequisites.md](references/prerequisites.md) <br>
- [results.md](references/results.md) <br>


## Skill Output: <br>
**Output Type(s):** [Shell commands, Configuration instructions, Analysis] <br>
**Output Format:** [Markdown with inline bash code blocks] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [None] <br>

## Evaluation Agents Used: <br>
- Claude Code (`claude-code`) <br>
- Codex (`codex`) <br>



## Evaluation Tasks: <br>
Evaluated against 1 evaluation task (1 positive skill-activation case) using the NVSkills-Eval `external` profile in an `astra-sandbox` environment with 2 attempts per task and a 50% pass threshold. <br>

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
| Security | 2 | 100% (+0%) | 100% (+0%) |
| Correctness | 2 | 75% (+75%) | 92% (+92%) |
| Discoverability | 2 | 44% (+44%) | 97% (+97%) |
| Effectiveness | 2 | 87% (+73%) | 71% (+57%) |
| Efficiency | 2 | 51% (+24%) | 96% (+68%) |

## Skill Version(s): <br>
0.1.0 (source: frontmatter) <br>

## Ethical Considerations: <br>
NVIDIA believes Trustworthy AI is a shared responsibility and we have established policies and practices to enable development for a wide array of AI applications. When downloaded or used in accordance with our terms of service, developers should work with their internal team to ensure this skill meets requirements for the relevant industry and use case and addresses unforeseen product misuse. <br>

(For Release on NVIDIA Platforms Only) <br>
Please report quality, risk, security vulnerabilities or NVIDIA AI Concerns [here](https://app.intigriti.com/programs/nvidia/nvidiavdp/detail). <br>
