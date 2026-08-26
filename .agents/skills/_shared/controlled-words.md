<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw Controlled Word List

This list defines approved NemoClaw technical terms for explanatory text.
It gives each term one project meaning and identifies alternatives that can make that meaning
unclear.

This list is not a general English dictionary. It does not copy the ASD-STE100 dictionary, and its
use does not establish ASD-STE100 compliance.

## Use the List

- Use the approved term with the meaning and form shown here.
- Treat an alternative as discouraged only when it refers to the same concept.
- Use a different term when it identifies a real difference. Define that difference at first use.
- Preserve literal identifiers, commands, output, API fields, quotations, and official third-party
  names.
- Apply the list to changed text. Report unrelated terminology debt in a focused follow-up.

## Product Names and Text Forms

| Use | Use as | Meaning | Avoid for this meaning |
|---|---|---|---|
| `AI` | Technical noun or adjective | Artificial intelligence. | A.I., ai in prose |
| `Amazon Bedrock` | Product name | The AWS managed foundation-model service. | Bedrock when the product is not already clear, amazon bedrock |
| `Anthropic` | Organization or provider name | Anthropic as an organization or inference provider. | anthropic in prose |
| `API` | Technical noun or adjective | An application programming interface. | Api, api in prose |
| `API key` | Technical noun | A credential whose type is an API key. | API Key, api key |
| `AppArmor` | Product name or adjective | The Linux mandatory-access-control system. | App Armor, apparmor in prose |
| `Apple silicon` | Platform name or adjective | Apple-designed Arm-based Mac hardware. | Apple Silicon, M-series Mac when the architecture matters |
| `ASD-STE100` | Standard name | The Simplified Technical English standard referenced by this project. | STE100, ASD STE 100 |
| `AWS` | Product-family name or adjective | Amazon Web Services. Write `Amazon Web Services (AWS)` at first use for an audience that might not know the abbreviation. | Aws, aws in prose |
| `Bash` | Shell name or adjective | The Bash command shell. Use `bash` for the command or a code-fence language. | BASH, bash when the shell name is intended |
| `Brave Search` | Product name | The Brave Search web search service. Use `Brave` after the full name is clear. | brave search, Brave on first use |
| `Brev` | Product name | The NVIDIA service used by deprecated remote-instance deployment flows and E2E infrastructure. | brev in prose |
| `CI` | Technical noun or adjective | Continuous integration. | ci, Ci |
| `CLI` | Technical noun | A command-line interface as a whole. | cli, Cli, command when one operation is intended |
| `Cloudflare Tunnel` | Product name | The Cloudflare service that exposes a configured dashboard through a named tunnel. | Cloudflare tunnel, cloudflared tunnel when the product is intended |
| `Colima` | Product name | The container runtime used by a supported macOS path. | colima in prose |
| `DCO` | Technical noun | The Developer Certificate of Origin declaration required for contributor PRs. | dco, sign-off when the declaration is intended |
| `DGX Spark` | Product name | The NVIDIA DGX Spark system. | Spark when the product is intended |
| `DGX Station` | Product name | The NVIDIA DGX Station system. | Station when the product is not already clear |
| `Discord` | Product name | The Discord messaging service. | discord in prose |
| `DNS` | Technical noun or adjective | The Domain Name System. | dns in prose |
| `Docker` | Product name or adjective | The Docker container platform. | docker in prose |
| `Docker Desktop` | Product name | The Docker Desktop application. | Docker desktop, docker desktop |
| `E2E` | Technical noun or adjective | End-to-end testing or evidence. Spell it out at first use when the audience is not expected to know the abbreviation. | e2e, E-2-E |
| `Fern` | Product name | The documentation platform that builds and publishes NemoClaw docs. | fern in prose |
| `Git` | Product name or adjective | The Git version-control system. Use `git` for the command. | git when the product is intended |
| `GitHub` | Product name or adjective | The GitHub hosting and collaboration service. | Github, github in prose |
| `GitHub Actions` | Product name | The GitHub workflow service. | GitHub actions, Github Actions |
| `Google Gemini` | Product or provider name | The Google Gemini inference provider. Use `Gemini` after the full name is clear. | google gemini, Gemini provider on first use |
| `GPU` | Technical noun or adjective | A graphics processing unit. | Gpu, gpu in prose |
| `Hermes` | Product name | The Hermes agent runtime. | hermes in prose |
| `Homebrew` | Product name or adjective | The macOS package manager and service path used by NemoClaw. Use `brew` for the command. | homebrew in prose, Brew when the product is intended |
| `HTTP` | Technical noun or adjective | Hypertext Transfer Protocol without TLS. | Http, http in prose |
| `HTTPS` | Technical noun or adjective | HTTP protected by TLS. | Https, https in prose |
| `Hugging Face` | Product or organization name | The Hugging Face model and package services. | HuggingFace, hugging face |
| `IP address` | Technical noun | An Internet Protocol address. | IP when an address is intended, IP Address |
| `JavaScript` | Language name or adjective | The JavaScript programming language. | Javascript, javascript in prose |
| `JSON` | Technical noun or adjective | The JSON data format. | Json, json in prose |
| `Kubernetes` | Product name or adjective | The Kubernetes orchestration platform. | K8s in explanatory prose, kubernetes |
| `Landlock` | Product name or adjective | The Linux Landlock filesystem-access control system. | landlock in prose |
| `LangChain Deep Agents Code` | Product name | The full product name. Use `Deep Agents Code` after the full name is clear. | DeepAgents Code, deep agents code in prose |
| `Linux` | Operating-system name or adjective | The Linux operating system. | linux in prose |
| `macOS` | Operating-system name or adjective | The Apple macOS operating system. | MacOS, Mac OS, OSX |
| `Markdown` | Format name or adjective | Markdown source or output. | markdown in prose |
| `MCP` | Technical noun or adjective | Model Context Protocol. Write the full name at first use on a page, followed by `(MCP)`. | mcp in prose |
| `MDX` | Technical noun or adjective | Markdown with JSX syntax. | Mdx, mdx in prose |
| `Microsoft Teams` | Product name | The Microsoft Teams messaging service. Use `Teams` after the full name is clear. | MS Teams, microsoft teams |
| `mTLS` | Technical noun or adjective | Mutual TLS authentication. | MTLS, mtls |
| `NemoClaw` | Product name | The NVIDIA reference stack in this repository. | nemoclaw or Nemoclaw in prose |
| `Nemotron` | Model-family name | The NVIDIA Nemotron model family. | nemotron in prose |
| `NGC` | Product name or adjective | The NVIDIA NGC catalog and registry services. | Ngc, ngc in prose |
| `Node.js` | Runtime name or adjective | The Node.js JavaScript runtime. | NodeJS, Node, node.js in prose |
| `npm` | Product or command name | The npm package manager and registry. | NPM, Npm |
| `NVIDIA` | Organization name or adjective | NVIDIA as an organization or product modifier. | Nvidia, nvidia |
| `NVIDIA NIM` | Product name | NVIDIA NIM inference software. Use `NIM` after the full name is clear. | Nvidia NIM, NIM on first use |
| `Ollama` | Product name or adjective | The Ollama local inference server. | ollama in prose |
| `OpenAI` | Organization or provider name | OpenAI as an organization or inference provider. | Open AI, openai in prose |
| `OpenClaw` | Product name | The OpenClaw agent runtime. | openclaw or Openclaw in prose |
| `OpenRouter` | Product or provider name | The OpenRouter inference service. | Open Router, openrouter in prose |
| `OpenShell` | Product name | The NVIDIA sandbox runtime and policy platform. | Open Shell, openShell, Openshell, openshell |
| `PyPI` | Product name | The Python Package Index. | Pypi, pypi in prose |
| `Python` | Language name or adjective | The Python programming language. | python in prose |
| `QR code` | Technical noun | A quick-response code used for device or channel pairing. | QR Code, qr code |
| `Slack` | Product name | The Slack messaging service. | slack in prose |
| `SSH` | Technical noun or adjective | Secure Shell remote access. | ssh in prose |
| `SSRF` | Technical noun or adjective | Server-side request forgery. Write the full term at first use on a page, followed by `(SSRF)`. | Ssrf, ssrf in prose |
| `Tavily Search` | Product name | The Tavily web search service. Use `Tavily` after the full name is clear. | tavily search, Tavily on first use |
| `TCP` | Technical noun or adjective | Transmission Control Protocol. | Tcp, tcp in prose |
| `Telegram` | Product name | The Telegram messaging service. | telegram in prose |
| `TLS` | Technical noun or adjective | Transport Layer Security. | Tls, tls in prose |
| `TUI` | Technical noun | A terminal user interface. | Tui, tui in prose |
| `TypeScript` | Language name or adjective | The TypeScript programming language. | Typescript, typescript in prose |
| `Ubuntu` | Operating-system name or adjective | The Ubuntu Linux distribution. | ubuntu in prose |
| `UI` | Technical noun | A user interface. | Ui, ui in prose |
| `URL` | Technical noun | A uniform resource locator. | Url, url in prose |
| `Vitest` | Product name or adjective | The Vitest test runner. | vitest in prose |
| `vLLM` | Product name or adjective | The vLLM inference server. | VLLM, vllm in prose |
| `WeChat` | Product name | The WeChat messaging service. | Wechat, wechat in prose |
| `WhatsApp` | Product name | The WhatsApp messaging service. | Whatsapp, whatsapp in prose |
| `Windows` | Operating-system name or adjective | The Microsoft Windows operating system. | windows in prose |
| `WSL` | Technical noun or adjective | Windows Subsystem for Linux. Write the full name at first use on a page, followed by `(WSL)`. | Wsl, wsl in prose |
| `YAML` | Technical noun or adjective | The YAML data format. | yaml, Yaml |

