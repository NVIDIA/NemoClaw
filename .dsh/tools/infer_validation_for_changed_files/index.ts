/**
 * Infer targeted NemoClaw validation from branch and working-tree changes.
 */
export default async function infer_validation_for_changed_files(input: {
  workdir: string;
  baseRef?: string;
}): Promise<{
  baseRef: string;
  files: string[];
  branchFiles: string[];
  workingTreeFiles: string[];
  untrackedFiles: string[];
  projects: string[];
  targetedFiles: string[];
  commands: string[];
  notes: string[];
}> {
  const baseRef = input.baseRef ?? "origin/main";
  if (!baseRef.trim() || baseRef.length > 200 || baseRef.startsWith("-"))
    throw new Error("baseRef must contain 1 to 200 characters and must not start with a hyphen");
  const changed = await tools.list_nemoclaw_changed_files({
    workdir: input.workdir,
    baseRef,
  });
  const files = changed.files;
  const tests = new Set();
  const projects = new Set();
  const commands = new Set();
  const notes = [];
  const projectForTest = (file) => {
    if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || file.startsWith("test/e2e/live/"))
      return null;
    if (file.startsWith("nemoclaw/")) return "plugin";
    if (file.startsWith("src/")) return "cli";
    if (file.startsWith("test/package-contract/")) return "package-contract";
    if (file.startsWith("test/e2e/")) return "e2e-support";
    if (file.startsWith("test/")) return "integration";
    return null;
  };
  for (const file of files) {
    const project = projectForTest(file);
    if (project) {
      projects.add(project);
      tests.add(file);
    }
    if (file.startsWith("test/e2e/live/") && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))
      notes.push(
        "Live E2E tests changed; run npm run test:live-e2e only with explicit approval and a selected live target.",
      );
    if (/^(docs|fern)\//.test(file) || file === "docs/index.yml") commands.add("npm run docs");
    if (file.startsWith("nemoclaw/") && /\.[cm]?tsx?$/.test(file)) {
      projects.add("plugin");
      commands.add("npm --prefix nemoclaw run typecheck");
    }
    if (file.startsWith("src/") && /\.[cm]?tsx?$/.test(file)) {
      projects.add("cli");
      commands.add("npm run typecheck:cli");
    }
    if (/agents\/langchain-deepagents-code\/Dockerfile|corporate-ca/.test(file)) {
      [
        "test/security/corporate-ca-runtime-merge.test.ts",
        "test/install/corporate-ca-dockerfile-decode.test.ts",
        "src/lib/onboard/corporate-ca-host-anchors.test.ts",
        "src/lib/onboard/dockerfile-patch-corporate-ca.test.ts",
      ].forEach((x) => tests.add(x));
      projects.add("cli");
      projects.add("integration");
      notes.push("Corporate CA Dockerfile changes need CA ordering and decode guard tests.");
    }
    if (/src\/lib\/adapters\/docker\//.test(file)) {
      tests.add("src/lib/adapters/docker/index.test.ts");
      projects.add("cli");
    }
    if (/src\/lib\/agent\/base-image/.test(file)) {
      tests.add("src/lib/agent/base-image.test.ts");
      projects.add("cli");
    }
    if (/src\/lib\/sandbox-base-image/.test(file)) {
      tests.add("src/lib/sandbox-base-image/resolution-key.test.ts");
      projects.add("cli");
    }
    if (/src\/lib\/onboard\/machine\//.test(file)) {
      [
        "src/lib/onboard/machine/core-flow-phases.test.ts",
        "src/lib/onboard/machine/runtime.test.ts",
        "src/lib/onboard/runtime-boundary.test.ts",
      ].forEach((x) => tests.add(x));
      projects.add("cli");
    }
  }
  return {
    ...changed,
    projects: [...projects].sort(),
    targetedFiles: [...tests].sort(),
    commands: [...commands].sort(),
    notes: [...new Set(notes)],
  };
}
