const { execSync } = require("child_process");
const sandboxName = "the-crucible";

function runCapture(cmd, opts = {}) {
  try {
    const output = execSync(cmd, {
      encoding: "utf-8",
      cwd: process.cwd(),
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      ...opts,
    }).trim();
    return output;
  } catch (err) {
    if (opts.ignoreError) return "";
    throw err;
  }
}

function isSandboxReady(output, sandboxName) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  console.log("Clean output:\n", clean);
  return clean.split("\n").some((l) => {
    const cols = l.trim().split(/\s+/);
    console.log("Checking line cols:", cols);
    const match = cols[0] === sandboxName && cols.includes("Ready") && !cols.includes("NotReady");
    if (match) console.log("MATCH FOUND!");
    return match;
  });
}

console.log("Running list...");
const listOutput = runCapture("openshell sandbox list", { ignoreError: true });
console.log("List output length:", listOutput.length);
const ready = isSandboxReady(listOutput, sandboxName);
console.log("isSandboxReady:", ready);

console.log("\nRunning get...");
try {
    const getOutput = runCapture(`openshell sandbox get "${sandboxName}"`, { ignoreError: false });
    console.log("Get output:", getOutput);
} catch(e) {
    console.log("Get failed:", e.message);
    if(e.stderr) console.log("Stderr:", e.stderr.toString());
}