Lowercase forms remain correct in commands, package names, file paths, environment variables, and
other literal identifiers.

## Product Concepts

| Use | Use as | Meaning | Avoid for this meaning |
|---|---|---|---|
| `agent` | Technical noun | Software that uses a model and tools to do tasks. Add `coding`, `supported`, or another modifier when the agent type matters. | assistant, bot, workload |
| `agent runtime` | Technical noun | Software that implements agent behavior, such as OpenClaw, Hermes, or Deep Agents Code. | agent framework, harness |
| `best-effort` | Adjective | Attempts a named control or operation without guaranteeing that it succeeds or remains enforced. State the failure or fallback result. | guaranteed, enforced |
| `blueprint` | Technical noun | The versioned YAML package that defines the sandbox shape, policies, inference profiles, and supporting assets. | template, recipe, configuration |
| `command` | Technical noun | One named CLI operation or a complete invocation. | CLI when one operation is intended |
| `compatible` | Adjective | Satisfies a stated technical contract. Compatibility alone does not establish product support. | supported |
| `configuration` | Technical noun | The settings that define behavior. Use `config` only in literal names or when the interface uses that label. | config in explanatory prose, setup |
| `container` | Technical noun | An implementation-level operating-system container. Use `sandbox` for the OpenShell resource exposed to users. | sandbox when the interface-level resource is intended |
| `credential` | Technical noun | Secret authentication material, including an API key, token, or password. Use the specific type when known. | key, API key when the type is unknown |
| `default sandbox` | Technical noun | The sandbox selected when the user does not supply a sandbox name. | primary sandbox, main sandbox |
| `endpoint` | Technical noun | A network destination that exposes an API. | provider, model, route |
| `gateway` | Technical noun | A service that coordinates requests for a runtime. Use `OpenShell gateway` or `agent gateway` when the type is not clear. | server, control plane |
| `host` | Technical noun or adjective | The environment outside the sandbox that runs the CLI and host-side services. | local machine, workstation |
| `inference provider` | Technical noun | A named service configuration that selects and authenticates an inference service. | backend, endpoint, model provider |
| `inference route` | Technical noun | The gateway-managed path from `inference.local` to the selected provider and model. | endpoint, provider |
| `integration layer` | Technical noun | Agent-specific configuration, plugins, wrappers, and runtime support that connect an agent runtime to OpenShell. | plugin when the integration is not a plugin |
| `manifest` | Technical noun | A declarative file that defines a project resource or supported integration. Name the manifest type at first use. | configuration file when the contract is a manifest |
| `messaging channel` | Technical noun | A supported messaging service through which an agent sends or receives messages. | messaging integration, connector |
| `model` | Technical noun | The model selection served through an inference provider. | provider, endpoint |
| `NemoClaw-managed` | Adjective | A resource whose lifecycle or configuration NemoClaw controls. | NemoClaw resource when ownership is unclear |
| `network policy` | Technical noun | Rules that control sandbox network egress. | firewall, allowlist, egress rules when the complete policy is intended |
| `plugin` | Technical noun | A package loaded through an agent runtime's plugin mechanism. | integration layer, extension |
| `policy preset` | Technical noun | A named set of policy entries that an operator can apply. Use `preset` after the full term is clear. | policy template, network preset |
| `resource` | Technical noun | A named object whose lifecycle a system manages. Use the specific resource type when known. | asset, thing |
| `sandbox` | Technical noun | The isolated OpenShell runtime resource in which the selected agent runs. | container or pod when the interface-level resource is intended |
| `supported` | Adjective | Approved as a NemoClaw product surface with defined ownership, lifecycle, compatibility, security, and validation expectations. | compatible, works with |
| `workspace` | Technical noun | The directory tree available to the agent for user files and task state. | working directory when the broader tree is intended |

