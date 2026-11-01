// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#pragma once
// Included by the unshimmed CI fixture only. No sentinel is ever resumed.
namespace creation_matrix {
constexpr DWORD termination_code=0x4e434d58;
const char* boolean(bool value){return value?"true":"false";}
struct Close {bool ok=true;DWORD error=0;};
void close(HANDLE& handle,Close& result){
  if(!handle||handle==INVALID_HANDLE_VALUE)return;
  if(!CloseHandle(handle)){result.ok=false;if(!result.error)result.error=GetLastError();}
  else handle=nullptr;
}
DWORD remaining(ULONGLONG deadline){const auto now=GetTickCount64();return now<deadline?static_cast<DWORD>(deadline-now):0;}
struct Parent {BOOL inJob=FALSE,jobKnown=FALSE,uiKnown=FALSE;DWORD ui=0,flags=0;};
Parent parent(){Parent value;value.jobKnown=IsProcessInJob(GetCurrentProcess(),nullptr,&value.inJob);JOBOBJECT_BASIC_UI_RESTRICTIONS ui{};value.uiKnown=QueryInformationJobObject(nullptr,JobObjectBasicUIRestrictions,&ui,sizeof(ui),nullptr);value.ui=ui.UIRestrictionsClass;JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};if(QueryInformationJobObject(nullptr,JobObjectExtendedLimitInformation,&limits,sizeof(limits),nullptr))value.flags=limits.BasicLimitInformation.LimitFlags;return value;}
bool app_sid(HANDLE token,std::wstring& sid,DWORD& app){
  DWORD needed=0;if(!GetTokenInformation(token,TokenIsAppContainer,&app,sizeof(app),&needed))return false;
  if(!app){sid.clear();return true;}
  alignas(void*) BYTE data[sizeof(TOKEN_APPCONTAINER_INFORMATION)+SECURITY_MAX_SID_SIZE]{};
  if(!GetTokenInformation(token,TokenAppContainerSid,data,sizeof(data),&needed))return false;
  auto value=reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(data);LPWSTR text=nullptr;
  if(!value->TokenAppContainer||!ConvertSidToStringSidW(value->TokenAppContainer,&text))return false;
  try{sid=text;}catch(...){LocalFree(text);throw;}return LocalFree(text)==nullptr;
}
struct Case {
  const char* stage="not-started";DWORD setupError=0,apiError=0,pid=0,terminationError=0,waitResult=WAIT_FAILED,exitCode=STILL_ACTIVE;
  bool attempted=false,created=false,processReturned=false,threadReturned=false,identityKnown=false;
  bool winKnown=false,noChildKnown=false,jobKnown=false,innerMember=false,terminated=false,signaled=false,exitKnown=false;
  DWORD winFlags=0,noChildFlags=0;bool safetyAssigned=false;DWORD safetyError=0;Close closed;
};
void run_case(const wchar_t* image,const char* architecture,const char* context,const std::wstring& nonce,
              const std::wstring& callerSid,HANDLE token,DWORD tokenError,bool restricted,int inner,bool win32k,ULONGLONG deadline){
  Case result;HANDLE job=nullptr,safety=nullptr;PROCESS_INFORMATION process{};bool attributesLive=false;
  std::vector<BYTE> storage;LPPROC_THREAD_ATTRIBUTE_LIST attributes=nullptr;
  std::wstring command=L"\""+std::wstring(image)+L"\"";
  const DWORD flags=CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|DETACHED_PROCESS|EXTENDED_STARTUPINFO_PRESENT;
  DWORD childPolicy=PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
  DWORD64 mitigation=win32k?PROCESS_CREATION_MITIGATION_POLICY_WIN32K_SYSTEM_CALL_DISABLE_ALWAYS_ON:0;
  try {
    if(remaining(deadline)<500){result.stage="matrix-budget";result.setupError=ERROR_TIMEOUT;}
    else if(!token){result.stage="token-setup";result.setupError=tokenError;}
    else {
      result.stage="inner-job-setup";
      if(inner){
        job=CreateJobObjectW(nullptr,nullptr);if(!job)throw GetLastError();
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_ACTIVE_PROCESS;limits.BasicLimitInformation.ActiveProcessLimit=1;
        if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))throw GetLastError();
        JOBOBJECT_BASIC_UI_RESTRICTIONS ui{};ui.UIRestrictionsClass=inner==2?0xff:0;
        if(!SetInformationJobObject(job,JobObjectBasicUIRestrictions,&ui,sizeof(ui)))throw GetLastError();
        JOBOBJECT_BASIC_UI_RESTRICTIONS read{};if(!QueryInformationJobObject(job,JobObjectBasicUIRestrictions,&read,sizeof(read),nullptr)||read.UIRestrictionsClass!=ui.UIRestrictionsClass)throw DWORD(ERROR_INVALID_DATA);
      }
      result.stage="startup-attributes";SIZE_T bytes=0;InitializeProcThreadAttributeList(nullptr,inner?3:2,0,&bytes);
      if(!bytes||bytes>8192)throw DWORD(ERROR_INVALID_DATA);storage.resize(bytes);attributes=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
      if(!InitializeProcThreadAttributeList(attributes,inner?3:2,0,&bytes))throw GetLastError();attributesLive=true;
      if(!UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY,&childPolicy,sizeof(childPolicy),nullptr,nullptr)||
         !UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY,&mitigation,sizeof(mitigation),nullptr,nullptr))throw GetLastError();
      if(inner&&!UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_JOB_LIST,&job,sizeof(job),nullptr,nullptr))throw GetLastError();
      STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.lpAttributeList=attributes;
      result.stage="CreateProcessAsUserW";result.attempted=true;
      result.created=CreateProcessAsUserW(token,image,command.data(),nullptr,nullptr,FALSE,flags,nullptr,nullptr,&startup.StartupInfo,&process)!=FALSE;
      result.apiError=result.created?0:GetLastError();
      // FALSE output fields are not authoritative and are never operated on.
      if(result.created){
        result.processReturned=process.hProcess!=nullptr;result.threadReturned=process.hThread!=nullptr;
        if(!result.processReturned||!result.threadReturned)throw DWORD(ERROR_INVALID_HANDLE);
        result.pid=GetProcessId(process.hProcess);result.identityKnown=result.pid!=0&&result.pid==process.dwProcessId;
        // Host no-inner case gets a cleanup-only job AFTER the measured API.
        // This does not add a job-list attribute to its creation experiment.
        if(!inner&&std::string(context)=="host"){
          safety=CreateJobObjectW(nullptr,nullptr);JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
          result.safetyAssigned=safety&&SetInformationJobObject(safety,JobObjectExtendedLimitInformation,&limits,sizeof(limits))&&AssignProcessToJobObject(safety,process.hProcess);
          result.safetyError=result.safetyAssigned?0:GetLastError();
        }
        PROCESS_MITIGATION_SYSTEM_CALL_DISABLE_POLICY win{};PROCESS_MITIGATION_CHILD_PROCESS_POLICY child{};
        result.winKnown=GetProcessMitigationPolicy(process.hProcess,ProcessSystemCallDisablePolicy,&win,sizeof(win))!=FALSE;result.winFlags=win.Flags;
        result.noChildKnown=GetProcessMitigationPolicy(process.hProcess,ProcessChildProcessPolicy,&child,sizeof(child))!=FALSE;result.noChildFlags=child.Flags;
        BOOL member=FALSE;result.jobKnown=IsProcessInJob(process.hProcess,job,&member)!=FALSE;result.innerMember=member!=FALSE;
      }
    }
  }catch(DWORD error){result.setupError=error;}catch(...){result.setupError=ERROR_UNHANDLED_EXCEPTION;}
  if(attributesLive)DeleteProcThreadAttributeList(attributes);
  if(result.created&&process.hProcess){
    result.terminated=TerminateProcess(process.hProcess,termination_code)!=FALSE;result.terminationError=result.terminated?0:GetLastError();
    result.waitResult=WaitForSingleObject(process.hProcess,remaining(deadline));result.signaled=result.waitResult==WAIT_OBJECT_0;
    if(result.signaled){result.exitKnown=GetExitCodeProcess(process.hProcess,&result.exitCode)!=FALSE;close(process.hThread,result.closed);close(process.hProcess,result.closed);}
  }
  if(!result.created){process={};}
  if(!result.created||result.signaled){close(job,result.closed);close(safety,result.closed);}
  const bool clean=result.closed.ok&&(!result.created||(result.signaled&&result.exitKnown&&!process.hProcess&&!process.hThread))&&!job&&!safety;
  line("{\"kind\":\"creation-matrix-case\",\"nonce\":"+quote(utf8(nonce))+",\"context\":"+quote(context)+",\"callerPid\":"+std::to_string(GetCurrentProcessId())+",\"callerAppSid\":"+quote(utf8(callerSid))+",\"architecture\":"+quote(architecture)+",\"tokenVariant\":"+quote(restricted?"privileges-admin-restricted":"same-primary")+",\"innerJob\":"+quote(inner==0?"absent":inner==1?"ui0":"ui-ff")+",\"innerUi\":"+std::to_string(inner==2?255:0)+",\"innerExtendedFlags\":"+std::to_string(inner?0x2008:0)+",\"win32kRequested\":"+boolean(win32k)+",\"noChildRequested\":true,\"creationFlags\":"+std::to_string(flags)+",\"resumed\":false,\"stage\":"+quote(result.stage)+",\"setupError\":"+std::to_string(result.setupError)+",\"apiAttempted\":"+boolean(result.attempted)+",\"apiCreated\":"+boolean(result.created)+",\"apiError\":"+std::to_string(result.apiError)+",\"falseOutputIgnored\":true,\"processHandleReturned\":"+boolean(result.processReturned)+",\"threadHandleReturned\":"+boolean(result.threadReturned)+",\"childPid\":"+std::to_string(result.pid)+",\"childIdentityKnown\":"+boolean(result.identityKnown)+",\"win32kQuerySucceeded\":"+boolean(result.winKnown)+",\"win32kFlags\":"+std::to_string(result.winFlags)+",\"noChildQuerySucceeded\":"+boolean(result.noChildKnown)+",\"noChildFlags\":"+std::to_string(result.noChildFlags)+",\"jobQuerySucceeded\":"+boolean(result.jobKnown)+",\"inSelectedOrInheritedJob\":"+boolean(result.innerMember)+",\"postCreateSafetyJobAssigned\":"+boolean(result.safetyAssigned)+",\"postCreateSafetyError\":"+std::to_string(result.safetyError)+",\"terminated\":"+boolean(result.terminated)+",\"earlyExit\":"+boolean(result.signaled&&result.exitKnown&&result.exitCode!=termination_code)+",\"terminationError\":"+std::to_string(result.terminationError)+",\"waitResult\":"+std::to_string(result.waitResult)+",\"exitCodeKnown\":"+boolean(result.exitKnown)+",\"exitCode\":"+std::to_string(result.exitCode)+",\"ownedHandlesClosed\":"+boolean(clean)+",\"cleanupError\":"+std::to_string(result.closed.error)+",\"diagnosticOnly\":true}");
  if(!clean){
    // Retain unconfirmed handles and keep the parent PID alive for the existing
    // bounded outer owner to terminate the full tree; never start another case.
    std::cout.flush();for(;;)Sleep(1000);
  }
}
void run(const std::wstring& nonce,bool contained,const Identity* identityValue=nullptr){
  require(lowerHex(nonce,24),"creation-matrix-nonce");
  require(!GetModuleHandleW(L"NemoClawMsysCompat-arm64.dll")&&!GetModuleHandleW(L"NemoClawMsysCompat-x64.dll"),"creation-caller-shimmed");
  const auto initial=parent();require(!contained||(initial.jobKnown&&initial.inJob&&initial.uiKnown&&initial.ui==0x3bf&&initial.flags==0x2000),"creation-caller-MXC-job");
  std::array<wchar_t,4096> image{};const DWORD length=GetModuleFileNameW(nullptr,image.data(),static_cast<DWORD>(image.size()));require(length&&length<image.size(),"creation-matrix-image");std::wstring directory=image.data();const auto slash=directory.find_last_of(L'\\');require(slash!=std::wstring::npos,"creation-matrix-directory");directory.resize(slash+1);
  HANDLE token=nullptr,restricted=nullptr;DWORD tokenError=0,restrictedError=0,app=0;std::wstring sid;Close closed;
  if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY|TOKEN_DUPLICATE|TOKEN_ASSIGN_PRIMARY,&token))tokenError=GetLastError();
  if(token){
    try{require(app_sid(token,sid,app),"creation-caller-token-identity");require((app!=0)==contained,"creation-caller-context");if(contained)require(identityValue&&sid==identityValue->sid,"creation-caller-AppSID");}
    catch(...){close(token,closed);throw;}
    BYTE administrators[SECURITY_MAX_SID_SIZE]{};DWORD bytes=sizeof(administrators);SID_AND_ATTRIBUTES disabled{};
    if(CreateWellKnownSid(WinBuiltinAdministratorsSid,nullptr,administrators,&bytes)){disabled.Sid=administrators;disabled.Attributes=0;if(!CreateRestrictedToken(token,DISABLE_MAX_PRIVILEGE,1,&disabled,0,nullptr,0,nullptr,&restricted))restrictedError=GetLastError();}
    else restrictedError=GetLastError();
    if(restricted){DWORD restrictedApp=0;std::wstring restrictedSid;
      if(!app_sid(restricted,restrictedSid,restrictedApp)||restrictedApp!=app||restrictedSid!=sid){restrictedError=ERROR_INVALID_DATA;close(restricted,closed);}
    }
  }

  const auto deadline=GetTickCount64()+5000;unsigned rows=0;
  for(const auto& architecture:std::array<std::pair<const char*,const wchar_t*>,2>{{{"arm64",L"creation-sentinels\\arm64\\creation-sentinel.exe"},{"amd64",L"creation-sentinels\\amd64\\creation-sentinel.exe"}}}){
    const auto target=directory+architecture.second;
    for(int inner=0;inner<3;++inner)for(bool win:{false,true}){run_case(target.c_str(),architecture.first,contained?"contained":"host",nonce,sid,token,tokenError,false,inner,win,deadline);++rows;}
    for(bool win:{false,true}){run_case(target.c_str(),architecture.first,contained?"contained":"host",nonce,sid,restricted,restrictedError?restrictedError:tokenError,true,0,win,deadline);++rows;}
  }
  close(restricted,closed);close(token,closed);const auto after=parent();const bool same=initial.jobKnown==after.jobKnown&&initial.inJob==after.inJob&&initial.uiKnown==after.uiKnown&&initial.ui==after.ui&&initial.flags==after.flags;
  line("{\"kind\":\"creation-matrix-summary\",\"nonce\":"+quote(utf8(nonce))+",\"context\":"+quote(contained?"contained":"host")+",\"callerPid\":"+std::to_string(GetCurrentProcessId())+",\"callerAppSid\":"+quote(utf8(sid))+",\"callerJobKnown\":"+boolean(initial.jobKnown!=FALSE)+",\"callerInJob\":"+boolean(initial.inJob!=FALSE)+",\"callerUiKnown\":"+boolean(initial.uiKnown!=FALSE)+",\"callerUi\":"+std::to_string(initial.ui)+",\"callerExtendedFlags\":"+std::to_string(initial.flags)+",\"rows\":"+std::to_string(rows)+",\"tokenHandlesClosed\":"+boolean(closed.ok&&!token&&!restricted)+",\"parentPolicyUnchanged\":"+boolean(same)+",\"childrenResumed\":0,\"callerUnshimmed\":true,\"diagnosticOnly\":true,\"chromeQualified\":false}");
  require(closed.ok&&!token&&!restricted&&same,"creation-matrix-final-cleanup");
}
}
