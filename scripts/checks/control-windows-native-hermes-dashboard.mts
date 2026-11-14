// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readOpenedRegularFile } from "../../packaging/windows/runtime/native-security.mts";

// These names are provided by the browser when Playwright evaluates the callbacks.
// Module-local declarations keep browser globals out of the CLI type environment.
interface BrowserSocket {
  addEventListener(kind: "message", listener: (event: { data: unknown }) => void): void;
}
interface BrowserSocketConstructor {
  new (url: string | URL, protocols?: string | string[]): BrowserSocket;
}
declare const window: { WebSocket: BrowserSocketConstructor };
declare const location: { href: string };
declare const requestAnimationFrame: (callback: (time: number) => void) => number;

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}
const installRoot = path.resolve(argument("--install-root"));
const artifactRoot = path.resolve(argument("--artifact-directory"));
const inputMarker = argument("--input-marker");
const outputMarker = argument("--output-marker");
if (
  process.platform !== "win32" ||
  !/^NEMOCLAW_INTERACTIVE_INPUT_[a-f0-9]{16}$/u.test(inputMarker) ||
  !/^NEMOCLAW_INTERACTIVE_OUTPUT_[a-f0-9]{16}$/u.test(outputMarker)
)
  throw new Error("Invalid native dashboard proof identity");
const startPath = path.join(artifactRoot, "dashboard-ready.json");
const startText = readOpenedRegularFile(startPath, { encoding: "utf8", maxBytes: 16384 });
if (startText === null) throw new Error("The installed dashboard readiness receipt is missing");
const start: unknown = JSON.parse(startText);
if (
  typeof start !== "object" ||
  start === null ||
  !("url" in start) ||
  typeof start.url !== "string" ||
  !("schemaVersion" in start) ||
  start.schemaVersion !== 1 ||
  !("agent" in start) ||
  start.agent !== "hermes" ||
  !("nodeProcessId" in start) ||
  typeof start.nodeProcessId !== "number" ||
  !Number.isInteger(start.nodeProcessId) ||
  start.nodeProcessId <= 0
)
  throw new Error("The installed dashboard returned an invalid address");
let address: URL;
try {
  address = new URL(start.url);
} catch {
  throw new Error("The installed dashboard returned an invalid address");
}
if (
  address.protocol !== "http:" ||
  address.hostname !== "127.0.0.1" ||
  !address.port ||
  address.username ||
  address.password ||
  address.search ||
  address.hash
)
  throw new Error("The installed dashboard returned an invalid address");
const receiptPath = path.join(artifactRoot, "dashboard-control.json");
const edge = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]
  .filter(Boolean)
  .map((root) => path.join(root!, "Microsoft", "Edge", "Application", "msedge.exe"))
  .find((file) => fs.existsSync(file));
if (!edge) throw new Error("Installed Microsoft Edge is missing");
const require = createRequire(
  path.join(installRoot, "openclaw", "node_modules", "openclaw", "package.json"),
);
const { chromium } = require("playwright-core");
const browser = await chromium.launch({
  executablePath: edge,
  headless: false,
  args: [
    "--no-first-run",
    "--no-default-browser-check",
    "--window-position=20,10",
    "--window-size=1440,810",
  ],
});
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 730 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const state = { text: "", sockets: 0, messages: 0, overflow: false };
    Object.defineProperty(window, "__nativeHermesProof", { value: state });
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (new URL(String(url), location.href).pathname !== "/api/pty") return;
        state.sockets++;
        this.addEventListener("message", async (event) => {
          // Observe the shipped PTY stream; every event still reaches the real xterm unchanged.
          const text =
            typeof event.data === "string"
              ? event.data
              : event.data instanceof Blob
                ? await event.data.text()
                : event.data instanceof ArrayBuffer
                  ? new TextDecoder().decode(event.data)
                  : "";
          state.messages++;
          if (state.text.length + text.length > 4 * 1024 * 1024) {
            state.overflow = true;
            return;
          }
          state.text += text;
        });
      }
    };
  });
  await page.goto(new URL("/chat", address).href, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  const input = page.locator(".xterm-helper-textarea").first();
  await input.waitFor({ state: "attached", timeout: 120_000 });
  await page.locator(".xterm-screen").first().waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction(
    () => {
      const state = (
        window as unknown as {
          __nativeHermesProof: { text: string; sockets: number; overflow: boolean };
        }
      ).__nativeHermesProof;
      return (
        state.sockets > 0 &&
        !state.overflow &&
        /hermes/i.test(state.text) &&
        /Ask me anything|Try "(?:explain this codebase|write a test for|refactor the auth module|\/help|fix the lint errors|how does the config loader work)/.test(
          state.text,
        )
      );
    },
    undefined,
    { timeout: 120_000 },
  );
  const screenshots: { file: string; sha256: string }[] = [];
  async function screenshot(file: string) {
    const target = path.join(artifactRoot, file);
    await page.screenshot({ path: target, animations: "disabled" });
    const bytes = fs.readFileSync(target);
    if (bytes.length < 4096) throw new Error("The real Hermes dashboard frame is missing");
    screenshots.push({ file, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await screenshot("hermes-dashboard-prompt.png");
  const turns = [];
  for (let index = 1; index <= 3; index++) {
    const typed = `${inputMarker}_${index}`;
    const expected = `${outputMarker}_${index}`;
    await input.focus();
    await page.keyboard.type(`Please answer this diagnostic message: ${typed}`, { delay: 15 });
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (marker: string) => {
        const state = (
          window as unknown as { __nativeHermesProof: { text: string; overflow: boolean } }
        ).__nativeHermesProof;
        return !state.overflow && state.text.includes(marker);
      },
      expected,
      { timeout: 120_000 },
    );
    // Let the real terminal paint its received provider response before capturing it.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await screenshot(`hermes-dashboard-turn-${index}.png`);
    turns.push({
      index,
      inputMarker: typed,
      outputMarker: expected,
      typedThroughRealTerminal: true,
      providerOutputObserved: true,
    });
  }
  const transport = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __nativeHermesProof: { sockets: number; messages: number; overflow: boolean };
      }
    ).__nativeHermesProof;
    return { sockets: state.sockets, messages: state.messages, overflow: state.overflow };
  });
  if (transport.overflow || transport.messages < 3)
    throw new Error("Hermes PTY evidence exceeded its bound or did not receive three turns");
  fs.writeFileSync(
    receiptPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        classification: "installed-hermes-dashboard-real-spa-pty",
        agent: "hermes",
        nodeProcessId: start.nodeProcessId,
        browser: "Microsoft Edge",
        actualShippedSpa: true,
        realXtermInput: true,
        turns,
        transport,
        screenshots,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    "PASS: the shipped Hermes dashboard accepted three typed messages and displayed three distinct provider responses.",
  );
} finally {
  await browser.close();
}