## Runtime and Architecture

| Use | Use as | Meaning | Avoid for this meaning |
|---|---|---|---|
| `agent gateway` | Technical noun | The agent runtime service inside a sandbox that accepts agent requests. | OpenShell gateway, gateway when the type is unclear |
| `agent manifest` | Technical noun | The repository manifest that defines one supported agent runtime and its lifecycle integration. | agent configuration, runtime manifest |
| `base image` | Technical noun | The image from which NemoClaw builds an agent sandbox image. | parent image, default image |
| `blueprint runner` | Technical noun | The process that applies the NemoClaw blueprint and reconciles sandbox resources and agent-runtime lifecycle. | runner without the modifier, driver, agent runtime |
| `build context` | Technical noun | The files available to an image build. | build directory when file availability is intended |
| `build-time setting` | Technical noun | A value applied while NemoClaw builds an image. | runtime setting, build config |
| `dashboard` | Technical noun | The browser interface exposed by an agent runtime. | UI when the browser interface is intended |
| `driver` | Technical noun | An OpenShell compute implementation that creates and operates sandbox runtimes, such as the Docker driver. | agent driver, adapter |
| `gateway port` | Technical noun | A network port on which a named gateway listens. Name the gateway when needed. | service port when the gateway is intended |
| `host-side` | Adjective | Runs or exists on the host, outside a sandbox. | local, external |
| `in-sandbox` | Adjective | Runs or exists inside a sandbox. | internal, container-side |
| `lifecycle authority` | Technical noun | The component that owns create, start, stop, update, and delete decisions for a resource. | owner without the lifecycle responsibility |
| `locked npm cache seed` | Technical noun | The complete, integrity-verified set of registry archives reachable from one npm lockfile for a selected platform. | BuildKit cache, npm cache when the verified archive set is intended |
| `OpenShell gateway` | Technical noun | The host service that owns credentials, coordinates sandbox lifecycle, and proxies approved traffic. | agent gateway, gateway when the type is unclear |
| `port forward` | Technical noun or verb | A connection that maps a host port to a service inside a sandbox, or the act of creating that connection. | tunnel when no general tunnel exists |
| `provider profile` | Technical noun | An OpenShell declaration of one service provider's credentials, endpoints, allowed binaries, and access policy. | inference profile, provider settings |
| `runtime provider state mutation` | Technical noun | A bounded, provider-mediated protection transition or restore operation whose selected state, projection digest, active fence, and recovery contract are explicit. | state mutation without the runtime provider modifier, lifecycle mutation |
| `runtime setting` | Technical noun | A value applied when a process or sandbox runs. | build-time setting, runtime config |
| `sandbox image` | Technical noun | The built image used to create an agent sandbox. | base image, container |
| `sandbox registry` | Technical noun | NemoClaw state that records managed sandboxes and their selected agent types. | image registry, container registry |
| `service` | Technical noun | A long-running process that exposes a defined capability. Name the service at first use. | daemon unless the implementation detail matters |
| `state directory` | Technical noun | A directory reserved for persistent project or runtime state. | data folder, config directory |
| `terminal agent` | Technical noun | An agent whose primary user interface is an interactive terminal session. | terminal runtime |
| `terminal runtime` | Technical noun | The in-sandbox process environment that hosts a terminal agent. | terminal agent |

