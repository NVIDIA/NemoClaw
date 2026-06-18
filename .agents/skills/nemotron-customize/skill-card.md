## Description: <br>
Plan, configure, and chain repo-native Nemotron customization steps into single-step or multi-step pipelines: curation, translation, SFT/PEFT (AutoModel or Megatron-Bridge), pretraining/CPT, RL alignment (DPO/RLVR/GRPO/RLHF), BYOB/MCQ benchmarks, checkpoint conversion, ModelOpt optimization, env profiles, and evaluation of trained checkpoints or existing/hosted endpoints. <br>

This skill is ready for commercial/non-commercial use. <br>

## Owner
NVIDIA <br>

### License/Terms of Use: <br>
Apache 2.0 <br>
## Use Case: <br>
Developers and ML engineers use this skill to plan, configure, and execute Nemotron model customization pipelines including data curation, fine-tuning, RL alignment, checkpoint conversion, optimization, and evaluation of trained or hosted endpoints. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: Review before execution as proposals could introduce incorrect or misleading guidance into skills. <br>
Mitigation: Review and scan skill before deployment. <br>

## Reference(s): <br>
- [CATALOG.md](references/CATALOG.md) <br>
- [ARTIFACTS.md](references/ARTIFACTS.md) <br>
- [COMMANDS.md](references/COMMANDS.md) <br>
- [HARDWARE.md](references/HARDWARE.md) <br>
- [PATTERNS.md](references/PATTERNS.md) <br>
- [WORKFLOW.md](references/WORKFLOW.md) <br>


## Skill Output: <br>
**Output Type(s):** [Shell commands, Configuration instructions, Files] <br>
**Output Format:** [Markdown with inline bash code blocks and YAML configuration files] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [None] <br>

## Evaluation Agents Used: <br>
- `claude-code` <br>
- `codex` <br>



## Evaluation Tasks: <br>
Evaluated against 8 evaluation tasks (all positive skill-activation cases) with 2 attempts per task and a 50% pass threshold. <br>

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
| Correctness | 8 | 95% (+16%) | 94% (+22%) |
| Discoverability | 8 | 78% (+45%) | 68% (+19%) |
| Effectiveness | 8 | 94% (+7%) | 91% (+25%) |
| Efficiency | 8 | 63% (+37%) | 54% (+11%) |

## Skill Version(s): <br>
0.1.1 (source: frontmatter) <br>

## Ethical Considerations: <br>
NVIDIA believes Trustworthy AI is a shared responsibility and we have established policies and practices to enable development for a wide array of AI applications. When downloaded or used in accordance with our terms of service, developers should work with their internal team to ensure this skill meets requirements for the relevant industry and use case and addresses unforeseen product misuse. <br>

(For Release on NVIDIA Platforms Only) <br>
Please report quality, risk, security vulnerabilities or NVIDIA AI Concerns [here](https://app.intigriti.com/programs/nvidia/nvidiavdp/detail). <br>
