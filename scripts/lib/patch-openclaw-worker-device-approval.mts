// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ASYNC_IDENTITY_REPLACEMENT,
  ASYNC_GATEWAY_AUTH_REPLACEMENT,
  HANDLER_HELPER,
  STATE_HELPER,
  STATE_SQLITE_PERSISTENCE_REPLACEMENT,
  STATE_SQLITE_AUTH_UPDATE_REPLACEMENT,
  STATE_SQLITE_AUTH_UPDATE_TARGET,
  AUTH_DEVICE_TOKEN_SQLITE_REPLACEMENT,
  AUTH_INLINE_APPROVAL_105_REPLACEMENT,
} from "./openclaw-device-patch-payloads.mts";

type Pair = readonly [string, string];
// Bind only reviewed external names; shared validation logic is emitted unchanged.
function identityPayload(split: boolean): string {
  return split
    ? ASYNC_IDENTITY_REPLACEMENT.replaceAll("normalizeOptionalString(", "r(")
        .replaceAll("loadDeviceIdentityIfPresentAsync()", "B()")
        .replaceAll("loadOrCreateDeviceIdentityAsync()", "ke()")
    : ASYNC_IDENTITY_REPLACEMENT;
}
function callPayload(split: boolean): string {
  return split
    ? ASYNC_GATEWAY_AUTH_REPLACEMENT.replaceAll("GATEWAY_CLIENT_NAMES", "O")
        .replaceAll("GATEWAY_CLIENT_MODES", "A")
        .replaceAll("isLoopbackGatewayUrl(", "se(")
    : ASYNC_GATEWAY_AUTH_REPLACEMENT;
}
const persistencePreflight = STATE_SQLITE_PERSISTENCE_REPLACEMENT.slice(
  STATE_SQLITE_PERSISTENCE_REPLACEMENT.indexOf("\n") + 1,
  STATE_SQLITE_PERSISTENCE_REPLACEMENT.lastIndexOf('\n\t\tif (target !== "paired")'),
);
const persistenceUpdate = STATE_SQLITE_AUTH_UPDATE_REPLACEMENT.slice(
  0,
  -STATE_SQLITE_AUTH_UPDATE_TARGET.length,
);
function persistencePayload(db: string, state: string, target: string, options: string): string {
  return `const nemoclawAuthTransition=((db,state,target,options)=>{\n${persistencePreflight}\nreturn nemoclawAuthTransition;})(${db},${state},${target},${options});`;
}
function updatePayload(db: string): string {
  return `((db)=>{\n${persistenceUpdate}\n})(${db});`;
}
// Native enum values are fixed to "cli" in this reviewed artifact. Keeping the
// constants local avoids binding a short imported name from another compiled scope.
function cliEnums(source: string): string {
  return source
    .replaceAll("GATEWAY_CLIENT_IDS.CLI", '"cli"')
    .replaceAll("GATEWAY_CLIENT_MODES.CLI", '"cli"');
}
function tokenPayload(param: string, verifier: string, generation: string, client: string): string {
  const body = cliEnums(
    AUTH_DEVICE_TOKEN_SQLITE_REPLACEMENT.slice(
      AUTH_DEVICE_TOKEN_SQLITE_REPLACEMENT.indexOf("{") + 1,
      AUTH_DEVICE_TOKEN_SQLITE_REPLACEMENT.lastIndexOf("}"),
    ),
  );
  return `async verifyDeviceToken(${param}){return await (async function(paramsLocal,verifyDeviceToken,getRequiredSharedGatewaySessionGeneration,connectParams){${body}\n})(${param},${verifier},${generation},${client})}`;
}
function inlinePayload(args: string): string {
  return `((existingPairedDevice,scopes,reason,pairing,plan,authMethod,connectParams,role,devicePublicKey,trustedProxyApprovalScopes,normalizeSortedUniqueTrimmedStringList,resolvePairedAccessScopes)=>{\n${cliEnums(AUTH_INLINE_APPROVAL_105_REPLACEMENT)}\nreturn inlineApprovalAttempted;})(${args})`;
}