## Inference and Models

| Use | Use as | Meaning | Avoid for this meaning |
|---|---|---|---|
| `Anthropic Messages API` | Technical noun | The Anthropic request and response contract used by a compatible inference endpoint. | Anthropic API when the API family matters |
| `API family` | Technical noun | A request and response contract, such as Chat Completions, Responses, or Anthropic Messages. | provider, endpoint |
| `Chat Completions API` | Technical noun | The OpenAI-compatible chat completions request and response contract. | OpenAI API when the API family matters, chat API |
| `compatible endpoint` | Technical noun | A custom endpoint that implements a selected API family closely enough for NemoClaw validation. | supported provider, OpenAI endpoint |
| `context window` | Technical noun | The maximum combined input and output token capacity configured for a model. | context size, context length in explanatory prose |
| `custom endpoint` | Technical noun | A user-supplied inference endpoint that is not one of NemoClaw's named provider choices. | compatible endpoint before compatibility is validated |
| `hosted inference` | Technical noun | Inference served by a remote provider-operated service. | local inference, cloud model |
| `inference` | Technical noun | Model execution that produces a response from an input. | AI, generation when model execution is intended |
| `inference health` | Technical noun | The classification reported for a sandbox's inference route: the `inference.local` `/v1/models` probe result, and, when that route is reachable and the sandbox records a provider and a model, the result of one inference request sent over the same route. Values are `healthy`, `unauthorized`, `reachable`, `unhealthy`, `unreachable`, and `not probed`. | model health, successful inference |
| `inference profile` | Technical noun | A blueprint selection that defines an inference provider type, provider name, endpoint, model, credential input, and route settings. | provider profile, model profile |
| `inference request` | Technical noun | One request sent through an inference route to a model. | API call when the inference purpose matters |
| `inference route reachability` | Technical noun | The `reachable` inference-health result produced when `https://inference.local/v1/models` returns HTTP `200` through `499`. It does not establish valid credentials, successful model invocation, readiness, compatibility, or support. | inference health, successful inference, validation request |
| `live route` | Technical noun | The provider and model route currently configured on the OpenShell gateway. | recorded route, active endpoint |
| `local inference` | Technical noun | Inference served by a model runtime that the operator runs locally. | hosted inference, local model when the service is intended |
| `managed inference` | Technical noun | Inference routed through OpenShell so the sandbox does not hold the upstream provider credential. | direct inference, hosted inference |
| `model capability` | Technical noun | A supported model behavior, such as tool calls, reasoning, or web search. | feature without naming the model behavior |
| `model ID` | Technical noun | The provider-defined identifier used to select a model. | model name when an identifier is required |
| `Model Router` | Product component name | The host-side router that selects among configured upstream models. | model gateway, router when the component is not clear |
| `output token` | Technical noun | A token generated in a model response. | completion token unless the API uses that field name |
| `provider credential` | Technical noun | A credential registered with OpenShell for one inference provider. | API key when the credential type is not known |
| `reasoning effort` | Technical noun | The configured amount of reasoning work requested from a compatible model. | reasoning level, thinking budget |
| `reasoning mode` | Technical noun | The endpoint-specific mechanism used to request or return model reasoning. | reasoning effort when the mechanism is intended |
| `recorded route` | Technical noun | The provider and model route stored for a sandbox. | live route, saved endpoint |
| `Responses API` | Technical noun | The OpenAI-compatible responses request and response contract. | OpenAI API when the API family matters, response API |
| `route drift` | Technical noun | A difference between a sandbox's recorded route and the gateway's live route. | configuration drift without naming the route |
| `routed inference` | Technical noun | Inference traffic sent through the managed `inference.local` route. | direct inference, proxied AI |
| `streaming response` | Technical noun | A response delivered incrementally before the complete result is available. | live response, streamed output |
| `upstream endpoint` | Technical noun | The provider endpoint that OpenShell or Model Router contacts on behalf of a sandbox. | sandbox endpoint, route |
| `validation request` | Technical noun | An authenticated model request used to check a named endpoint, API family, model, and request shape. One success does not establish broader API conformance. | health check, smoke test |
| `warm-up` | Technical noun or adjective | A bounded preparatory request or session that loads a model or starts a runtime before user work. | validation when no contract is checked, warmup |
| `web search` | Technical noun | A model or agent capability that retrieves current information from the web. | browsing, internet access |

## Security and Policy

