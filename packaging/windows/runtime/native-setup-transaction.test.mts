// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import test, { after } from "node:test";
import {
  configureNativeFromStdin,
  readNativeAgentConfiguration,
  type NativeOnboardingConfiguration,
} from "./native-setup-configuration.mts";
import {
  saveNativeOnboardingConfiguration,
  startOnboardingServer,
} from "./run-installed-native-web-ui.mts";
import { nativeCredentialBinding } from "./native-security.mts";
import { NATIVE_SERVICES, nativeServiceBinding } from "./native-options.mts";
import { readNativeConfigurationRecovery } from "./native-configuration-recovery.mts";
import { nativePackageFixture } from "../tests/native-package-fixture.mts";
import { readNativePackageAvailability } from "./native-package-availability.mts";

const packageFixture = nativePackageFixture(after);

for (const included of ["openclaw", "hermes"] as const) {
  const absent = included === "openclaw" ? "hermes" : "openclaw";
  for (const args of [[], ["--prepare-all"], ["--prepare-service", "tavily"], ["--transaction"]]) {
    test(`${included}-only setup rejects absent ${absent} before ${args[0] ?? "save"} side effects`, async (t) => {
      const installed = nativePackageFixture(t.after.bind(t), {
        openclaw: included === "openclaw" ? "qualified" : "not-included",
        hermes: included === "hermes" ? "qualified" : "not-included",
      });
      const request = { ...configuration, agent: absent };
      const input = Buffer.from(
        JSON.stringify(
          args.includes("--transaction") ? { configuration: request, credentials } : request,
        ),
      );
      let protectedCalls = 0;
      let emitted = "";
      await assert.rejects(
        configureNativeFromStdin(
          installed.launcher,
          args,
          Readable.from([input]),
          {
            write(value) {
              emitted += value.toString();
              return true;
            },
          },
          {
            lookupEndpoint: async () => {
              protectedCalls++;
              return [{ address: "8.8.8.8", family: 4 }];
            },
            inspectModel: async () => {
              protectedCalls++;
              throw new Error("unexpected model inspection");
            },
            acquireState: async () => {
              protectedCalls++;
              throw new Error("unexpected state acquisition");
            },
            credentialStore: {
              read: async () => {
                protectedCalls++;
                return "";
              },
              write: async () => {
                protectedCalls++;
              },
            },
            writeConfiguration: () => {
              protectedCalls++;
              return "unexpected write";
            },
          },
        ),
        /not included in this installer/u,
      );
      assert.equal(protectedCalls, 0);
      assert.equal(emitted, "");
      assert(input.every((byte) => byte === 0));
      assert.deepEqual(fs.readdirSync(installed.root), ["runtime-package-availability.json"]);
    });
  }
  test(`included unqualified ${included} can prepare qualification without enabling the absent agent`, async (t) => {
    const installed = nativePackageFixture(t.after.bind(t), {
      openclaw: included === "openclaw" ? "unqualified" : "not-included",
      hermes: included === "hermes" ? "unqualified" : "not-included",
    });
    let output = "";
    await configureNativeFromStdin(
      installed.launcher,
      ["--prepare-all"],
      Readable.from([
        Buffer.from(JSON.stringify({ ...configuration, agent: included, options: {} })),
      ]),
      {
        write(value) {
          output += value.toString();
          return true;
        },
      },
      { acquireState: async () => assert.fail("Preparation acquired state.") },
    );
    assert.equal(
      JSON.parse(output).inference,
      nativeCredentialBinding({ ...configuration, agent: included }),
    );
    assert.deepEqual(readNativePackageAvailability(installed.root), {
      [included]: "unqualified",
      [absent]: "not-included",
    });
  });
}