// Each original expression is copied from the SRI-verified 2026.10.5 worker
// archive. The archive owner restores these pairs and verifies the full native
// manifest before publishing any change, including every untouched file.
export const WORKER_ARCHIVE_DEVICE_PATCHES: Record<string, readonly Pair[]> = {
  "sqlite-store.worker.mjs": [
    [
      'async function resolveDeviceIdentityForGatewayCall(Ot){try{return Ot===`read-only`?await loadDeviceIdentityIfPresentAsync():await loadOrCreateDeviceIdentityAsync()}catch(Ot){throw Error(`Cannot load device identity. Check access to your OpenClaw state directory and run "openclaw doctor --fix", then retry.`,{cause:Ot})}}',
      identityPayload(false),
    ],
    [
      "async function resolveGatewayCallDeviceAuth(Ot){let{opts:Kt}=Ot,Zt=isLoopbackGatewayUrl(Ot.url),_n={clientName:Kt.clientName,mode:Kt.mode,requireLocalBackendSharedAuth:Kt.requireLocalBackendSharedAuth};Kt.allowLocalBackendAuthNone&&Ot.authMode===`none`&&Ot.isImplicitLocalTarget&&Zt&&Kt.clientName===GATEWAY_CLIENT_NAMES.CLI&&Kt.mode===GATEWAY_CLIENT_MODES.CLI&&Kt.deviceIdentity===void 0&&!Kt.useStoredDeviceAuth&&!Kt.preparedDeviceAuth&&!Kt.approvalRuntimeToken&&!Kt.agentRuntimeIdentityToken&&(_n.clientName=GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,_n.mode=GATEWAY_CLIENT_MODES.BACKEND,_n.requireLocalBackendSharedAuth=!0);let Dn=_n.mode??GATEWAY_CLIENT_MODES.CLI,kn=_n.clientName??GATEWAY_CLIENT_NAMES.CLI,Pn=_n.requireLocalBackendSharedAuth===!0&&Ot.authMode===`none`,Fn=Ot.authMode===`token`&&!!Ot.token||Ot.authMode===`password`&&!!Ot.password,Ln=Dn===GATEWAY_CLIENT_MODES.BACKEND&&kn===GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT&&(Fn||Pn)&&Zt,Jn=Dn===GATEWAY_CLIENT_MODES.CLI&&kn===GATEWAY_CLIENT_NAMES.CLI&&Fn&&Zt,cr=Ln||Jn;if(_n.requireLocalBackendSharedAuth&&!cr)throw new GatewayLocalBackendSharedAuthUnavailableError(`local backend shared auth requires a loopback gateway with token/password credentials or auth mode none`);return{clientOptions:_n,omitDeviceIdentity:cr,deviceIdentity:Kt.deviceIdentity===void 0?cr?null:await resolveDeviceIdentityForGatewayCall(Kt.sharedStateMode):Kt.deviceIdentity}}",
      callPayload(false),
    ],
    [
      "await resolveGatewayCallDeviceAuth({opts:Ot,url:Mr,authMode:mi.mode,isImplicitLocalTarget:!Fn&&!_n.isRemoteMode,token:Br,password:Hr})",
      "await resolveGatewayCallDeviceAuth({opts:Ot,url:Mr,authMode:mi.mode,isImplicitLocalTarget:!Fn&&!_n.isRemoteMode,token:Br,password:Hr,deviceAuthScope:Pr})",
    ],
    [
      "function approveDevicePairingInWorker(Ot,Kt,Zt){return withPendingDevicePairingApproval(Ot,Zt,(_n,Dn,kn)=>{let Pn=Kt?.autoApproveNewDeviceScopes,Fn=resolveRequestedDeviceRoles(Dn),Ln=Kt?.approvedVia===`trusted-proxy`&&kn!==void 0&&kn.publicKey===Dn.publicKey;if(Pn&&((Dn.isRepair||kn)&&!Ln||!sameDevicePairingStringSet(Fn,[OPERATOR_ROLE])))return null;let Jn=Pn?{...Dn,scopes:[...Pn]}:Dn,cr=resolveScopeOutsideRequestedRoles({requestedRoles:Fn,requestedScopes:normalizeDeviceAuthScopes(Jn.scopes)});if(cr)return{status:`forbidden`,reason:`scope-outside-requested-roles`,scope:cr};let pr=Zt,xr=mergeApprovalRoles(kn,Jn),Mr=mergeDevicePairingScopes(kn?.approvedScopes??kn?.scopes,Jn.scopes),Pr=kn?.tokens?{...kn.tokens}:{},Br=/* @__PURE__ */ new Map;for(let Ot of Fn){let Zt=Pr[Ot],_n=resolveApprovedTokenScopes({role:Ot,pending:Jn,existingToken:Zt,approvedScopes:Mr,existing:kn});if(Br.set(Ot,_n),Ot===OPERATOR_ROLE&&_n.length>0){let Zt=mergeDevicePairingScopes(resolveRoleTokenScopes(Ot,Jn.scopes),_n)??_n;if(!Kt?.callerScopes)return{status:`forbidden`,reason:`caller-scopes-required`,scope:Zt[0]};let Dn=resolveMissingRequestedScope({role:OPERATOR_ROLE,requestedScopes:Zt,allowedScopes:Kt.callerScopes});if(Dn)return{status:`forbidden`,reason:`caller-missing-scope`,scope:Dn}}}for(let[Ot,Kt]of Br){let _n=Pr[Ot],Dn=Zt;Pr[Ot]=createDeviceAuthToken({role:Ot,scopes:Kt,existing:_n,preserveExistingIssuer:!0,now:Dn,rotatedAtMs:_n?Dn:void 0})}return commitApprovedDevicePairing({state:_n,requestId:Ot,device:buildApprovedPairedDevice({pending:Jn,existing:kn,roles:xr,approvedScopes:Mr,tokens:Pr,now:pr,approvedVia:Kt?.approvedVia??`owner`,accessMetadata:Kt?.accessMetadata})})})}",
      STATE_HELPER +
        "function approveDevicePairingInWorker(Ot,Kt,Zt){return withPendingDevicePairingApproval(Ot,Zt,(_n,Dn,kn)=>{const nemoclawSelfApprovalScopes=resolveNemoClawSelfApprovalScopes(Dn,Kt?.callerScopes,Kt?.nemoclawSelfApprovalIdentity);let Pn=Kt?.autoApproveNewDeviceScopes,Fn=resolveRequestedDeviceRoles(Dn),Ln=Kt?.approvedVia===`trusted-proxy`&&kn!==void 0&&kn.publicKey===Dn.publicKey;if(Pn&&((Dn.isRepair||kn)&&!Ln||!sameDevicePairingStringSet(Fn,[OPERATOR_ROLE])))return null;let Jn=Pn?{...Dn,scopes:[...Pn]}:Dn,cr=resolveScopeOutsideRequestedRoles({requestedRoles:Fn,requestedScopes:normalizeDeviceAuthScopes(Jn.scopes)});if(cr)return{status:`forbidden`,reason:`scope-outside-requested-roles`,scope:cr};let pr=Zt,xr=mergeApprovalRoles(kn,Jn),Mr=mergeDevicePairingScopes(kn?.approvedScopes??kn?.scopes,Jn.scopes),Pr=kn?.tokens?{...kn.tokens}:{},Br=/* @__PURE__ */ new Map;for(let Ot of Fn){let Zt=Pr[Ot],_n=resolveApprovedTokenScopes({role:Ot,pending:Jn,existingToken:Zt,approvedScopes:Mr,existing:kn});if(Br.set(Ot,_n),Ot===OPERATOR_ROLE&&_n.length>0){let Zt=mergeDevicePairingScopes(resolveRoleTokenScopes(Ot,Jn.scopes),_n)??_n;const nemoclawEffectiveCallerScopes=nemoclawSelfApprovalScopes??Kt?.callerScopes;if(!nemoclawEffectiveCallerScopes)return{status:`forbidden`,reason:`caller-scopes-required`,scope:Zt[0]};let Dn=resolveMissingRequestedScope({role:OPERATOR_ROLE,requestedScopes:Zt,allowedScopes:nemoclawEffectiveCallerScopes});if(Dn)return{status:`forbidden`,reason:`caller-missing-scope`,scope:Dn}}}for(let[Ot,Kt]of Br){let _n=Pr[Ot],Dn=Zt;Pr[Ot]=createDeviceAuthToken({role:Ot,scopes:Kt,existing:_n,preserveExistingIssuer:!0,now:Dn,rotatedAtMs:_n?Dn:void 0})}return commitApprovedDevicePairing({state:_n,requestId:Ot,device:buildApprovedPairedDevice({pending:Jn,existing:kn,roles:xr,approvedScopes:Mr,tokens:Pr,now:pr,approvedVia:Kt?.approvedVia??`owner`,accessMetadata:Kt?.accessMetadata}),nemoclawSelfApprovalIdentity:nemoclawSelfApprovalScopes?Kt?.nemoclawSelfApprovalIdentity:null})})}",
    ],
    [
      "persistDevicePairingStoreState(Kt,void 0,`both`,Ln?{clearApnsNodeIds:[_n.deviceId]}:void 0)",
      "persistDevicePairingStoreState(Kt,void 0,`both`,Ot.nemoclawSelfApprovalIdentity?{...(Ln?{clearApnsNodeIds:[_n.deviceId]}:{}),nemoclawSelfApproval:{requestId:Zt,identity:Ot.nemoclawSelfApprovalIdentity}}:Ln?{clearApnsNodeIds:[_n.deviceId]}:void 0)",
    ],
    [
      "let Dn=getNodeSqliteKysely(Kt);if(Zt!==`paired`)",
      "let Dn=getNodeSqliteKysely(Kt);" +
        persistencePayload("Kt", "Ot", "Zt", "_n") +
        "if(Zt!==`paired`)",
    ],
    [
      "for(let Ot of new Set(_n?.clearApnsNodeIds??[]))clearApnsRegistrationFromDatabase(Kt,Ot);",
      updatePayload("Kt") +
        "for(let Ot of new Set(_n?.clearApnsNodeIds??[]))clearApnsRegistrationFromDatabase(Kt,Ot);",
    ],
    ["function authorizePairingDecision(", HANDLER_HELPER + "function authorizePairingDecision("],
    [
      "if(!kn.isAdminCaller&&!authorizePairingDecision(`approve`,Dn,await getPendingDevicePairing(Dn),kn,{respond:Kt,context:Zt}))return;let Pn=await approveDevicePairing(Dn,{callerScopes:kn.callerScopes});",
      "let nemoclawSelfApprovalIdentity=null;if(!kn.isAdminCaller){const pending=await getPendingDevicePairing(Dn);if(!authorizePairingDecision(`approve`,Dn,pending,kn,{respond:Kt,context:Zt}))return;nemoclawSelfApprovalIdentity=resolveNemoClawSelfApprovalIdentity(pending,kn,_n);}let Pn=await approveDevicePairing(Dn,{callerScopes:kn.callerScopes,nemoclawSelfApprovalIdentity});",
    ],
    [
      "async verifyDeviceToken(Ot){return await verifyDeviceToken({...Ot,requiredSharedGatewaySessionGeneration:pr?.()})}",
      tokenPayload("Ot", "verifyDeviceToken", "pr", "Hr"),
    ],
    [
      "let fa,pa=la!==null||sa.request.silent===!0||mi===`node`&&Zt===`role-upgrade`&&ta.localApproval===`silent`;",
      "let fa,pa=" +
        inlinePayload(
          "Ln,Br,Zt,sa,ta,Di,cr,mi,wi,la,normalizeSortedUniqueTrimmedStringList,resolvePairedAccessScopes",
        ) +
        ";",
    ],
  ],
  "worker-chunk-CJ_iECTX.mjs": [
    [
      'async function resolveDeviceIdentityForGatewayCall(e){try{return e===`read-only`?await B():await ke()}catch(e){throw Error(`Cannot load device identity. Check access to your OpenClaw state directory and run "openclaw doctor --fix", then retry.`,{cause:e})}}',
      identityPayload(true),
    ],
    [
      "async function resolveGatewayCallDeviceAuth(e){let{opts:t}=e,n=se(e.url),r={clientName:t.clientName,mode:t.mode,requireLocalBackendSharedAuth:t.requireLocalBackendSharedAuth};t.allowLocalBackendAuthNone&&e.authMode===`none`&&e.isImplicitLocalTarget&&n&&t.clientName===O.CLI&&t.mode===A.CLI&&t.deviceIdentity===void 0&&!t.useStoredDeviceAuth&&!t.preparedDeviceAuth&&!t.approvalRuntimeToken&&!t.agentRuntimeIdentityToken&&(r.clientName=O.GATEWAY_CLIENT,r.mode=A.BACKEND,r.requireLocalBackendSharedAuth=!0);let i=r.mode??A.CLI,a=r.clientName??O.CLI,o=r.requireLocalBackendSharedAuth===!0&&e.authMode===`none`,s=e.authMode===`token`&&!!e.token||e.authMode===`password`&&!!e.password,c=i===A.BACKEND&&a===O.GATEWAY_CLIENT&&(s||o)&&n,l=i===A.CLI&&a===O.CLI&&s&&n,u=c||l;if(r.requireLocalBackendSharedAuth&&!u)throw new GatewayLocalBackendSharedAuthUnavailableError(`local backend shared auth requires a loopback gateway with token/password credentials or auth mode none`);return{clientOptions:r,omitDeviceIdentity:u,deviceIdentity:t.deviceIdentity===void 0?u?null:await resolveDeviceIdentityForGatewayCall(t.sharedStateMode):t.deviceIdentity}}",
      callPayload(true),
    ],
    [
      "await resolveGatewayCallDeviceAuth({opts:e,url:h,authMode:y.mode,isImplicitLocalTarget:!l&&!r.isRemoteMode,token:_,password:v})",
      "await resolveGatewayCallDeviceAuth({opts:e,url:h,authMode:y.mode,isImplicitLocalTarget:!l&&!r.isRemoteMode,token:_,password:v,deviceAuthScope:g})",
    ],
  ],
  "worker-chunk-sbeUcZ9t.mjs": [
    ["function authorizePairingDecision(", HANDLER_HELPER + "function authorizePairingDecision("],
    [
      "if(!a.isAdminCaller&&!authorizePairingDecision(`approve`,i,await A(i),a,{respond:t,context:n}))return;let o=await L(i,{callerScopes:a.callerScopes});",
      "let nemoclawSelfApprovalIdentity=null;if(!a.isAdminCaller){const pending=await A(i);if(!authorizePairingDecision(`approve`,i,pending,a,{respond:t,context:n}))return;nemoclawSelfApprovalIdentity=resolveNemoClawSelfApprovalIdentity(pending,a,r);}let o=await L(i,{callerScopes:a.callerScopes,nemoclawSelfApprovalIdentity});",
    ],
  ],
  "worker-chunk-DVgC0w97.mjs": [
    [
      "let i=m(t);if(n!==`paired`)",
      "let i=m(t);" + persistencePayload("t", "e", "n", "r") + "if(n!==`paired`)",
    ],
    [
      "for(let e of new Set(r?.clearApnsNodeIds??[]))clearApnsRegistrationFromDatabase(t,e);",
      updatePayload("t") +
        "for(let e of new Set(r?.clearApnsNodeIds??[]))clearApnsRegistrationFromDatabase(t,e);",
    ],
  ],
  "worker-chunk-ESi8iLHn.mjs": [
    [
      "async verifyDeviceToken(e){return await qr({...e,requiredSharedGatewaySessionGeneration:d?.()})}",
      tokenPayload("e", "qr", "d", "g"),
    ],
    [
      "let F,I=M!==null||j.request.silent===!0||y===`node`&&n===`role-upgrade`&&T.localApproval===`silent`;",
      "let F,I=" + inlinePayload("u,_,n,j,T,S,f,y,x,M,l,resolvePairedAccessScopes") + ";",
    ],
  ],
};