| Use | Use as | Meaning | Avoid for this meaning |
|---|---|---|---|
| `allowlist` | Technical noun or verb | An explicit set of allowed values, or the act of adding a value to that set. | whitelist |
| `baseline policy` | Technical noun | The agent-specific network policy applied before operator-selected presets and approvals. | default policy, base policy |
| `credential-bearing` | Adjective | Contains or can expose credential material. | secret when the content can include more than one secret type |
| `credential binding` | Technical noun | Metadata that associates a managed route or placeholder with a stored credential. | credential, mapping |
| `credential custody` | Technical noun | Responsibility for storing and controlling access to a credential value. | credential ownership |
| `credential-free` | Adjective | Contains no credential material and does not grant credential access. | safe, non-secret when absence of credentials is the claim |
| `credential placeholder` | Technical noun | A non-secret value that OpenShell replaces with a credential at an approved request boundary. | fake key, dummy credential |
| `credential rewrite` | Technical noun | Replacement of a credential placeholder with a stored credential during an approved request. | credential injection, secret substitution |
| `deny by default`; `deny-by-default` | Technical phrase; adjective | Block access unless a rule explicitly allows it. Use the hyphenated form before a noun. | default deny, closed by default |
| `DNS pinning` | Technical noun | Binding an approved hostname to validated address results to prevent resolution changes from bypassing policy. | DNS lock, host pinning |
| `egress` | Technical noun or adjective | Network traffic that leaves a sandbox. | outbound access when the policy direction matters |
| `egress rule` | Technical noun | One network-policy rule that controls outbound traffic. | network policy when one entry is intended |
| `endpoint rule` | Technical noun | A policy entry that matches a destination and its permitted protocol details. | endpoint, allowlist entry |
| `fail closed`; `fail-closed` | Technical phrase; adjective | Reject or stop an operation when required security evidence is absent or invalid. Use the hyphenated form before a noun. | fail safe, abort securely |
| `filesystem policy` | Technical noun | Rules that control sandbox access to filesystem paths. | file permissions when the complete policy is intended |
| `least privilege` | Technical noun | Grant only the access required for the stated operation. | minimal permissions, locked down |
| `link-local address` | Technical noun | An IP address valid only on the directly connected network segment. | local address, private IP address |
| `lockdown` | Technical noun | The protected filesystem, process, and restrictive network-policy posture restored by Shields up. | hardening, shields when the resulting posture is intended |
| `loopback address` | Technical noun | An IP address that refers to the same network host. | localhost when an address is intended, local address |
| `network namespace` | Technical noun | The operating-system isolation boundary for network devices, routes, and sockets. | network sandbox, container network |
| `policy` | Technical noun | Enforceable rules that allow, deny, or constrain an operation. Name the policy type at first use. | configuration, settings |
| `policy entry` | Technical noun | One declarative rule in a policy. | policy when one rule is intended, item |
| `policy key` | Technical noun | The stable identifier of a policy entry. | policy name, endpoint name |
| `policy tier` | Technical noun | A named network-policy posture offered during onboarding. | security level, policy mode |
| `private IP address` | Technical noun | An address in an IP range reserved for private networks. | local IP address, link-local address |
| `raw TLS passthrough` | Technical noun | Forwarding encrypted TLS bytes without application-layer inspection or credential rewriting. | HTTPS proxying, TLS termination |
| `read-only` | Adjective | Permits reads but not writes. | readonly, immutable unless change is impossible by design |
| `read-write` | Adjective | Permits both reads and writes. | writable when read access also matters |
| `redaction` | Technical noun | Removal or replacement of sensitive content before display, logging, or storage. | masking, sanitization |
| `root-owned` | Adjective | Owned by the operating-system root account. | privileged, protected |
| `sandbox boundary` | Technical noun | The isolation boundary between sandbox processes and host or external resources. | container boundary, security boundary without naming the sandbox |
| `seccomp` | Technical noun or adjective | Linux system-call filtering enforced for sandbox processes. | syscall sandbox, seccomp-BPF in general prose |
| `secret` | Technical noun or adjective | Sensitive authentication or cryptographic material that must not be exposed. | credential when the value is not used for authentication |
| `Shields down` | Product state or command name | The temporary state that relaxes selected NemoClaw lockdown controls. | permissive state, unlocked mode |
| `shields-down window` | Technical noun | The bounded time during which Shields down remains active before automatic restoration. | maintenance window, unlock period |
| `Shields up` | Product state or command name | The state that enforces NemoClaw lockdown controls. | secure mode, locked state |
| `trust boundary` | Technical noun | A boundary across which data or control changes its trust assumptions. | security boundary without naming the trust change |
| `trusted` | Adjective | Explicitly accepted as an input, identity, or component within a named trust boundary. | safe, secure |
| `untrusted` | Adjective | Not accepted as authoritative or safe without validation at a named trust boundary. | unsafe, external |

## Messaging and Tools