test("missing or invalid package availability fails before setup state acquisition", async (t) => {
  const installed = nativePackageFixture(t.after.bind(t));
  for (const value of [
    null,
    "{",
    JSON.stringify({ ...installed.record, schemaVersion: 2 }),
    JSON.stringify({
      ...installed.record,
      agents: [installed.record.agents[0], installed.record.agents[0]],
    }),
    JSON.stringify({
      ...installed.record,
      agents: [{ agent: "pi", status: "qualified" }, installed.record.agents[1]],
    }),
    JSON.stringify({
      ...installed.record,
      agents: [{ agent: "openclaw", status: "unknown" }, installed.record.agents[1]],
    }),
    JSON.stringify({ ...installed.record, prebuiltLocalModelAvailable: "true" }),
    JSON.stringify({ ...installed.record, extra: true }),
    "x".repeat(16385),
  ]) {
    if (value === null) fs.rmSync(installed.availability);
    else fs.writeFileSync(installed.availability, value);
    await assert.rejects(
      configureNativeFromStdin(
        installed.launcher,
        ["--prepare-all"],
        Readable.from([Buffer.from(JSON.stringify(configuration))]),
        {
          write() {
            assert.fail("Invalid package emitted a setup result.");
          },
        },
        { acquireState: async () => assert.fail("Invalid package acquired state.") },
      ),
      /installed agent availability is invalid/u,
    );
  }
});

const configuration = {
  schemaVersion: 1,
  classification: "nemoclaw-native-windows-agent-configuration",
  agent: "hermes",
  inference: "compatible",
  endpoint: "https://example.invalid/v1",
  model: "test-model",
  credentialStored: true,
  profile: "personal",
  options: { search: { provider: "tavily", credentialStored: true } },
};
const credentials = { inference: "new-inference", services: { tavily: "new-tavily" } };

test("browser choice initialization disables unavailable agents without fixing the model choice", () => {
  const script = stripTypeScriptTypes(
    fs.readFileSync(new URL("../onboarding/app.ts", import.meta.url), "utf8"),
  );
  for (const available of ["openclaw", "hermes", "neither"]) {
    const elements = new Map();
    const element = (key: string, dataset = {}) => {
      if (!elements.has(key))
        elements.set(key, {
          dataset,
          disabled: false,
          value: "",
          textContent: "",
          hidden: false,
          attributes: new Map(),
          events: new Map(),
          classList: { toggle() {} },
          setAttribute(name: string, value: string) {
            this.attributes.set(name, value);
          },
          getAttribute(name: string) {
            return this.attributes.get(name);
          },
          addEventListener(name: string, action: () => void) {
            this.events.set(name, action);
          },
          querySelector(selector: string) {
            return element(`${key} ${selector}`);
          },
        });
      return elements.get(key);
    };
    const cards = ["openclaw", "hermes"].map((agent) =>
      element(agent, {
        agent,
        packageSelectable: String(agent === available),
      }),
    );
    runInNewContext(script, {
      document: {
        querySelector: (selector: string) => element(selector),
        querySelectorAll: (selector: string) => (selector === "[data-agent]" ? cards : []),
      },
      window: { location: { search: "?agent=hermes" } },
      URLSearchParams,
      URL,
    });
    for (const card of cards) {
      assert.equal(card.disabled, card.dataset.agent !== available);
      assert.equal(card.getAttribute("aria-disabled"), String(card.disabled));
      assert.equal(card.getAttribute("aria-checked"), String(card.dataset.agent === available));
    }
    const absent = cards.find((card) => card.disabled)!;
    absent.events.get("click")();
    assert.equal(absent.getAttribute("aria-checked"), "false");
    assert.equal(element("#next").disabled, available === "neither");
    assert.equal(element("#launch").disabled, available === "neither");
    const model = element("#model");
    model.value = "user-chosen-model";
    if (available !== "neither") cards.find((card) => !card.disabled)!.events.get("click")();
    assert.equal(model.value, "user-chosen-model");
    assert.notEqual(model.readOnly, true);
  }
});

