## Description: <br>
Run the full DEFT AOI improvement loop for NVIDIA TAO VisualChangeNet / ChangeNet PCB inspection models: baseline evaluate, RCA, ingestion of customer-supplied pre-generated AnomalyGen images, k-NN mining, retraining, and deployment gating until FAR / recall KPI targets are met. <br>

This skill is ready for commercial/non-commercial use. <br>

## Owner
NVIDIA <br>

### License/Terms of Use: <br>
Apache-2.0 AND CC-BY-4.0 <br>
## Use Case: <br>
Developers and engineers use this skill to iteratively improve NVIDIA TAO VisualChangeNet PCB inspection models through an automated data-improvement loop combining RCA, synthetic defect ingestion, k-NN mining, retraining, and deployment gating until quality KPI targets are met. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: Review before execution as proposals could introduce incorrect or misleading guidance into skills. <br>
Mitigation: Review and scan skill before deployment. <br>

## Reference(s): <br>
- [pipeline.md](references/pipeline.md) <br>
- [pre-flight.md](references/pre-flight.md) <br>
- [visual-changenet.md](references/visual-changenet.md) <br>
- [stage-execution.md](references/stage-execution.md) <br>
- [state-logging.md](references/state-logging.md) <br>
- [tao-analyze-gaps-visual-changenet.md](references/tao-analyze-gaps-visual-changenet.md) <br>
- [tao-mine-aoi-images.md](references/tao-mine-aoi-images.md) <br>
- [tao-route-visual-changenet-samples.md](references/tao-route-visual-changenet-samples.md) <br>
- [prepare-for-inference.md](references/prepare-for-inference.md) <br>


## Skill Output: <br>
**Output Type(s):** [Shell commands, Files, Configuration instructions] <br>
**Output Format:** [Markdown with inline bash code blocks] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [Produces trained model checkpoints, inference specs, HTML reports, and JSONL stage logs under the workspace results directory] <br>

## Evaluation Agents Used: <br>
- Claude Code (`claude-code`) <br>
- Codex (`codex`) <br>



## Evaluation Tasks: <br>
Evaluated against 1 evaluation task with 2 attempts per task using NVSkills-Eval external profile in astra-sandbox environment. <br>

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
| Correctness | 2 | 50% (+50%) | 92% (+92%) |
| Discoverability | 2 | 0% (+0%) | 80% (+80%) |
| Effectiveness | 2 | 96% (+86%) | 70% (+52%) |
| Efficiency | 2 | 27% (-0%) | 79% (+50%) |

## Skill Version(s): <br>
0.1.0 (source: frontmatter) <br>

## Ethical Considerations: <br>
NVIDIA believes Trustworthy AI is a shared responsibility and we have established policies and practices to enable development for a wide array of AI applications. When downloaded or used in accordance with our terms of service, developers should work with their internal team to ensure this skill meets requirements for the relevant industry and use case and addresses unforeseen product misuse. <br>

(For Release on NVIDIA Platforms Only) <br>
Please report quality, risk, security vulnerabilities or NVIDIA AI Concerns [here](https://app.intigriti.com/programs/nvidia/nvidiavdp/detail). <br>