| Use | Use as | Meaning | Avoid for this meaning |
|---|---|---|---|
| `agent adapter` | Technical noun | The agent-specific integration that writes a managed MCP endpoint into an agent runtime's native configuration. | MCP bridge, MCP proxy, relay |
| `channel manifest` | Technical noun | The declarative record of messaging-channel packages, credentials, reachability, and policy requirements. | channel configuration, integration manifest |
| `channel reachability check` | Technical noun | A test that confirms required messaging-channel endpoints are reachable through the active network policy. | generic reachability check, health check |
| `direct message` | Technical noun | A message addressed to one user or one private conversation. Use `DM` only after the term is clear. | private message when the channel calls it a direct message |
| `group message` | Technical noun | A message addressed to a multi-user conversation. | channel message when the service does not use channels |
| `managed MCP` | Technical noun or adjective | MCP access configured and mediated by NemoClaw and OpenShell. | built-in MCP, secure MCP |
| `MCP server` | Technical noun | A service that exposes tools through Model Context Protocol. | tool server, MCP provider |
| `MCP tool` | Technical noun | One callable operation exposed by an MCP server. | function, command |
| `messaging credential` | Technical noun | A credential used to authenticate a messaging channel. | channel key, bot token when the credential type is not known |
| `messaging relay` | Technical noun | A service that forwards messages between a messaging provider and an agent runtime. | API relay, dashboard relay, proxy |
| `public webhook` | Technical noun | A webhook endpoint reachable from the public internet. | public callback, open webhook |
| `sender allowlist` | Technical noun | The set of users or accounts allowed to send messages to an agent. | user whitelist, approved senders |
| `tool call` | Technical noun | One structured request from a model or agent to invoke a tool. | function call unless the API uses that term |
| `tool discovery` | Technical noun | Retrieval of the tools available from a configured tool service. | tool listing, capability scan |
| `webhook` | Technical noun | An HTTP endpoint that receives event callbacks from another service. | callback, hook |

## Lifecycle Operations

| Use | Use as | Meaning | Avoid for this meaning |
|---|---|---|---|
| `backup` | Technical noun or verb | The process that creates recoverable copies of one or more sandboxes. Use `snapshot` for each resulting bundle. | snapshot when the artifact is intended |
| `cleanup` | Technical noun | Removal of temporary, obsolete, or failed-operation artifacts. Name what is removed. | delete, destroy |
| `connect` | Technical verb | Establish an interactive session with a sandbox agent and restore required route or pairing state. | log in, attach |
| `create` | Technical verb | Make a new named resource without replacing an existing resource. | provision, generate |
| `delete` | Technical verb | Remove a named subordinate object, record, or file. Use `destroy` for a sandbox. | destroy when a sandbox is intended, remove when deletion is guaranteed |
| `destroy` | Technical verb | Stop and delete a named sandbox and remove its registry entry through the `destroy` command. | delete, uninstall |
| `doctor` | Technical noun or adjective | The diagnostic command or report that checks host and NemoClaw readiness. | health check, diagnostics command |
| `download` | Technical verb or noun | Transfer selected files from a sandbox to the host. | export, back up |
| `fresh onboarding` | Technical noun | Onboarding that discards the saved session, starts the wizard again, and reruns base-image resolution. It can later reuse or recreate a matching live sandbox. | clean install, guaranteed new sandbox |
| `health check` | Technical noun | A bounded check that reports whether a service or route responds as required. | readiness check when ability to begin work is intended, validation request |
| `install` | Technical verb or noun | Add NemoClaw software and required host components. | onboard, set up when the install operation is intended |
| `onboard`; `onboarding` | Technical verb; technical noun | Collect configuration and create or update the gateway, provider, policy, and sandbox resources. | install, setup, wizard |
| `persistence` | Technical noun | The property that named state remains available across specified lifecycle operations. Always name the lifecycle boundary. | permanent storage, persists without a boundary |
| `preflight` | Technical noun or adjective | A check performed before an operation to reject unmet prerequisites without beginning the operation. | pre-check, validation when no operation follows |
| `readiness check` | Technical noun | A check that verifies a service or resource can begin its intended work. | health check when basic responsiveness is intended |
| `rebuild` | Technical verb or noun | Recreate a sandbox container or image while preserving the supported state defined by the agent manifest. | reinstall, refresh, restart |
| `reconcile` | Technical verb | Bring observed resource state into agreement with recorded or desired state. | sync, refresh |
| `recover` | Technical verb | Repair a stopped or degraded agent runtime and its sandbox-scoped forwards. | rebuild, restart |
| `recreate` | Technical verb | Replace a resource by deleting and creating it again with the intended configuration. | restart, rebuild when state preservation is guaranteed |
| `remediation` | Technical noun | A specific action that corrects a verified failure or risk. | fix without naming the action, workaround |
| `rerun` | Technical verb or noun | Run a complete command, check, test, or workflow again from its start. | re-run, retry when only the failed operation repeats |
| `reset` | Technical verb or noun | Clear a named setting, credential, or state record so it can be established again. | delete, restore defaults without naming the target |
| `restart` | Technical verb or noun | Stop and start an existing process or service without replacing its configuration or resource identity. | rebuild, recreate |
| `restore` | Technical verb or noun | Apply state from a snapshot to a target sandbox. | recover, import |
| `resume` | Technical verb | Continue from recorded progress after a pause, interruption, or failed checkpoint without starting the complete workflow again. | restart, rerun |
| `retry` | Technical verb or noun | Attempt the same operation again after it did not complete. | rerun when the complete workflow starts again |
| `rollback` | Technical noun or verb | Return to a verified earlier state after an incomplete or unsafe change. | restore when applying a snapshot, revert when changing source text |
| `set up`; `setup` | Technical verb; noun or adjective | Use `set up` for the action and `setup` for a thing or state. Preserve `setup` in literal command names. | setup as a verb, set-up as a noun |
| `snapshot` | Technical noun or verb | A versioned bundle of manifest-declared sandbox state and rebuild metadata, or the act of creating it. | backup when one stored artifact is intended |
| `start` | Technical verb or noun | Begin an existing stopped process, service, or sandbox without replacing it. | create, restart |
| `state` | Technical noun | Recorded data that persists resource configuration or runtime information across commands. | status when the current condition is intended |
| `status` | Technical noun | The reported current condition of a resource, service, command, or check. | state when persistent data is intended |
| `stop` | Technical verb or noun | End a running process, service, or sandbox while preserving its managed resource. | destroy, delete |
| `uninstall` | Technical verb or noun | Remove NemoClaw host software and managed resources according to the selected uninstall options. | destroy, delete |
| `update` | Technical verb or noun | Refresh the installed NemoClaw host software without by itself rebuilding registered sandboxes. | upgrade sandboxes, reinstall |
| `upgrade` | Technical verb or noun | Move a named installed component or managed resource to a newer version. Name the target. | update when only host software refresh is intended |
| `upload` | Technical verb or noun | Transfer selected files from the host to a sandbox. | import, restore |