for (const included of ["openclaw", "hermes"] as const) {
  for (const [qualification, status] of [
    [false, "qualified"],
    [false, "unqualified"],
    [true, "unqualified"],
  ] as const) {
    test(`${included}-only browser setup enforces ${status} choices in ${qualification ? "qualification" : "normal"} mode`, async (t) => {
      const absent = included === "openclaw" ? "hermes" : "openclaw";
      const installed = nativePackageFixture(t.after.bind(t), {
        openclaw: included === "openclaw" ? status : "not-included",
        hermes: included === "hermes" ? status : "not-included",
      });
      const assets = path.join(installed.root, "app", "onboarding");
      fs.mkdirSync(assets, { recursive: true });
      fs.copyFileSync(
        new URL("../onboarding/index.html", import.meta.url),
        path.join(assets, "index.html"),
      );
      const previous = process.env.NEMOCLAW_NATIVE_RUNTIME_ROOT;
      process.env.NEMOCLAW_NATIVE_RUNTIME_ROOT = installed.root;
      t.after(() => {
        if (previous === undefined) delete process.env.NEMOCLAW_NATIVE_RUNTIME_ROOT;
        else process.env.NEMOCLAW_NATIVE_RUNTIME_ROOT = previous;
      });
      const server = await startOnboardingServer(
        installed.root,
        "",
        installed.root,
        qualification,
        installed.launcher,
      );
      try {
        const page = await fetch(server.url, { signal: AbortSignal.timeout(5000) });
        assert.equal(page.status, 200);
        assert.equal(readNativePackageAvailability(installed.root)[included], status);
        const html = await page.text();
        assert(html.includes(`data-agent="${included}" data-package-selectable="true"`));
        assert(html.includes(`data-agent="${absent}" data-package-selectable="false"`));
        const token = new URL(server.url).searchParams.get("session")!;
        const submit = (agent: string, session = token) =>
          fetch(`${server.origin}/api/configure`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-nemoclaw-session": session },
            body: JSON.stringify({ agent, inference: "qualification", options: {} }),
            signal: AbortSignal.timeout(5000),
          });
        const rejected = await submit(absent);
        assert.equal(rejected.status, 400);
        assert.match((await rejected.json()).message, /unavailable in this installer/u);
        assert.equal(server.selection(), null);
        assert.equal(server.runtimeConfiguration(), null);
        assert.equal(fs.existsSync(path.join(installed.root, "onboarding-selection.json")), false);
        const unauthenticated = await submit(included, "invalid-session");
        assert.equal(unauthenticated.status, 400);
        assert.match((await unauthenticated.json()).message, /session token is invalid/u);
        const selected = await submit(included);
        assert.equal(selected.status, qualification ? 200 : 400);
        if (qualification) {
          assert.equal((await selected.json()).redirect, `/launching.html?agent=${included}`);
          assert.equal(server.selection()?.agent, included);
          assert.equal(server.runtimeConfiguration()?.configPath, null);
        } else {
          // A selectable normal agent still cannot use qualification inference.
          assert.match((await selected.json()).message, /Select a valid inference provider/u);
          assert.equal(server.selection(), null);
        }
        assert.equal(readNativePackageAvailability(installed.root)[included], status);
      } finally {
        server.server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  }
}

test("unfinished credential recovery blocks launch and a full resave removes stranded provider keys", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-pending-configuration-"));
  const originalEnvironment = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  t.after(() => {
    if (originalEnvironment === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalEnvironment;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(root, "NVIDIA", "NemoClaw", "agents", "hermes");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "native-windows.json"), JSON.stringify(configuration));
  const attempted = {
    ...configuration,
    inference: "nvidia",
    endpoint: "https://integrate.api.nvidia.com/v1",
    options: {},
  };
  const stranded = nativeCredentialBinding(attempted);
  const previous = nativeCredentialBinding(configuration);
  const vault = new Map([[previous, "old-private-key"]]);
  let held = false;
  let failWrite = true;
  const dependencies = {
    lookupEndpoint: async () => [{ address: "8.8.8.8", family: 4 }],
    acquireState: async () => {
      assert.equal(held, false);
      held = true;
      return {
        stateRoot: root,
        created: false,
        removed: false,
        assertHeld() {
          assert.equal(held, true);
        },
        async release() {
          held = false;
        },
      };
    },
    credentialStore: {
      read: async (_launcher: string, change: { binding: string }) => {
        assert(held);
        assert(readNativeConfigurationRecovery(directory, "hermes"));
        assert.throws(() => readNativeAgentConfiguration("hermes"), /save is unfinished/);
        return vault.get(change.binding) ?? "";
      },
      write: async (_launcher: string, change: { binding: string; value: string }) => {
        assert(held);
        if (failWrite && !change.value) throw new Error("rollback could not finish");
        if (change.value) vault.set(change.binding, change.value);
        else vault.delete(change.binding);
        if (failWrite) throw new Error("write result unknown");
      },
    },
    readCredential: async () => "",
    readServices: async () => ({ options: {}, environment: {} }),
  };
  await assert.rejects(
    configureNativeFromStdin(
      packageFixture.launcher,
      ["--transaction"],
      Readable.from([
        Buffer.from(
          JSON.stringify({
            configuration: attempted,
            credentials: { inference: "nvapi-private-fixture", services: {} },
          }),
        ),
      ]),
      process.stdout,
      dependencies,
    ),
    /credential recovery is incomplete/,
  );
  assert.equal(held, false);
  assert.equal(vault.get(stranded), "nvapi-private-fixture");
  const pending = readNativeConfigurationRecovery(directory, "hermes");
  assert(pending);
  assert.equal(pending.writerProcessId, process.pid);
  assert.equal(pending.identities.length, 2);
  assert(!JSON.stringify(pending).includes("private"));
  assert.throws(() => readNativeAgentConfiguration("hermes"), /save is unfinished/);
  const restartedReader = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import {readNativeAgentConfiguration} from ${JSON.stringify(new URL("./native-setup-configuration.mts", import.meta.url).href)};
     try { readNativeAgentConfiguration("hermes"); process.exitCode=1; }
     catch (error) { process.exitCode=/save is unfinished/.test(error.message) ? 0 : 2; }`,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(restartedReader.status, 0, restartedReader.stderr);
  let observation = "";
  await configureNativeFromStdin(
    packageFixture.launcher,
    ["--recovery-status", "hermes"],
    Readable.from([]),
    {
      write(value: string | Uint8Array) {
        observation += value.toString();
        return true;
      },
    },
    dependencies,
  );
  assert.deepEqual(JSON.parse(observation), {
    schemaVersion: 1,
    kind: "native-configuration-recovery",
    agent: "hermes",
    state: "needs-resave",
    operationId: pending.operationId,
    writerProcessId: pending.writerProcessId,
  });
  assert.equal(held, false);
  assert.equal(
    readNativeConfigurationRecovery(directory, "hermes")?.operationId,
    pending.operationId,
  );
  const replacement = {
    ...configuration,
    inference: "local",
    endpoint: "http://127.0.0.1:12345/v1",
    model: "chosen-after-recovery",
    credentialStored: false,
    options: {},
  };
  await assert.rejects(
    configureNativeFromStdin(
      packageFixture.launcher,
      [],
      Readable.from([Buffer.from(JSON.stringify(replacement))]),
      process.stdout,
      dependencies,
    ),
    /complete Setup credential transaction/,
  );
  assert.equal(
    readNativeConfigurationRecovery(directory, "hermes")?.operationId,
    pending.operationId,
  );
  failWrite = false;
  await configureNativeFromStdin(
    packageFixture.launcher,
    ["--transaction"],
    Readable.from([
      Buffer.from(
        JSON.stringify({
          configuration: replacement,
          credentials: { inference: "", services: {} },
        }),
      ),
    ]),
    process.stdout,
    dependencies,
  );
  assert.equal(held, false);
  assert.equal(vault.size, 0);
  assert.equal(readNativeConfigurationRecovery(directory, "hermes"), null);
  assert.equal(readNativeAgentConfiguration("hermes").config.model, "chosen-after-recovery");
  observation = "";
  await configureNativeFromStdin(
    packageFixture.launcher,
    ["--recovery-status", "hermes"],
    Readable.from([]),
    {
      write(value: string | Uint8Array) {
        observation += value.toString();
        return true;
      },
    },
    dependencies,
  );
  assert.deepEqual(JSON.parse(observation), {
    schemaVersion: 1,
    kind: "native-configuration-recovery",
    agent: "hermes",
    state: "clear",
  });
});

test("configuration recovery status cannot claim completion without the configuration owner", async () => {
  const output = {
    write() {
      assert.fail("An unowned recovery status was published.");
      return false;
    },
  };
  await assert.rejects(
    configureNativeFromStdin(
      packageFixture.launcher,
      ["--recovery-status", "hermes"],
      Readable.from([]),
      output,
      {
        acquireState: async () => {
          throw new Error("configuration owner busy");
        },
      },
    ),
    /owner busy/,
  );
  await assert.rejects(
    configureNativeFromStdin(
      packageFixture.launcher,
      ["--recovery-status", "pi"],
      Readable.from([]),
      output,
      {
        acquireState: async () => assert.fail("A retired agent acquired recovery ownership."),
      },
    ),
    /recovery request is invalid/,
  );
});

test("web onboarding uses the canonical lease and never persists its secret or launch action", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-web-configuration-lease-"));
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  const configPath = path.join(
    root,
    "NVIDIA",
    "NemoClaw",
    "agents",
    "hermes",
    "native-windows.json",
  );
  const activePath = path.join(root, "NVIDIA", "NemoClaw", "active-agent.txt");
  const previous = {
    ...configuration,
    inference: "nvidia",
    endpoint: "https://integrate.api.nvidia.com/v1",
    options: { search: { provider: "tavily", credentialStored: true } },
  };
  const previousText = `${JSON.stringify(previous, null, 2)}\n`;
  const secret = "web-onboarding-secret";
  const webConfiguration: NativeOnboardingConfiguration = {
    agent: "hermes",
    inference: "compatible",
    endpoint: "https://example.invalid/v1",
    model: "new-model",
    credential: secret,
    options: {
      endpoint: "https://example.invalid/v1",
      model: "new-model",
      credential: secret,
      launch: "on",
      search: { provider: "tavily", credentialStored: true },
    },
  };
  let admit!: () => void;
  const admitted = new Promise<void>((resolve) => {
    admit = resolve;
  });
  let acquisitionStarted!: () => void;
  const acquiring = new Promise<void>((resolve) => {
    acquisitionStarted = resolve;
  });
  const events: string[] = [];
  const deletions: { provider: string; binding: string }[] = [];
  let submittedRecord: Record<string, unknown> | null = null;
  const configure: typeof configureNativeFromStdin = async (
    launcher,
    args = [],
    input = Readable.from([]),
  ) => {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk));
    const serialized = Buffer.concat(chunks).toString("utf8");
    const payload = JSON.parse(serialized);
    submittedRecord = payload.configuration;
    assert.equal(payload.credentials.inference, secret);
    assert(!JSON.stringify(submittedRecord).includes(secret));
    assert.deepEqual(args, ["--transaction"]);
    assert(!serialized.includes("launch"));
    events.push("configure");
    return await configureNativeFromStdin(
      launcher,
      args,
      Readable.from([Buffer.from(serialized)]),
      process.stdout,
      {
        lookupEndpoint: async () => [{ address: "8.8.8.8", family: 4 }],
        acquireState: async (_launcher, agent) => {
          assert.equal(agent, "hermes");
          events.push("acquire");
          acquisitionStarted();
          await admitted;
          return {
            stateRoot: "C:\\NemoClawState-S-1-5-21-1-hermes",
            created: false,
            removed: false,
            assertHeld() {
              events.push("held");
            },
            async release() {
              events.push("release");
            },
          };
        },
        readCredential: async () => {
          events.push("credential");
          return secret;
        },
        readServices: async (_launcher, agent, options) => {
          assert.equal(agent, "hermes");
          assert.deepEqual(options, {
            search: { provider: "tavily", credentialStored: true },
          });
          events.push("services");
          return { options: {}, environment: {} };
        },
        deleteCredential: async (_launcher, provider, binding) => {
          events.push(`delete:${provider}`);
          deletions.push({ provider, binding });
        },
        credentialStore: {
          read: async () => "",
          write: async (_launcher, change) => {
            if (change.value) {
              assert.equal(change.value, secret);
              events.push("credential-write");
            } else {
              events.push(`delete:${change.provider}`);
              deletions.push({ provider: change.provider, binding: change.binding });
            }
          },
        },
      },
    );
  };
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, previousText);
    fs.writeFileSync(activePath, "openclaw\n");
    const pending = saveNativeOnboardingConfiguration(packageFixture.launcher, webConfiguration, {
      configure,
    });
    await acquiring;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["configure", "acquire"]);
    assert.equal(fs.readFileSync(configPath, "utf8"), previousText);
    assert.equal(fs.readFileSync(activePath, "utf8"), "openclaw\n");
    assert.deepEqual((submittedRecord as { options?: unknown } | null)?.options, {
      search: { provider: "tavily", credentialStored: true },
    });
    admit();
    assert.equal(await pending, configPath);
    assert(events.indexOf("credential-write") > events.indexOf("held"));
    const persistedText = fs.readFileSync(configPath, "utf8");
    const persisted = JSON.parse(persistedText);
    assert.equal(persisted.agent, "hermes");
    assert.equal(persisted.inference, "compatible");
    assert.equal(persisted.credentialStored, true);
    assert.deepEqual(persisted.options, {
      search: { provider: "tavily", credentialStored: true },
    });
    assert(!persistedText.includes(secret));
    assert(!persistedText.includes("launch"));
    assert.equal(fs.readFileSync(activePath, "utf8"), "hermes\n");
    assert.deepEqual(deletions[0], {
      provider: "nvidia",
      binding: nativeCredentialBinding(previous),
    });
    assert.deepEqual(
      deletions.slice(1),
      Object.keys(NATIVE_SERVICES)
        .filter((provider) => provider !== "tavily")
        .map((provider) => ({
          provider,
          binding: nativeServiceBinding("hermes", provider),
        })),
    );
    assert.equal(events.at(-1), "release");
  } finally {
    admit();
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of [
  "none",
  "credential",
  "services",
  "active-pointer",
  "configuration-rollback",
]) {
  test(`setup transaction ${failure} binds credentials and configuration to one state lease`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-transaction-"));
    const previousEnvironment = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = root;
    const configPath = path.join(
      root,
      "NVIDIA",
      "NemoClaw",
      "agents",
      "hermes",
      "native-windows.json",
    );
    const activePath = path.join(root, "NVIDIA", "NemoClaw", "active-agent.txt");
    const previous = JSON.stringify({ ...configuration, model: "previous-model" });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, previous);
    fs.writeFileSync(activePath, "openclaw\n");
    const inferenceBinding = nativeCredentialBinding(configuration);
    const serviceBinding = nativeServiceBinding("hermes", "tavily");
    const initial = new Map([
      [inferenceBinding, "old-inference"],
      [serviceBinding, "old-tavily"],
    ]);
    const vault = new Map(initial);
    let held = false;
    let released = false;
    let writes = 0;
    let admit!: () => void;
    const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    });
    let acquiring!: () => void;
    const acquisitionStarted = new Promise<void>((resolve) => {
      acquiring = resolve;
    });
    const originalRename = fs.renameSync;
    let configurationRenames = 0;
    if (failure === "active-pointer" || failure === "configuration-rollback")
      t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
        if (to === activePath) throw new Error("simulated active-agent rename failure");
        if (to === configPath && ++configurationRenames > 1 && failure === "configuration-rollback")
          throw new Error("simulated configuration restoration failure");
        originalRename(from, to);
      });
    const input = Buffer.from(JSON.stringify({ configuration, credentials }));
    try {
      const pending = configureNativeFromStdin(
        packageFixture.launcher,
        ["--transaction"],
        Readable.from([input]),
        process.stdout,
        {
          lookupEndpoint: async () => [{ address: "8.8.8.8", family: 4 }],
          acquireState: async () => {
            acquiring();
            await admitted;
            held = true;
            return {
              stateRoot: root,
              created: false,
              removed: false,
              assertHeld() {
                assert(held);
              },
              async release() {
                held = false;
                released = true;
              },
            };
          },
          credentialStore: {
            read: async (_launcher, change) => {
              assert(held);
              return vault.get(change.binding) ?? "";
            },
            write: async (_launcher, change) => {
              assert(held);
              writes++;
              if (change.value) vault.set(change.binding, change.value);
              else vault.delete(change.binding);
              if (failure === "credential" && writes === 1) throw new Error("secret failure");
            },
          },
          readCredential: async () => {
            assert(held);
            return vault.get(inferenceBinding)!;
          },
          readServices: async () => {
            assert(held);
            assert.equal(vault.get(serviceBinding), "new-tavily");
            if (failure === "services") throw new Error("secret service failure");
            return { options: {}, environment: {} };
          },
        },
      );
      // Removal can keep this owner waiting; neither the vault nor configuration may move.
      await acquisitionStarted;
      assert.equal(writes, 0);
      assert.equal(fs.readFileSync(configPath, "utf8"), previous);
      admit();
      if (failure === "none") {
        assert.equal(await pending, configPath);
        assert.equal(vault.get(inferenceBinding), "new-inference");
        assert.equal(vault.get(serviceBinding), "new-tavily");
        assert.equal(fs.readFileSync(activePath, "utf8"), "hermes\n");
        const persisted = fs.readFileSync(configPath, "utf8");
        assert(!persisted.includes("new-inference"));
        assert(!persisted.includes("new-tavily"));
      } else {
        await assert.rejects(pending, /previous credentials were preserved/);
        assert.deepEqual(vault, initial);
        if (failure === "configuration-rollback") {
          assert(readNativeConfigurationRecovery(path.dirname(configPath), "hermes"));
          assert.throws(() => readNativeAgentConfiguration("hermes"), /save is unfinished/);
        } else assert.equal(fs.readFileSync(configPath, "utf8"), previous);
        assert.equal(fs.readFileSync(activePath, "utf8"), "openclaw\n");
      }
      assert(released);
      assert(input.every((byte) => byte === 0));
      assert.deepEqual(
        fs.readdirSync(path.dirname(configPath)).sort(),
        failure === "configuration-rollback"
          ? ["native-configuration-pending.json", "native-windows.json"]
          : ["native-windows.json"],
      );
    } finally {
      admit();
      t.mock.restoreAll();
      if (previousEnvironment === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previousEnvironment;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("malformed transaction keys fail before acquiring the state or mutating credentials", async () => {
  const malformed = Buffer.from('{"credentials":{"inference":"private-test-key"},invalid}');
  await assert.rejects(
    configureNativeFromStdin(
      packageFixture.launcher,
      ["--transaction"],
      Readable.from([malformed]),
    ),
    { message: "NemoClaw native Windows launch failed: native setup configuration is invalid" },
  );
  assert(malformed.every((byte) => byte === 0));
  for (const invalid of [
    { inference: "new-inference", services: {} },
    { inference: "new-inference", services: { tavily: "new-tavily", brave: "extra" } },
    { inference: "new-inference", services: { tavily: "bad\nkey" } },
    { inference: "", services: { tavily: "key" } },
    { inference: "new-inference", services: [] },
  ]) {
    await assert.rejects(
      configureNativeFromStdin(
        packageFixture.launcher,
        ["--transaction"],
        Readable.from([Buffer.from(JSON.stringify({ configuration, credentials: invalid }))]),
        process.stdout,
        { acquireState: async () => assert.fail("invalid transaction acquired the state") },
      ),
      /native setup/,
    );
  }
});
