/**
 * Parse GitHub Actions YAML files and render slash-delimited workflow and job name trees. Requires Node.js and the repository's yaml package.
 */
export default async function workflow_name_tree(input: { workdir: string }): Promise<{
  files: Integer;
  workflows: Array<{ path: string; name: string; jobs: Array<{ id: string; name: string }> }>;
  workflowTree: string;
  jobTree: string;
}> {
  const command = `node --input-type=module <<'NODE'
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
const directory = path.join(process.cwd(), ".github", "workflows");
const entries = (await readdir(directory, { withFileTypes: true }).catch((error) => {
  if (error?.code === "ENOENT") return [];
  throw error;
}))
  .filter((entry) => entry.isFile() && /[.]ya?ml$/u.test(entry.name))
  .sort((left, right) => left.name.localeCompare(right.name));
if (entries.length > 500) throw new Error("workflow file count exceeds 500");
const workflows = [];
let totalBytes = 0;
let totalJobs = 0;
for (const entry of entries) {
  const text = await readFile(path.join(directory, entry.name), "utf8");
  const bytes = Buffer.byteLength(text);
  if (bytes > 2000000) throw new Error("workflow file exceeds 2 MB: " + entry.name);
  totalBytes += bytes;
  if (totalBytes > 10000000) throw new Error("workflow input exceeds 10 MB");
  const value = parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid workflow: " + entry.name);
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : entry.name;
  if (name.length > 500) throw new Error("workflow name exceeds 500 characters: " + entry.name);
  const jobValues = value.jobs ?? {};
  if (!jobValues || typeof jobValues !== "object" || Array.isArray(jobValues)) throw new Error("invalid jobs: " + entry.name);
  const jobs = Object.entries(jobValues).map(([id, job]) => {
    if (!job || typeof job !== "object" || Array.isArray(job)) throw new Error("invalid job: " + entry.name + ":" + id);
    const name = typeof job.name === "string" && job.name.trim() ? job.name.trim() : id;
    if (id.length > 500 || name.length > 500) throw new Error("job name exceeds 500 characters: " + entry.name);
    return { id, name };
  });
  if (jobs.length > 2000) throw new Error("job count exceeds 2000: " + entry.name);
  totalJobs += jobs.length;
  if (totalJobs > 10000) throw new Error("workflow job count exceeds 10000");
  workflows.push({ path: ".github/workflows/" + entry.name, name, jobs });
}
function tree(names) {
  const root = new Map();
  for (const name of names) {
    let level = root;
    for (const part of name.split("/").map((item) => item.trim()).filter(Boolean)) {
      if (!level.has(part)) level.set(part, new Map());
      level = level.get(part);
    }
  }
  const lines = [];
  function render(level, prefix) {
    const nodes = [...level.entries()].sort(([left], [right]) => left.localeCompare(right));
    nodes.forEach(([name, children], index) => {
      const last = index === nodes.length - 1;
      lines.push(prefix + (last ? "└── " : "├── ") + name);
      render(children, prefix + (last ? "    " : "│   "));
    });
  }
  render(root, "");
  return lines.join("\\n");
}
const output = JSON.stringify({
  files: workflows.length,
  workflows,
  workflowTree: tree(workflows.map((workflow) => workflow.name)),
  jobTree: tree(workflows.flatMap((workflow) => workflow.jobs.map((job) => job.name))),
});
if (Buffer.byteLength(output) > 1000000) throw new Error("workflow output exceeds 1 MB");
console.log(output);
NODE`;
  const result = await tools.bash({
    command,
    description: "Parse workflow and job name trees",
    workdir: input.workdir,
    timeoutMs: 120000,
  });
  if (result.kind !== "foreground") throw new Error("Workflow name parsing did not finish");
  if (result.exitCode !== 0) {
    const diagnostic = await tools.project_diagnostic_text({
      lines: result.stderr.text.split(/\r?\n/),
      maxLines: 10,
      maxCharacters: 2000,
      maxLineCharacters: 500,
    });
    throw new Error(diagnostic.text || "Workflow name parsing failed");
  }
  if (result.stdout.truncated) throw new Error("Workflow name output exceeded the transport bound");
  try {
    return JSON.parse(result.stdout.text);
  } catch {
    throw new Error("Workflow name output was not valid JSON");
  }
}