Use a literal command name when it is more precise than the general operation.
For a persistence claim, name the applicable `stop` and `start`, `restart`, `rebuild`, `recreate`,
`snapshot` and `restore`, or `destroy` boundary.

## Engineering and Release Evidence

| Use | Use as | Meaning | Avoid for this meaning |
|---|---|---|---|
| `accepted design decision` | Technical noun | A recorded maintainer decision that establishes product scope and its ownership, lifecycle, compatibility, security, and validation expectations. | proposal, design idea |
| `accepted issue` | Technical noun | An issue with an explicit maintainer decision that establishes the requested product scope. Open or assigned state alone is not acceptance. | open issue, approved request without evidence |
| `advisory` | Adjective or technical noun | Information that does not change a gate, approval, or merge state. | warning when no risk requires attention |
| `Announcement` | Technical noun | The post-tag release communication. | release entry |
| `approval-ready` | Adjective | All product, contributor, CI, merge-state, review, and test gates pass. | ready, good to go |
| `base SHA` | Technical noun | The target-branch commit used to evaluate the PR. | current base without a SHA |
| `behavior test` | Technical noun | A test named and organized around externally observable behavior. | implementation test, test case without the behavior |
| `blocked` | Adjective | A named decision, dependency, access problem, or input prevents progress. | stuck, cannot proceed without a reason |
| `blocking finding` | Technical noun | A finding that meets a defined condition preventing approval or merge. | concern, preference |
| `changed text` | Technical noun | Explanatory text added or modified by the diff. | the whole file when unchanged text is out of scope |
| `changelog` | Technical noun | The chronological collection of dated release entries. | release entry when one dated record is intended |
| `check` | Technical noun or verb | A named automated or manual evaluation that produces a result. | test when executable behavior is intended, gate when no policy requires it |
| `code-changing PR` | Technical noun | A PR that changes executable code, build inputs, policy, or behavior-affecting configuration. | code PR, feature PR |
| `commit` | Technical noun or verb | A Git revision, or the act of recording one. | change when a specific revision is intended |
| `commit SHA` | Technical noun | The immutable Git object identifier for a commit. | commit ID, hash when the object type matters |
| `commit under review` | Technical noun | The commit whose diff and evidence the reviewer evaluates. | head, review head, reviewed head |
| `contributor` | Technical noun | A person or agent that proposes or authors a repository change. | developer, submitter |
| `docs build` | Technical noun | The repository command and result that validate and render the documentation source. | docs test, site build |
| `documentation-only PR` | Technical noun | A PR whose diff changes explanatory documentation but no executable or behavior-affecting source. | docs PR when scope is not clear |
| `documentation writer review` | Technical noun | The independent review that checks a workflow-produced documentation candidate or direct documentation-only change against repository writing and documentation rules. | docs review, writing pass |
| `E2E test` | Technical noun | A test that exercises a complete user journey across integrated components. | integration test when the full journey is not exercised |
| `evidence` | Technical noun | A reproducible result or artifact tied to the revision, environment, and claim it supports. | proof without the supporting result, observation |
| `feature branch` | Technical noun | A non-default Git branch that contains one proposed change. | working branch, PR branch before a PR exists |
| `finding` | Technical noun | A review result that states an observed problem, its evidence, and the required or suggested action. | note, comment |
| `generated page` | Technical noun | A documentation page produced from source content and not edited directly. | source page, generated docs when one file is intended |
| `guide variant` | Technical noun | One agent-specific rendering of shared documentation source. | copy, flavor |
| `integration test` | Technical noun | A test of behavior across two or more real project components with external services mocked or isolated as required. | unit test, E2E test |
| `issue` | Technical noun | A tracked problem, request, or decision record in the repository. | ticket, bug when the issue type is not known |
| `latest PR commit` | Technical noun | The commit to which the PR source branch currently points. | current head, latest head, head when the Git object is intended |
| `live E2E` | Technical noun or adjective | An opt-in E2E test that changes real external state. | integration test, end-to-end test without the live qualifier |
| `maintainer` | Technical noun | A person with repository authority to make the stated project decision or action. | owner unless ownership is established, admin |
| `Markdown route` | Technical noun | A documentation URL that serves the page content in Markdown form for AI clients. | Markdown page, raw file URL |
| `merge state` | Technical noun | GitHub's reported ability to merge a PR and the reason when it cannot merge. | merge status, CI status |
| `package contract` | Technical noun | A testable requirement of the compiled or published package artifact. | integration contract, package test |
| `passing` | Adjective | A command exited with status 0, or a check concluded with `SUCCESS`. | green when the result is not named |
| `PR` | Technical noun | A GitHub pull request. Write `pull request (PR)` at first use for an audience that might not know the abbreviation. | change request, merge request |
| `pre-commit hook` | Technical noun | A repository hook that runs before Git records a commit. | precommit, lint hook |
| `pre-push hook` | Technical noun | A repository hook that runs before Git sends commits to a remote. | push hook, CI check |
| `regression test` | Technical noun | A test that fails for a previously observed defect and passes when the defect is corrected. | bug test, reproduction only |
| `release` | Technical noun or verb | A versioned distribution of NemoClaw, or the act of publishing it. | tag when publication is not established |
| `release entry` | Technical noun | The dated `docs/changelog/YYYY-MM-DD.mdx` record created before the tag. | release notes when the dated entry is intended, Announcement |
| `release label` | Technical noun | A repository label that assigns an issue or PR to a target release. | version label, milestone |
| `release tag` | Technical noun | The signed or annotated Git tag that identifies a published version. | version, release when the Git object is intended |
| `release train` | Technical noun | The planned group of work targeted to one release version. | sprint, milestone |
| `required check` | Technical noun | A named GitHub check required by repository policy. | CI gate when no check is named |
| `review` | Technical noun or verb | An evaluation of a change against defined scope and acceptance criteria. Name the review type when it matters. | look over, audit unless it is an audit |
| `route-style link` | Technical noun | A relative documentation link written as a published route instead of a source filename. | file link, extensionless link |
| `source page` | Technical noun | An author-maintained documentation file from which one or more pages are built. | generated page, canonical page |
| `source test` | Technical noun | A test that imports and exercises project source rather than compiled artifacts. | unit test when test scope is intended, package contract |
| `supported surface` | Technical noun | A user-facing integration, workflow, configuration, or behavior accepted under the product scope gate. | feature, solution without support approval |
| `target version` | Technical noun | The release version to which work is assigned. | next release, current version |
| `test` | Technical noun or verb | A repeatable executable evaluation of specified behavior, or the act of running it. | check when no behavior executes, validation when input conformance is intended |
| `test title` | Technical noun | The behavior-oriented name of a test, with any issue reference in a final suffix. | test name when title conventions are intended |
| `tested` | Adjective | Has named test evidence for a revision, setup, and environment. Testing alone does not establish product support. | supported, works |
| `unit test` | Technical noun | A test of one source unit with external dependencies isolated. | integration test, source test when import origin is intended |
| `user approval` | Technical noun | Explicit consent from the affected user for a named action and scope. It does not establish product support, and product approval does not replace it. | accepted issue, accepted design decision, implied consent |
| `user-visible change` | Technical noun | A change to a command, output, configuration, workflow, or supported behavior. | improvement without the changed behavior |
| `validation` | Technical noun | Evaluation of an input, configuration, or result against a specified contract. | verification when establishing an operational claim, test when behavior executes |
| `verification` | Technical noun | Evidence-based confirmation that a stated result is true for the named revision and environment. | validation when checking input conformance, check without evidence |

