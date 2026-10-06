# Test Desiderata Assessment Guide

Use Kent Beck's twelve properties as tradeoff dimensions, not mandatory checkboxes or a numerical score. Surrender a property only for a benefit worth its cost in this suite's context. The definitions below paraphrase Beck; inspection questions and evidence advice are this skill's operational interpretation.

## Properties and Evidence

### Behavioral

**Meaning:** relevant behavior changes affect the test result.

Identify a plausible wrong output, state transition, error, or side effect that would fail the test. Inspect whether its oracle distinguishes that mistake and has an independent basis. Assertions that merely repeat implementation calculations, constants, or configuration can pass alongside the same defect. A no-throw or exit-code check can be valuable when that is the promise; mere execution coverage is not evidence of other outcomes. A hypothetical defect analysis supports a concern, not a claim that mutation was performed.

### Structure-insensitive

**Meaning:** behavior-preserving structural changes leave the test result unchanged.

Consider extracting/inlining helpers, replacing internal storage, or changing private collaboration. Look for exact internal call order, private-method access, incidental DOM shape, broad snapshots, and props chosen solely as implementation mechanisms. Explain which correct alternative they exclude. Interaction order or count can be legitimate when it protects an external protocol, billing limit, or dangerous side effect. Public API contracts are not incidental structure.

### Specific

**Meaning:** a failure makes its likely cause clear.

Inspect assertion messages, test names, setup size, and whether independent behaviors are bundled. Prefer actual failure output when available. Several assertions can establish one coherent outcome; splitting them mechanically can obscure the scenario. Source inspection estimates diagnosability, while observed failures establish what diagnostics actually provide.

### Readable

**Meaning:** readers can understand the example and its motivation.

Check whether setup, action, and expected outcome are visible in domain vocabulary. Follow helpers to determine whether they remove noise or hide the premise. Prefer minimal relevant data and meaningful distinctions over arbitrary fixture bulk. A test's name must match what its assertions establish: verifying hiding props is narrower than proving a native accessibility tree excludes an element.

### Writable

**Meaning:** tests are inexpensive to write relative to the behavior they protect.

Inspect fixture construction, repetitive setup, required internals, and harness ceremony. Difficult setup may expose an awkward application interface, but a demanding integration boundary can justify it. Distinguish observable setup/maintenance complexity from actual authoring time, which requires history or developer evidence. Suggest focused helpers or better seams only when they preserve the promise rather than introduce a parallel application for tests.

### Fast

**Meaning:** tests provide feedback quickly enough for their purpose.

Measure selected-test and relevant-suite wall time, including startup and fixture costs, with commands and environment recorded. Avoid declaring speed from test size or imposing one universal duration limit. A slower acceptance check may buy predictive value unavailable to a microtest. Identify unnecessary repeated setup or redundant boundary coverage before proposing that valuable scenarios be removed.

### Isolated

**Meaning:** results are independent of test order.

Inspect shared globals, environment variables, databases, files, ports, clocks, and cleanup. Isolation means independence between tests, not mandatory mocking of production collaborators. Real SQLite or Git fixtures can be isolated through owned temporary resources. Reordered or independently executed cases provide stronger evidence than cleanup code alone; report untested ordering explicitly.

### Composable

**Meaning:** tests retain their results when run alone or in different groups.

Look for reliance on full-suite setup, other tests' side effects, name collisions, and worker-specific assumptions. Compare focused and grouped execution where safe. Sharded or parallel runs are useful additional evidence when the suite supports them; parallelism is not the definition of composability. Keep this distinct from isolation: order independence does not by itself establish that every selected group receives the required setup.

### Deterministic

**Meaning:** unchanged conditions produce unchanged results.

Inspect time, randomness, scheduling, race windows, live services, and model outputs. Controlled clocks, seeds, synchronization, and substitutes can help; arbitrary sleeps and retries may conceal uncertainty. Record environments and repeated-run results rather than promising absence of flakiness. Deterministic application tests and separate stochastic model/service evaluations protect different promises.

### Automated

**Meaning:** checks run without human intervention.

Inspect executable commands, assertions, setup, and CI integration. Distinguish automated setup from instructions requiring manual fixtures, login, or judgement. A human visual review can remain valuable evidence; call it manual rather than automated. Recognize automation gaps without demanding an executable test for every human assessment.

### Inspiring

**Meaning:** passing tests inspire confidence to make progress.

Assess whether the suite protects important promises, permits refactoring, and provides understandable feedback that developers can use. Flaky failures, ignored tests, and costly maintenance can undermine trust. Infer likely confidence benefits from evidence, but attribute actual team sentiment only to developer feedback or recorded experience. A local suite can inspire confidence in programming progress without establishing deployment readiness.

### Predictive

**Meaning:** passing tests provide useful evidence of production suitability.

Map important production assumptions to actual boundary coverage: host call shapes, native semantics, persistence and recovery, network behavior, or model task quality. Look for substitutes that reproduce an assumption rather than check it, bypassed composition, and conditional scenarios that silently skip their critical step. Evaluate complementary evidence across the suite; a unit test need not predict the whole system alone. Passing implementation tests may coexist with failed real-model evaluations. Report the remaining risk instead of equating green counts with readiness.

## Evidence Discipline

Label evidence as **source inspection**, **recorded execution**, or **new execution**. Separate confidence in the finding from severity of its impact. Missing measurements mean unknown, not automatically poor quality. A confirmed test-harness failure is distinct from a reproduced application defect.

For each proposed improvement, answer: what additional defect becomes detectable, what correct change becomes easier, and what confidence or maintenance tradeoff results? Keep observed strengths as counterexamples to broad claims about a testing style.

## Sources

- Kent Beck, [Test Desiderata](https://medium.com/@kentbeck_7670/test-desiderata-94150638a4b3), October 18, 2019: original properties and tradeoff framing.
- Kent Beck, [Desirable Unit Tests](https://newsletter.kentbeck.com/p/desirable-unit-tests), January 20, 2022: properties as sliders, isolation between tests, and limitations of unit-test prediction.
