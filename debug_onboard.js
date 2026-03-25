const { execSync } = require('child_process');
const sandboxName = 'the-crucible';

function runCapture(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      cwd: process.cwd(),
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      ...opts,
    }).trim();
  } catch (err) {
    console.error('Command failed:', err.message);
    if (opts.ignoreError) return "";
    throw err;
  }
}

try {
  const cmd = `openshell sandbox get "${sandboxName}" 2>/dev/null`;
  console.log(`Running: ${cmd}`);
  const output = runCapture(cmd, { ignoreError: true });
  console.log('Output length:', output.length);
  console.log('Output:', output);
  console.log('Exists:', !!output);
} catch (e) {
  console.error(e);
}