## Claim Ladder

Use this table to keep operational checks, evidence descriptions, technical compatibility, and
product support separate.
A result can support more than one claim only when its evidence meets each definition.

| Class | Claim | Establishes | Does not establish |
|---|---|---|---|
| Operational | `inference route reachability` | The named `/v1/models` route returned HTTP `200` through `499`. | Valid credentials, successful model invocation, readiness, compatibility, or support. |
| Operational | `inference health` | The named `/v1/models` probe classification, plus the result of one inference request over the same route when NemoClaw sent one. | Broader API conformance, other requests or models, readiness, compatibility, or support. |
| Operational | `readiness check` | A service or resource meets named criteria to begin its intended work. | Broader reliability, compatibility, or support. |
| Operational | `validation request` | One authenticated request succeeded for the named endpoint, API family, model, and request shape. | Broader API conformance, other requests or models, reliability, or support. |
| Evidence | `verification` | Evidence confirms the stated result for the named revision and environment. | Compatibility or support unless the evidence and decision establish them. |
| Evidence | `tested` | The revision, setup, and environment have named test evidence. | Compatibility beyond the tested criteria or support. |
| Technical | `compatible` | The named technical contract is satisfied. | Product support. |
| Product | `supported` | The product surface has accepted ownership, lifecycle, compatibility, security, and validation expectations. | User approval for a specific action. |

Product states remain valid technical terms. For example, use the OpenShell sandbox phase
`Ready` with its documented capitalization. Do not use `ready` as a general approval judgment.

## Maintain the List

The list has no fixed entry count. Expand it when repository usage proves that a term needs control,
and remove an entry when the project no longer uses its concept or form. The section boundaries
help writers find terms; they do not create separate vocabularies.

Add or change an entry only when it does at least one of these things:

- Resolves a recurring ambiguity across repository surfaces.
- Separates concepts whose difference affects behavior, security, support, or evidence.
- Preserves a product name or text form.

For each entry:

1. Confirm the term against the applicable CLI, code, tests, and current documentation. Confirm an external product name against its official form.
2. Select the shortest familiar term that preserves the current meaning.
3. Define one meaning. Add another row when the same word has a different controlled meaning.
4. List only alternatives that writers use for that same meaning.
5. Keep entries alphabetical within their section.

Do not add every acceptable English word. Do not use this list to rename a command, identifier,
schema field, UI label, or third-party product. Such a rename needs its own behavior or interface
decision.
