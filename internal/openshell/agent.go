// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package openshell

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"time"

	v1 "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1"
)

// Only non-secret configuration reaches the agent. OpenShell routes the stable
// model alias and owns upstream credentials. No upstream key is attached here.
func Environment(name string) map[string]string {
	c := map[string]any{
		"gateway": map[string]any{"mode": "local", "bind": "loopback", "port": 18789, "auth": map[string]any{"mode": "none"}, "controlUi": map[string]any{"enabled": false}},
		"models":  map[string]any{"mode": "replace", "providers": map[string]any{"openshell": map[string]any{"baseUrl": "https://inference.local/v1", "api": "openai-completions", "apiKey": "openshell-placeholder", "models": []any{map[string]any{"id": "primary", "name": "OpenShell route", "contextWindow": 32768, "maxTokens": 2048, "input": []string{"text"}, "reasoning": false}}}}},
		"agents":  map[string]any{"defaults": map[string]any{"model": map[string]any{"primary": "openshell/primary"}, "workspace": "/sandbox/workspace", "sandbox": map[string]any{"mode": "off"}}, "entries": map[string]any{name: map[string]any{}}},
		"tools":   map[string]any{"profile": "coding"},
	}
	b, _ := json.Marshal(c)
	return map[string]string{"TMPDIR": "/sandbox/tmp", "OPENCLAW_HOME": "/sandbox", "XDG_CACHE_HOME": "/sandbox/.cache", "OPENCLAW_CONFIG_PATH": "/sandbox/.openclaw/openclaw.json", "OPENCLAW_STATE_DIR": "/sandbox/.openclaw", "NEMOCLAW_AGENT_CONFIG": string(b), "NODE_EXTRA_CA_CERTS": "/etc/ssl/certs/ca-certificates.crt"}
}

func Command() []string { return []string{"node", "-e", bootstrap} }

const bootstrap = `const fs=require('node:fs');
const cp=require('node:child_process');
fs.mkdirSync('/sandbox/.openclaw',{recursive:true,mode:0o700});
fs.mkdirSync('/sandbox/tmp',{recursive:true,mode:0o700});
fs.mkdirSync('/sandbox/workspace',{recursive:true,mode:0o700});
const p=process.env.OPENCLAW_CONFIG_PATH;
fs.writeFileSync(p+'.tmp',process.env.NEMOCLAW_AGENT_CONFIG,{mode:0o600});
fs.renameSync(p+'.tmp',p);
const child=cp.spawn('openclaw',['gateway'],{stdio:'inherit',cwd:'/sandbox'});
for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>child.kill(s));
child.on('error',()=>process.exit(1));
child.on('exit',code=>process.exit(code??1));`

func Policy() *v1.SandboxPolicy {
	return &v1.SandboxPolicy{
		Version:         1,
		Filesystem:      &v1.FilesystemPolicy{ReadOnly: []string{"/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/app", "/opt", "/proc"}, ReadWrite: []string{"/sandbox", "/tmp", "/dev/null", "/dev/urandom", "/home/node"}},
		Landlock:        &v1.LandlockPolicy{Compatibility: "best_effort"},
		Process:         &v1.ProcessPolicy{RunAsUser: "1000", RunAsGroup: "1000"},
		NetworkPolicies: map[string]v1.NetworkPolicyRule{},
	}
}

func policyEqual(a, b *v1.SandboxPolicy) bool {
	if a == nil || a.Filesystem == nil || a.Process == nil || a.Landlock == nil {
		return false
	}
	samePaths := func(x, y []string) bool {
		return slices.Equal(slices.Sorted(slices.Values(x)), slices.Sorted(slices.Values(y)))
	}
	return *a.Process == *b.Process && *a.Landlock == *b.Landlock && a.Filesystem.IncludeWorkdir == b.Filesystem.IncludeWorkdir && samePaths(a.Filesystem.ReadOnly, b.Filesystem.ReadOnly) && samePaths(a.Filesystem.ReadWrite, b.Filesystem.ReadWrite) && len(a.NetworkPolicies) == 0 && len(a.NetworkMiddlewares) == 0
}

func Ready(ctx context.Context, c Client, workspace, name, agent string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	probe := []string{"node", "-e", `const fs=require('node:fs'),u=require('node:util');try{const actual=JSON.parse(fs.readFileSync('/sandbox/.openclaw/openclaw.json','utf8'));const expected=JSON.parse(process.env.NEMOCLAW_EXPECTED_CONFIG);for(const k of Object.keys(expected))if(!u.isDeepStrictEqual(actual[k],expected[k]))process.exit(2);}catch{process.exit(2);}fetch('http://127.0.0.1:18789/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`}
	ticks := time.Tick(time.Second)
	for {
		result, err := c.Exec().Run(ctx, workspace, name, probe, v1.ExecOptions{Env: map[string]string{"NEMOCLAW_EXPECTED_CONFIG": Environment(agent)["NEMOCLAW_AGENT_CONFIG"]}})
		if err == nil && result.ExitCode == 2 {
			return errors.New("agent configuration drifted; resources retained for inspection")
		}
		if err == nil && result.ExitCode == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("agent did not become healthy; resources retained for recovery")
		case <-ticks:
		}
	}
}

// Route validation runs on the gateway. Probe from the sandbox as well because
// local supervisors perform inference in a different network namespace.
func InferenceReady(ctx context.Context, c Client, workspace, name string) error {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	probe := []string{"node", "-e", `fetch('https://inference.local/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer openshell-placeholder'},body:JSON.stringify({model:'primary',messages:[{role:'user',content:'Reply OK.'}],max_tokens:1,stream:false}),signal:AbortSignal.timeout(80000)}).then(async r=>{const b=await r.json();process.exit(r.ok&&Array.isArray(b.choices)&&b.choices.length>0?0:1)}).catch(()=>process.exit(1))`}
	r, err := c.Exec().Run(ctx, workspace, name, probe, v1.ExecOptions{})
	if err != nil || r.ExitCode != 0 {
		return errors.New("inference through the sandbox failed; resources retained; verify the endpoint is reachable by the supervisor and reapply the same YAML")
	}
	return nil
}
