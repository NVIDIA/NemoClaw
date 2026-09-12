// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// CI-only raw NT object probe. Never linked to or launched through the compatibility shim.
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <winternl.h>
#include <securityappcontainer.h>
#include <sddl.h>
#include <aclapi.h>
#include <cstdio>
#include <exception>
#include <array>
#include <cstdint>
#include <cstring>
#include <algorithm>
#include <iostream>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#include <utility>

struct Handle {
  HANDLE value=nullptr;
  Handle()=default;
  Handle(const Handle&)=delete;
  Handle& operator=(const Handle&)=delete;
  ~Handle(){if(value && value!=INVALID_HANDLE_VALUE) CloseHandle(value);}
};
struct View {void* value=nullptr;~View(){if(value)UnmapViewOfFile(value);}};
void require(bool value,const char* why){if(!value)throw std::runtime_error(why);}
std::string utf8(const std::wstring& text){
  if(text.empty())return {};
  int count=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),nullptr,0,nullptr,nullptr);
  require(count>0,"utf8-size");std::string result(static_cast<size_t>(count),'\0');
  require(WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),result.data(),count,nullptr,nullptr)==count,"utf8-copy");return result;
}
std::string quote(const std::string& text){std::string result="\"";for(unsigned char c:text){if(c=='"'||c=='\\')result+='\\';require(c>=32,"json-control");result+=static_cast<char>(c);}return result+'"';}
std::string status(NTSTATUS value){std::ostringstream out;out<<"0x"<<std::hex<<std::setfill('0')<<std::setw(8)<<static_cast<std::uint32_t>(value);return quote(out.str());}
bool lowerHex(const std::wstring& value,size_t length){if(value.size()!=length)return false;for(wchar_t c:value)if(!((c>=L'0'&&c<=L'9')||(c>=L'a'&&c<=L'f')))return false;return true;}
struct Name {
  UNICODE_STRING unicode{};OBJECT_ATTRIBUTES attributes{};
  Name(std::wstring& name,HANDLE parent=nullptr,PVOID security=nullptr,ULONG flags=0){
    require(name.size()<16380,"object-name-bound");unicode.Length=static_cast<USHORT>(name.size()*sizeof(wchar_t));unicode.MaximumLength=unicode.Length;unicode.Buffer=name.data();
    attributes.Length=sizeof(attributes);attributes.ObjectName=&unicode;attributes.RootDirectory=parent;attributes.SecurityDescriptor=security;attributes.Attributes=flags;
  }
};
using OpenDirectory=NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES);
using NtCreateDirectoryFunction=NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES);
using NtCreateEventFunction=NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,ULONG,BOOLEAN);
using NtOpenEventFunction=NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES);
using CreateSection=NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PLARGE_INTEGER,ULONG,ULONG,HANDLE);
using OpenSection=NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES);
struct Api {
  HMODULE nt=GetModuleHandleW(L"ntdll.dll");
  OpenDirectory openDirectory;NtCreateDirectoryFunction createDirectory;NtCreateEventFunction createEvent;NtOpenEventFunction openEvent;CreateSection createSection;OpenSection openSection;
  template<typename T> T load(const char* name){FARPROC value=GetProcAddress(nt,name);T function=nullptr;static_assert(sizeof(value)==sizeof(function));std::memcpy(&function,&value,sizeof(function));return function;}
  Api(){
    require(nt!=nullptr,"ntdll-missing");
    openDirectory=load<OpenDirectory>("NtOpenDirectoryObject");
    createDirectory=load<NtCreateDirectoryFunction>("NtCreateDirectoryObject");
    createEvent=load<NtCreateEventFunction>("NtCreateEvent");openEvent=load<NtOpenEventFunction>("NtOpenEvent");
    createSection=load<CreateSection>("NtCreateSection");openSection=load<OpenSection>("NtOpenSection");
    require(openDirectory&&createDirectory&&createEvent&&openEvent&&createSection&&openSection,"ntdll-export-missing");
  }
};
std::wstring resolve_private_root(const std::wstring& raw,const std::wstring& sid,unsigned long session){
  const std::wstring relative=L"AppContainerNamedObjects\\"+sid;
  const std::wstring resolved=L"\\Sessions\\"+std::to_wstring(session)+L"\\"+relative;
  require(raw==relative,"private-root-token-binding");
  return resolved;
}
void line(const std::string& text);
struct Identity {std::wstring root,rawRoot,sid,userSid;DWORD session=0;};
Identity identity(Api& api){
  require(!GetModuleHandleW(L"NemoClawMsysCompat-arm64.dll")&&!GetModuleHandleW(L"NemoClawMsysCompat-x64.dll"),"raw-probe-was-shimmed");
  Handle token;require(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token.value)!=0,"token-open");DWORD needed=0,app=0;
  require(GetTokenInformation(token.value,TokenIsAppContainer,&app,sizeof(app),&needed)!=0&&app==1,"not-appcontainer");
  GetTokenInformation(token.value,TokenAppContainerSid,nullptr,0,&needed);require(needed>0&&needed<4096,"sid-size");std::vector<unsigned char> data(needed);
  require(GetTokenInformation(token.value,TokenAppContainerSid,data.data(),needed,&needed)!=0,"sid-query");auto info=reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(data.data());
  LPWSTR text=nullptr;require(ConvertSidToStringSidW(info->TokenAppContainer,&text)!=0,"sid-string");Identity result;result.sid=text;LocalFree(text);
  needed=0;GetTokenInformation(token.value,TokenUser,nullptr,0,&needed);require(needed>0&&needed<4096,"user-sid-size");std::vector<unsigned char> userData(needed);require(GetTokenInformation(token.value,TokenUser,userData.data(),needed,&needed)!=0,"user-sid-query");auto userInfo=reinterpret_cast<TOKEN_USER*>(userData.data());text=nullptr;require(ConvertSidToStringSidW(userInfo->User.Sid,&text)!=0,"user-sid-string");result.userSid=text;LocalFree(text);
  std::array<wchar_t,4096> buffer{};ULONG count=0;
  require(GetAppContainerNamedObjectPath(token.value,nullptr,static_cast<ULONG>(buffer.size()),buffer.data(),&count)!=0,"private-root-query");
  require(wcsnlen(buffer.data(),buffer.size())<buffer.size(),"private-root-bound");result.rawRoot=buffer.data();
  require(GetTokenInformation(token.value,TokenSessionId,&result.session,sizeof(result.session),&needed)!=0,"token-session-query");
  DWORD processSession=0;require(ProcessIdToSessionId(GetCurrentProcessId(),&processSession)!=0&&processSession==result.session,"process-token-session-match");
  line("{\"kind\":\"namespace-root-input\",\"rawProbeUnshimmed\":true,\"sid\":"+quote(utf8(result.sid))+",\"session\":"+std::to_string(result.session)+",\"rawApiPath\":"+quote(utf8(result.rawRoot))+"}");
  result.root=resolve_private_root(result.rawRoot,result.sid,result.session);
  Handle root;Name object(result.root);NTSTATUS opened=api.openDirectory(&root.value,0x1,&object.attributes);
  line("{\"kind\":\"namespace-root-validation\",\"rawProbeUnshimmed\":true,\"resolvedNtPath\":"+quote(utf8(result.root))+",\"directoryQueryStatus\":"+status(opened)+"}");
  require(opened==0,"private-root-original-open");return result;
}
std::wstring globalLeaf(const std::wstring& key){return L"NemoClawMsys-G-msys-2.0S5-"+key;}
std::wstring sessionLeaf(DWORD session,const std::wstring& key){return L"NemoClawMsys-S"+std::to_wstring(session)+L"-msys-2.0S5-"+key;}
std::wstring absolute(std::wstring root,const std::wstring& leaf){return root+L"\\"+leaf;}
NTSTATUS openDir(Api& api,std::wstring name,Handle& result){Name object(name);return api.openDirectory(&result.value,0x2000f,&object.attributes);}
bool missing(NTSTATUS value){auto code=static_cast<std::uint32_t>(value);return code==0xc0000034||code==0xc000003a;}
std::string identityFields(const Identity& id){return "\"pid\":"+std::to_string(GetCurrentProcessId())+",\"session\":"+std::to_string(id.session)+",\"sid\":"+quote(utf8(id.sid))+",\"rawApiPath\":"+quote(utf8(id.rawRoot))+",\"privateRoot\":"+quote(utf8(id.root))+",\"rawProbeUnshimmed\":true";}
void line(const std::string& text){std::cout<<text<<'\n';std::cout.flush();require(std::cout.good(),"stdout-write");}
std::string readLine(){std::string result;char c;while(std::cin.get(c)){if(c=='\n')return result;require(c>=32&&c<=126&&result.size()<1024,"command-bound");result+=c;}throw std::runtime_error("command-eof");}
std::string jobProof(DWORD workerPid,DWORD executorPid){
  BOOL member=FALSE;require(IsProcessInJob(GetCurrentProcess(),nullptr,&member)!=0&&member,"not-in-job");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};require(QueryInformationJobObject(nullptr,JobObjectExtendedLimitInformation,&limits,sizeof(limits),nullptr)!=0,"job-limits-query");
  DWORD flags=limits.BasicLimitInformation.LimitFlags;
  require((flags&JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)!=0&&!(flags&(JOB_OBJECT_LIMIT_BREAKAWAY_OK|JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)),"job-flags");
  std::vector<unsigned char> storage(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST)+256*sizeof(ULONG_PTR));auto members=reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(storage.data());
  require(QueryInformationJobObject(nullptr,JobObjectBasicProcessIdList,members,static_cast<DWORD>(storage.size()),nullptr)!=0&&members->NumberOfProcessIdsInList<=256,"job-members-query");
  bool hasSelf=false,hasWorker=false,hasExecutor=false;std::ostringstream ids;
  for(DWORD i=0;i<members->NumberOfProcessIdsInList;++i){auto value=members->ProcessIdList[i];if(i)ids<<',';ids<<value;hasSelf|=value==GetCurrentProcessId();hasWorker|=value==workerPid;hasExecutor|=value==executorPid;}
  require(hasSelf&&hasWorker&&!hasExecutor,"not-the-contained-sdk-job");
  std::array<wchar_t,32768> image{};DWORD length=GetModuleFileNameW(nullptr,image.data(),static_cast<DWORD>(image.size()));require(length>0&&length<image.size(),"self-image");
  auto attempt=[&](bool escape){std::wstring command=L"\""+std::wstring(image.data())+L"\" breakaway-child";STARTUPINFOW startup{};startup.cb=sizeof(startup);PROCESS_INFORMATION process{};
    BOOL ok=CreateProcessW(image.data(),command.data(),nullptr,nullptr,FALSE,CREATE_SUSPENDED|CREATE_NO_WINDOW|(escape?CREATE_BREAKAWAY_FROM_JOB:0),nullptr,nullptr,&startup,&process);DWORD error=ok?0:GetLastError();
    if(ok){Handle child,thread;child.value=process.hProcess;thread.value=process.hThread;require(TerminateProcess(child.value,0)!=0,"breakaway-fixture-stop");require(WaitForSingleObject(child.value,5000)==WAIT_OBJECT_0,"breakaway-fixture-close");}
    return std::pair<bool,DWORD>(ok!=0,error);};
  auto normal=attempt(false);require(normal.first,"raw-child-create-baseline");auto escape=attempt(true);
  std::string report="\"jobFlags\":"+std::to_string(flags)+",\"jobProcessIds\":["+ids.str()+"],\"expectedWorkerPid\":"+std::to_string(workerPid)+",\"expectedExecutorPid\":"+std::to_string(executorPid)+",\"normalSuspendedChildCreatedAndClosed\":true,\"rawBreakawayCreated\":"+(escape.first?"true":"false")+",\"rawBreakawayError\":"+std::to_string(escape.second);
  line("{\"kind\":\"job-proof\","+report+"}");require(!escape.first&&escape.second==ERROR_ACCESS_DENIED,"raw-breakaway-was-not-denied");return report;
}
// Job configuration is evidence only for the diagnostic raw-pipe mode. The
// identity/isolation modes continue to require the unchanged strict jobProof.
void raw_pipe_job_observation(const char* role,const std::wstring& nonce){
  BOOL member=FALSE;BOOL memberOk=IsProcessInJob(GetCurrentProcess(),nullptr,&member);DWORD memberError=memberOk?0:GetLastError();
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};BOOL limitsOk=QueryInformationJobObject(nullptr,JobObjectExtendedLimitInformation,&limits,sizeof(limits),nullptr);DWORD limitsError=limitsOk?0:GetLastError();
  line("{\"kind\":\"rawpipe-job-observation\",\"diagnosticOnly\":true,\"role\":"+quote(role)+",\"nonce\":"+quote(utf8(nonce))+",\"pid\":"+std::to_string(GetCurrentProcessId())+",\"membershipQuerySucceeded\":"+(memberOk?"true":"false")+",\"membershipError\":"+std::to_string(memberError)+",\"inJob\":"+(memberOk?(member?"true":"false"):"null")+",\"limitsQuerySucceeded\":"+(limitsOk?"true":"false")+",\"limitsError\":"+std::to_string(limitsError)+",\"jobFlags\":"+(limitsOk?std::to_string(limits.BasicLimitInformation.LimitFlags):"null")+"}");
}
// A bounded native writer used only by the raw-pipe diagnostic. Its inherited
// handle is never reopened and no compatibility module is loaded.
[[noreturn]] void raw_pipe_fatal(){fprintf(stderr,"NEMOCLAW_RAW_PIPE_CLEANUP_FAILED\n");fflush(stderr);TerminateProcess(GetCurrentProcess(),ERROR_OPERATION_ABORTED);std::terminate();}
std::string raw_pipe_handle(Api& api,HANDLE handle){
  using QueryObject=NTSTATUS(NTAPI*)(HANDLE,OBJECT_INFORMATION_CLASS,PVOID,ULONG,PULONG);
  using QueryFile=NTSTATUS(NTAPI*)(HANDLE,PIO_STATUS_BLOCK,PVOID,ULONG,FILE_INFORMATION_CLASS);
  struct Basic {ULONG attributes,access,handles,pointers,reserved[10];};
  struct Local {ULONG type,configuration,maximum,current,inQuota,readAvailable,outQuota,writeQuota,state,end;};
  Basic basic{};Local local{};ULONG access=0,needed=0;IO_STATUS_BLOCK accessIo{},localIo{};
  auto queryObject=api.load<QueryObject>("NtQueryObject");auto queryFile=api.load<QueryFile>("NtQueryInformationFile");require(queryObject&&queryFile,"raw-pipe-query-exports");
  NTSTATUS objectStatus=queryObject(handle,static_cast<OBJECT_INFORMATION_CLASS>(0),&basic,sizeof(basic),&needed);
  NTSTATUS accessStatus=queryFile(handle,&accessIo,&access,sizeof(access),static_cast<FILE_INFORMATION_CLASS>(8));
  if(accessStatus==static_cast<NTSTATUS>(0x103)){fprintf(stderr,"NEMOCLAW_RAW_PIPE_QUERY_PENDING={\"class\":8,\"status\":\"0x00000103\"}\n");raw_pipe_fatal();}
  NTSTATUS localStatus=queryFile(handle,&localIo,&local,sizeof(local),static_cast<FILE_INFORMATION_CLASS>(24));
  if(localStatus==static_cast<NTSTATUS>(0x103)){fprintf(stderr,"NEMOCLAW_RAW_PIPE_QUERY_PENDING={\"class\":24,\"status\":\"0x00000103\"}\n");raw_pipe_fatal();}
  DWORD flags=0;BOOL flagsOk=GetHandleInformation(handle,&flags);DWORD flagsError=flagsOk?0:GetLastError();
  return "\"handle\":"+quote(std::to_string(reinterpret_cast<uintptr_t>(handle)))+",\"objectBasicStatus\":"+status(objectStatus)+",\"grantedAccess\":"+(objectStatus==0?std::to_string(basic.access):"null")+",\"flagsAvailable\":"+(flagsOk?"true":"false")+",\"inheritanceFlags\":"+std::to_string(flags)+",\"flagsError\":"+std::to_string(flagsError)+",\"fileAccessStatus\":"+status(accessStatus)+",\"fileAccess\":"+(accessStatus==0?std::to_string(access):"null")+",\"pipeLocalStatus\":"+status(localStatus)+",\"pipeEnd\":"+(localStatus==0?std::to_string(local.end):"null")+",\"pipeConfiguration\":"+(localStatus==0?std::to_string(local.configuration):"null");
}
int raw_pipe_writer(int argc,wchar_t** argv){
  require(argc==6&&lowerHex(argv[3],24),"raw-writer-arguments");
  HANDLE writer=reinterpret_cast<HANDLE>(static_cast<uintptr_t>(std::stoull(argv[2])));DWORD mask=static_cast<DWORD>(std::stoul(argv[4])),parent=static_cast<DWORD>(std::stoul(argv[5]));
  require(writer&&writer!=INVALID_HANDLE_VALUE&&parent&&(mask==0x00120196||mask==0x0012019f),"raw-writer-identity");
  Api api;Identity id=identity(api);raw_pipe_job_observation("writer-child",argv[3]);
  line("{\"kind\":\"rawpipe-child-handle\",\"nonce\":"+quote(utf8(argv[3]))+",\"appSidMask\":"+std::to_string(mask)+",\"parentPid\":"+std::to_string(parent)+","+identityFields(id)+","+raw_pipe_handle(api,writer)+"}");
  using NativeWrite=NTSTATUS(NTAPI*)(HANDLE,HANDLE,PVOID,PVOID,PIO_STATUS_BLOCK,PVOID,ULONG,PLARGE_INTEGER,PULONG);
  auto write=api.load<NativeWrite>("NtWriteFile");require(write!=nullptr,"raw-writer-export");
  Handle event;event.value=CreateEventW(nullptr,FALSE,FALSE,nullptr);DWORD eventError=event.value?0:GetLastError();
  std::string bytes="RAW_PIPE_"+utf8(argv[3]);IO_STATUS_BLOCK io{};io.Status=static_cast<NTSTATUS>(0x103);
  NTSTATUS submitted=0;bool attempted=false,completed=false,cancelled=false;DWORD waited=WAIT_FAILED;
  if(event.value){
    attempted=true;submitted=write(writer,event.value,nullptr,nullptr,&io,bytes.data(),static_cast<ULONG>(bytes.size()),nullptr,nullptr);
    if(submitted==static_cast<NTSTATUS>(0x103)){
      waited=WaitForSingleObject(event.value,2000);
      if(waited!=WAIT_OBJECT_0){cancelled=true;if(!CancelIoEx(writer,nullptr)&&GetLastError()!=ERROR_NOT_FOUND)raw_pipe_fatal();if(WaitForSingleObject(event.value,2000)!=WAIT_OBJECT_0)raw_pipe_fatal();}
      completed=true;
    }else completed=submitted==0;
  }
  const bool passed=attempted&&completed&&!cancelled&&io.Status==0&&io.Information==bytes.size();
  line("{\"kind\":\"rawpipe-child-write\",\"nonce\":"+quote(utf8(argv[3]))+",\"appSidMask\":"+std::to_string(mask)+",\"pid\":"+std::to_string(GetCurrentProcessId())+",\"eventCreated\":"+(event.value?"true":"false")+",\"eventError\":"+std::to_string(eventError)+",\"writeAttempted\":"+(attempted?"true":"false")+",\"requestedBytes\":"+std::to_string(bytes.size())+",\"submitStatus\":"+(attempted?status(submitted):"null")+",\"waitResult\":"+std::to_string(waited)+",\"completionObserved\":"+(completed?"true":"false")+",\"ioStatus\":"+(completed?status(io.Status):"null")+",\"transferredBytes\":"+(completed?std::to_string(io.Information):"null")+",\"cancelled\":"+(cancelled?"true":"false")+",\"passed\":"+(passed?"true":"false")+"}");
  require(CloseHandle(writer)!=0,"raw-writer-close");return passed?0:1;
}

// A native child silently leaves only libuv's inner cleanup job. The unchanged
// strict proof must then identify the enclosing MXC job, including its caller.
void require_original_probe_in_job(DWORD parentPid){
  std::vector<unsigned char> storage(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST)+256*sizeof(ULONG_PTR));auto members=reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(storage.data());
  require(QueryInformationJobObject(nullptr,JobObjectBasicProcessIdList,members,static_cast<DWORD>(storage.size()),nullptr)!=0&&members->NumberOfProcessIdsInList<=256,"job-parent-members-query");
  bool included=false;for(DWORD i=0;i<members->NumberOfProcessIdsInList;++i)included|=members->ProcessIdList[i]==parentPid;
  require(included,"original-probe-not-in-mxc-job");
}
int job_proof_native_child(int argc,wchar_t** argv){
  require(argc==8&&lowerHex(argv[2],24),"job-proof-child-arguments");
  DWORD worker=static_cast<DWORD>(std::stoul(argv[3])),executor=static_cast<DWORD>(std::stoul(argv[4])),parent=static_cast<DWORD>(std::stoul(argv[5]));
  require(worker&&executor&&parent&&worker!=executor&&worker!=parent&&executor!=parent&&parent!=GetCurrentProcessId(),"job-proof-child-identities");
  Api api;Identity id=identity(api);require(id.sid==argv[6]&&id.session==std::stoul(argv[7]),"job-proof-child-container");
  jobProof(worker,executor);require_original_probe_in_job(parent);
  line("{\"kind\":\"job-proof-native-child\",\"nonce\":"+quote(utf8(argv[2]))+",\"parentPid\":"+std::to_string(parent)+",\"expectedWorkerPid\":"+std::to_string(worker)+",\"expectedExecutorPid\":"+std::to_string(executor)+","+identityFields(id)+",\"originalProbeInJob\":true,\"sameAppContainer\":true,\"strictProofPassed\":true}");return 0;
}
void job_proof_through_native_child(DWORD worker,DWORD executor,const Identity& id,const std::wstring& nonce){
  raw_pipe_job_observation("qualification-parent-inner-job",nonce);
  std::array<Handle,3> streams;const std::array<DWORD,3> kinds={STD_INPUT_HANDLE,STD_OUTPUT_HANDLE,STD_ERROR_HANDLE};
  for(size_t i=0;i<streams.size();++i)require(DuplicateHandle(GetCurrentProcess(),GetStdHandle(kinds[i]),GetCurrentProcess(),&streams[i].value,0,TRUE,DUPLICATE_SAME_ACCESS)!=0,"job-child-standard-stream");
  std::array<HANDLE,3> inherited={streams[0].value,streams[1].value,streams[2].value};
  SIZE_T needed=0;InitializeProcThreadAttributeList(nullptr,1,0,&needed);require(needed&&needed<8192,"job-child-attribute-size");std::vector<BYTE> storage(needed);
  auto attributes=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());require(InitializeProcThreadAttributeList(attributes,1,0,&needed)!=0,"job-child-attribute-init");
  bool attributesLive=true;Handle child,thread;bool childClosed=false,forced=false;DWORD childPid=0,exitCode=STILL_ACTIVE;
  auto closeChild=[&](){if(child.value&&!childClosed){if(WaitForSingleObject(child.value,0)!=WAIT_OBJECT_0){forced=true;if(!TerminateProcess(child.value,124)||WaitForSingleObject(child.value,2000)!=WAIT_OBJECT_0)raw_pipe_fatal();}childClosed=true;}};
  try{
    require(UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited.data(),sizeof(inherited),nullptr,nullptr)!=0,"job-child-handle-list");
    std::array<wchar_t,MAX_PATH> image{};DWORD length=GetModuleFileNameW(nullptr,image.data(),static_cast<DWORD>(image.size()));require(length&&length<image.size(),"job-child-image");
    std::wstring command=L"\""+std::wstring(image.data())+L"\" job-proof-native-child "+nonce+L" "+std::to_wstring(worker)+L" "+std::to_wstring(executor)+L" "+std::to_wstring(GetCurrentProcessId())+L" "+id.sid+L" "+std::to_wstring(id.session);
    STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;startup.StartupInfo.hStdInput=streams[0].value;startup.StartupInfo.hStdOutput=streams[1].value;startup.StartupInfo.hStdError=streams[2].value;startup.lpAttributeList=attributes;PROCESS_INFORMATION process{};
    // No CREATE_BREAKAWAY_FROM_JOB, detached process, or inherited job handle.
    BOOL created=CreateProcessW(image.data(),command.data(),nullptr,nullptr,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_NO_WINDOW,nullptr,nullptr,&startup.StartupInfo,&process);DWORD error=created?0:GetLastError();
    if(created){child.value=process.hProcess;thread.value=process.hThread;childPid=process.dwProcessId;}
    DeleteProcThreadAttributeList(attributes);attributesLive=false;
    line("{\"kind\":\"job-proof-child-created\",\"nonce\":"+quote(utf8(nonce))+",\"parentPid\":"+std::to_string(GetCurrentProcessId())+",\"childPid\":"+std::to_string(childPid)+",\"created\":"+(created?"true":"false")+",\"error\":"+std::to_string(error)+",\"ordinaryCreation\":true,\"standardStreamsOnly\":true}");
    require(created!=FALSE,"job-proof-child-create");
    DWORD waited=WaitForSingleObject(child.value,7000);if(waited!=WAIT_OBJECT_0)closeChild();else childClosed=true;
    require(GetExitCodeProcess(child.value,&exitCode)!=0,"job-proof-child-exit-code");
    require(CloseHandle(thread.value)!=0,"job-proof-child-thread-close");thread.value=nullptr;
    require(CloseHandle(child.value)!=0,"job-proof-child-process-close");child.value=nullptr;
    for(auto& stream:streams){require(CloseHandle(stream.value)!=0,"job-proof-child-stream-close");stream.value=nullptr;}
    line("{\"kind\":\"job-proof-child-closed\",\"nonce\":"+quote(utf8(nonce))+",\"parentPid\":"+std::to_string(GetCurrentProcessId())+",\"childPid\":"+std::to_string(childPid)+",\"exitCode\":"+std::to_string(exitCode)+",\"childClosed\":true,\"handlesClosed\":true,\"forced\":"+(forced?"true":"false")+"}");
    require(!forced&&exitCode==0,"job-proof-child-strict-proof-failed");
  }catch(...){if(attributesLive)DeleteProcThreadAttributeList(attributes);closeChild();throw;}
}

// Raw pipe fixture: no compatibility exports or hooks. Every handle belongs to
// this probe. Exact synchronous behavior is checked first; the independent
// isolation fixture then uses overlapped I/O for bounded observation/cleanup.
class PipeProof {
  const Identity& id;
  Api& api;
  std::wstring key;
  std::string nonce;
  Handle server;
  Handle npfs;
  bool ordinary;
  DWORD appSidMask;
  bool diagnostic;
  bool lastTransferEof=false;
  std::wstring originalOwner,originalGroup;
  SECURITY_DESCRIPTOR_CONTROL originalControl=0;
  bool originalDescriptorRead=false;
  using NativeCreate=NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PIO_STATUS_BLOCK,ULONG,ULONG,ULONG,ULONG,ULONG,ULONG,ULONG,ULONG,ULONG,PLARGE_INTEGER);
  using NativeOpen=NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PIO_STATUS_BLOCK,ULONG,ULONG);
  NativeCreate nativeCreate=nullptr;
  NativeOpen nativeOpen=nullptr;
  Handle connectEvent;
  OVERLAPPED connectOperation{};
  bool connectPending=false;
  bool connected=false;
  SECURITY_DESCRIPTOR descriptor{},originalDescriptor{};
  std::string tokenDefaultDacl;
  SECURITY_ATTRIBUTES attributes{};
  std::array<DWORD,512/sizeof(DWORD)> aclStorage{},originalAclStorage{};
  std::array<DWORD,SECURITY_MAX_SID_SIZE/sizeof(DWORD)> adminSid{},systemSid{};
  static_assert(SECURITY_MAX_SID_SIZE%sizeof(DWORD)==0);
  PSID user=nullptr,container=nullptr;
  bool closed=false;
  using QueryFile=NTSTATUS(NTAPI*)(HANDLE,PIO_STATUS_BLOCK,PVOID,ULONG,FILE_INFORMATION_CLASS);
  using QueryObject=NTSTATUS(NTAPI*)(HANDLE,OBJECT_INFORMATION_CLASS,PVOID,ULONG,PULONG);
  QueryFile queryFile;
  QueryObject queryObject;
  struct PipeLocal {ULONG type,configuration,maximum,current,inQuota,readAvailable,outQuota,writeQuota,state,end;};
  void fatal_cleanup() noexcept {fprintf(stderr,"NEMOCLAW_RAW_PIPE_CLEANUP_FAILED\n");fflush(stderr);TerminateProcess(GetCurrentProcess(),ERROR_OPERATION_ABORTED);std::terminate();}
  void join_listener(bool cancel){
    if(!connectPending)return;
    if(cancel&&!CancelIoEx(server.value,&connectOperation)&&GetLastError()!=ERROR_NOT_FOUND)throw std::runtime_error("pipe-connect-cancel");
    require(WaitForSingleObject(connectEvent.value,2000)==WAIT_OBJECT_0,"pipe-connect-close");DWORD transferred=0;
    BOOL ok=GetOverlappedResult(server.value,&connectOperation,&transferred,FALSE);DWORD error=ok?0:GetLastError();
    connectPending=false;require(ok||(cancel&&error==ERROR_OPERATION_ABORTED),"pipe-connect-result");connected=ok!=0;
  }
  void start_listener(){
    require(!connectPending,"pipe-connect-owned");connected=false;require(ResetEvent(connectEvent.value)!=0,"pipe-connect-event");connectOperation={};connectOperation.hEvent=connectEvent.value;
    BOOL ok=ConnectNamedPipe(server.value,&connectOperation);DWORD error=ok?0:GetLastError();
    require(!ok&&error==ERROR_IO_PENDING,"pipe-unexpected-client-or-connect-error");connectPending=true;
    const ULONGLONG deadline=GetTickCount64()+1000;
    while(GetTickCount64()<deadline){if(available())return;Sleep(1);}
    throw std::runtime_error("pipe-not-available");
  }
  DWORD transfer(HANDLE handle,bool write,bool asynchronous,void* buffer,DWORD count,bool allowEof=false){
    lastTransferEof=false;DWORD transferred=0;
    auto report=[&](BOOL submitted,DWORD submitError,BOOL completed,DWORD error){if(diagnostic)line("{\"kind\":\"rawpipe-transfer\",\"nonce\":"+quote(nonce)+",\"appSidMask\":"+std::to_string(appSidMask)+",\"operation\":"+quote(write?"WriteFile":"ReadFile")+",\"asynchronous\":"+(asynchronous?"true":"false")+",\"requestedBytes\":"+std::to_string(count)+",\"submitted\":"+(submitted?"true":"false")+",\"submitError\":"+std::to_string(submitError)+",\"completed\":"+(completed?"true":"false")+",\"error\":"+std::to_string(error)+",\"transferredBytes\":"+(completed?std::to_string(transferred):"null")+",\"eof\":"+(lastTransferEof?"true":"false")+"}");};
    if(!asynchronous){BOOL ok=write?WriteFile(handle,buffer,count,&transferred,nullptr):ReadFile(handle,buffer,count,&transferred,nullptr);DWORD error=ok?0:GetLastError();lastTransferEof=!write&&allowEof&&!ok&&error==ERROR_BROKEN_PIPE;if(lastTransferEof)transferred=0;report(ok,error,ok,error);require(ok||lastTransferEof,"pipe-sync-transfer");return transferred;}
    Handle event;event.value=CreateEventW(nullptr,TRUE,FALSE,nullptr);require(event.value!=nullptr,"pipe-transfer-event");OVERLAPPED operation{};operation.hEvent=event.value;
    BOOL submitted=write?WriteFile(handle,buffer,count,nullptr,&operation):ReadFile(handle,buffer,count,nullptr,&operation);DWORD submitError=submitted?0:GetLastError();
    if(!submitted&&submitError!=ERROR_IO_PENDING){lastTransferEof=!write&&allowEof&&submitError==ERROR_BROKEN_PIPE;report(submitted,submitError,FALSE,submitError);require(lastTransferEof,"pipe-transfer-submit");return 0;}
    if(!submitted&&WaitForSingleObject(event.value,2000)!=WAIT_OBJECT_0){
      if(!CancelIoEx(handle,&operation)&&GetLastError()!=ERROR_NOT_FOUND)fatal_cleanup();
      if(WaitForSingleObject(event.value,2000)!=WAIT_OBJECT_0)fatal_cleanup();DWORD ignored=0;BOOL drained=GetOverlappedResult(handle,&operation,&ignored,FALSE);DWORD error=drained?0:GetLastError();if(!drained&&error!=ERROR_OPERATION_ABORTED)fatal_cleanup();
      report(submitted,submitError,drained,error);throw std::runtime_error("pipe-transfer-deadline");
    }
    BOOL completed=GetOverlappedResult(handle,&operation,&transferred,FALSE);DWORD error=completed?0:GetLastError();lastTransferEof=!write&&allowEof&&!completed&&error==ERROR_BROKEN_PIPE;if(lastTransferEof)transferred=0;
    report(submitted,submitError,completed,error);require(completed||lastTransferEof,"pipe-transfer-result");return transferred;
  }
  void roundtrip(HANDLE client,bool overlapped){
    std::string bytes="NEMOCLAW_PIPE_"+nonce;std::array<char,128> actual{};
    require(transfer(client,true,ordinary,bytes.data(),static_cast<DWORD>(bytes.size()))==bytes.size(),"pipe-own-write");
    const DWORD read=transfer(server.value,false,overlapped,actual.data(),static_cast<DWORD>(actual.size()));
    require(read==bytes.size()&&memcmp(actual.data(),bytes.data(),read)==0,"pipe-own-readback");
  }
  void exact_sync_positive(){
    Handle client;open_client(name,false,client);require(client.value!=INVALID_HANDLE_VALUE,"pipe-exact-writer-open");roundtrip(client.value,false);
    require(CloseHandle(client.value)!=0,"pipe-sync-client-close");client.value=nullptr;require(CloseHandle(server.value)!=0,"pipe-sync-server-close");server.value=nullptr;exactSynchronousPositive=true;
  }
  void disconnect(){require(DisconnectNamedPipe(server.value)!=0,"pipe-disconnect");start_listener();}
  void readback(bool appended=true,HANDLE target=nullptr){
    PACL acl=nullptr;PSID owner=nullptr,group=nullptr;PSECURITY_DESCRIPTOR sd=nullptr;DWORD error=GetSecurityInfo(target?target:server.value,SE_KERNEL_OBJECT,OWNER_SECURITY_INFORMATION|GROUP_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&owner,&group,&acl,nullptr,&sd);
    require(error==ERROR_SUCCESS&&sd,"pipe-security-readback");
    try{
      const DWORD expectedCount=appended?4:3;require(acl&&acl->AceCount==expectedCount,"pipe-readback-ace-count");SECURITY_DESCRIPTOR_CONTROL control=0;DWORD revision=0;require(GetSecurityDescriptorControl(sd,&control,&revision)!=0,"pipe-readback-control");
      std::array<PSID,4> sids={user,adminSid.data(),systemSid.data(),container};std::string fields;
      for(DWORD index=0;index<expectedCount;++index){PVOID raw=nullptr;require(GetAce(acl,index,&raw)!=0,"pipe-readback-ace");auto ace=static_cast<ACCESS_ALLOWED_ACE*>(raw);
        require(ace->Header.AceType==ACCESS_ALLOWED_ACE_TYPE&&ace->Header.AceFlags==0&&EqualSid(&ace->SidStart,sids[index]),"pipe-readback-principal");
        DWORD original=index==3?appSidMask:GENERIC_ALL,mapped=original;GENERIC_MAPPING mapping={FILE_GENERIC_READ,FILE_GENERIC_WRITE,FILE_GENERIC_EXECUTE,FILE_ALL_ACCESS};MapGenericMask(&mapped,&mapping);
        require(ace->Mask==original||ace->Mask==mapped,"pipe-readback-mask");if(index)fields+=",";fields+=std::to_string(ace->Mask);
      }
      LPWSTR ownerText=nullptr,groupText=nullptr;require(owner&&group&&ConvertSidToStringSidW(owner,&ownerText)!=0,"pipe-owner-readback");std::wstring ownerSid=ownerText;LocalFree(ownerText);require(ConvertSidToStringSidW(group,&groupText)!=0,"pipe-group-readback");std::wstring groupSid=groupText;LocalFree(groupText);
      if(!originalDescriptorRead){originalOwner=ownerSid;originalGroup=groupSid;originalControl=control;originalDescriptorRead=true;}
      else require(originalOwner==ownerSid&&originalGroup==groupSid&&originalControl==control,"pipe-owner-group-control-changed");
      line("{\"kind\":\"pipe-descriptor\",\"fixture\":"+quote(target?"tracker-createpipe":ordinary?"ordinary-nt":"signal-win32")+",\"appended\":"+std::string(appended?"true":"false")+",\"rawProbeUnshimmed\":true,\"actualControl\":"+std::to_string(control)+",\"ownerSid\":"+quote(utf8(ownerSid))+",\"groupSid\":"+quote(utf8(groupSid))+",\"aceCount\":"+std::to_string(expectedCount)+",\"aceMasks\":["+fields+"],\"actualTokenSidsMatched\":true,\"ownerGroupControlPreserved\":true,\"genericMappingOnly\":true}");
    }catch(...){LocalFree(sd);throw;}LocalFree(sd);
  }
  // MSYS uinfo.cc initializes its default with sec_user_nih; this unshimmed
  // probe never runs that initializer. Observe its real token without assuming
  // the MSYS template or changing any token security information.
  void observe_token_default(bool after=false){
    Handle token;require(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token.value)!=0,"pipe-default-token");DWORD needed=0;
    BOOL sized=GetTokenInformation(token.value,TokenDefaultDacl,nullptr,0,&needed);DWORD error=sized?0:GetLastError();
    require(!sized&&error==ERROR_INSUFFICIENT_BUFFER&&needed>=sizeof(TOKEN_DEFAULT_DACL)&&needed<=65536,"pipe-default-size");
    std::vector<BYTE> buffer(needed);require(GetTokenInformation(token.value,TokenDefaultDacl,buffer.data(),static_cast<DWORD>(buffer.size()),&needed)!=0&&needed>=sizeof(TOKEN_DEFAULT_DACL)&&needed<=buffer.size(),"pipe-default-query");
    PACL acl=reinterpret_cast<TOKEN_DEFAULT_DACL*>(buffer.data())->DefaultDacl;std::string hex;
    if(acl){const uintptr_t begin=reinterpret_cast<uintptr_t>(buffer.data()),address=reinterpret_cast<uintptr_t>(acl);
      require(address>=begin+sizeof(TOKEN_DEFAULT_DACL)&&address<=begin+needed-sizeof(ACL),"pipe-default-range");
      require(acl->AclSize>=sizeof(ACL)&&acl->AclSize<=begin+needed-address&&IsValidAcl(acl),"pipe-default-valid");
      const BYTE* raw=reinterpret_cast<BYTE*>(acl);constexpr char digits[]="0123456789abcdef";for(DWORD n=0;n<acl->AclSize;++n){hex+=digits[raw[n]>>4];hex+=digits[raw[n]&15];}
    }
    const std::string snapshot=acl?hex:"null";const bool unchanged=!after||snapshot==tokenDefaultDacl;
    line("{\"kind\":\"pipe-token-default\",\"fixture\":\"ordinary-nt\",\"pid\":"+std::to_string(GetCurrentProcessId())+",\"nonce\":"+quote(nonce)+",\"appSidMask\":"+std::to_string(appSidMask)+",\"phase\":"+quote(after?"after":"before")+",\"aclPresent\":"+(acl?"true":"false")+",\"aclBytes\":"+(acl?std::to_string(acl->AclSize):"null")+",\"aceCount\":"+(acl?std::to_string(acl->AceCount):"null")+",\"aclHex\":"+quote(hex)+",\"tokenMutationRequested\":false,\"matchesBefore\":"+(after?(unchanged?"true":"false"):"null")+"}");
    if(after)require(unchanged,"pipe-token-default-changed");else tokenDefaultDacl=snapshot;
  }
  // Exact sec_user_nih same-user/no-second-SID template from sec/helper.cc:
  // current user, Administrators, SYSTEM; GENERIC_ALL and no ACE inheritance.
  void canonical_template(PACL acl){
    for(PSID sid:std::array<PSID,3>{user,adminSid.data(),systemSid.data()})require(AddAccessAllowedAceEx(acl,ACL_REVISION,0,GENERIC_ALL,sid)!=0,"pipe-original-ace");
  }
  HANDLE create_server(DWORD mode,bool canonicalBaseline=false){
    if(!ordinary)return CreateNamedPipeW(name.c_str(),mode,0x0000000c,1,65472,65472,0,&attributes);
    Name object(name,npfs.value,canonicalBaseline?&originalDescriptor:&descriptor,OBJ_INHERIT);IO_STATUS_BLOCK io{};LARGE_INTEGER timeout{};timeout.QuadPart=-500000;HANDLE result=nullptr;
    NTSTATUS value=nativeCreate(&result,0x80100100,&object.attributes,&io,3,2,(mode&FILE_FLAG_OVERLAPPED)?0:0x20,0,0,0,1,65536,65536,&timeout);if(value==static_cast<NTSTATUS>(0x103))fatal_cleanup();
    line("{\"kind\":\"pipe-native-server\",\"canonicalBaseline\":"+std::string(canonicalBaseline?"true":"false")+",\"explicitObjectDescriptor\":true,\"tokenDefaultUsed\":false,\"overlappedFixture\":"+std::string((mode&FILE_FLAG_OVERLAPPED)?"true":"false")+",\"status\":"+status(value)+"}");
    if(value!=0){if(value>=0&&result)CloseHandle(result);return INVALID_HANDLE_VALUE;}return result;
  }
  DWORD open_client(const std::wstring& target,bool minimal,Handle& client){
    if(!ordinary){client.value=CreateFileW(target.c_str(),minimal?FILE_WRITE_DATA:0x40000080,0,nullptr,OPEN_EXISTING,minimal?FILE_FLAG_OVERLAPPED:0,nullptr);return client.value==INVALID_HANDLE_VALUE?GetLastError():ERROR_SUCCESS;}
    std::wstring copy=target;Name object(copy,npfs.value,nullptr,OBJ_INHERIT);IO_STATUS_BLOCK io{};NTSTATUS value=nativeOpen(&client.value,minimal?FILE_WRITE_DATA:0x40100080,&object.attributes,&io,0,0);if(value==static_cast<NTSTATUS>(0x103))fatal_cleanup();
    line("{\"kind\":\"pipe-native-client\",\"minimalWriteData\":"+std::string(minimal?"true":"false")+",\"relativeName\":"+quote(utf8(target))+",\"status\":"+status(value)+"}");
    if(value!=0){if(value>=0&&client.value)CloseHandle(client.value);client.value=INVALID_HANDLE_VALUE;}return static_cast<DWORD>(value);
  }
 public:
  std::wstring name;
  std::wstring kernelName;
  bool exactSynchronousPositive=false,ownBefore=false,minimalBefore=false,ownAfter=false,minimalAfter=false;
  PipeProof(const Identity& identity,Api& calls,const std::wstring& installationKey,const std::wstring& marker,bool ordinaryNt=false,DWORD mask=0x00120196,bool rawDiagnostic=false):id(identity),api(calls),key(installationKey),nonce(utf8(marker)),ordinary(ordinaryNt),appSidMask(mask),diagnostic(rawDiagnostic){
    require(mask==0x00120196||(rawDiagnostic&&ordinaryNt&&mask==0x0012019f),"pipe-diagnostic-mask-scope");
    queryFile=api.load<QueryFile>("NtQueryInformationFile");queryObject=api.load<QueryObject>("NtQueryObject");require(queryFile&&queryObject,"pipe-native-queries");
    try{
      require(ConvertStringSidToSidW(id.userSid.c_str(),&user)!=0&&ConvertStringSidToSidW(id.sid.c_str(),&container)!=0,"pipe-token-sids");
      DWORD size=static_cast<DWORD>(sizeof(adminSid));require(CreateWellKnownSid(WinBuiltinAdministratorsSid,nullptr,adminSid.data(),&size)!=0,"pipe-admin-sid");size=static_cast<DWORD>(sizeof(systemSid));require(CreateWellKnownSid(WinLocalSystemSid,nullptr,systemSid.data(),&size)!=0,"pipe-system-sid");
      const size_t aclBytes=sizeof(ACL)+4*(sizeof(ACCESS_ALLOWED_ACE)-sizeof(DWORD))+GetLengthSid(user)+GetLengthSid(adminSid.data())+GetLengthSid(systemSid.data())+GetLengthSid(container);require(aclBytes<=sizeof(aclStorage),"pipe-acl-bound");
      auto acl=reinterpret_cast<PACL>(aclStorage.data());require(InitializeAcl(acl,static_cast<DWORD>(aclBytes),ACL_REVISION)!=0,"pipe-acl-init");
      if(ordinary)observe_token_default();
      auto originalAcl=reinterpret_cast<PACL>(originalAclStorage.data());const DWORD originalBytes=static_cast<DWORD>(aclBytes-(sizeof(ACCESS_ALLOWED_ACE)-sizeof(DWORD))-GetLengthSid(container));
      require(InitializeAcl(originalAcl,originalBytes,ACL_REVISION)!=0,"pipe-original-acl-init");canonical_template(originalAcl);canonical_template(acl);
      require(InitializeSecurityDescriptor(&originalDescriptor,SECURITY_DESCRIPTOR_REVISION)!=0&&SetSecurityDescriptorDacl(&originalDescriptor,TRUE,originalAcl,FALSE)!=0,"pipe-original-descriptor-init");
      require(AddAccessAllowedAceEx(acl,ACL_REVISION,0,appSidMask,container)!=0,"pipe-container-ace");
      require(InitializeSecurityDescriptor(&descriptor,SECURITY_DESCRIPTOR_REVISION)!=0&&SetSecurityDescriptorDacl(&descriptor,TRUE,acl,FALSE)!=0,"pipe-descriptor-init");attributes={sizeof(attributes),&descriptor,FALSE};
      name=L"\\\\.\\pipe\\msys-"+key+L"-"+std::to_wstring(GetCurrentProcessId())+L"-sigwait";
      if(ordinary){
        nativeCreate=api.load<NativeCreate>("NtCreateNamedPipeFile");nativeOpen=api.load<NativeOpen>("NtOpenFile");require(nativeCreate&&nativeOpen,"pipe-native-exports");std::wstring root=L"\\Device\\NamedPipe\\";Name object(root);IO_STATUS_BLOCK io{};NTSTATUS result=nativeOpen(&npfs.value,0x00100080,&object.attributes,&io,3,0);if(result==static_cast<NTSTATUS>(0x103))fatal_cleanup();require(result==0,"pipe-owned-npfs-root");
        name=key+L"-"+std::to_wstring(GetCurrentProcessId())+L"-pipe-nt-0x1";
        if(diagnostic)name+=L"-diagnostic-"+std::to_wstring(appSidMask);
        server.value=create_server(0x00080001,true);require(server.value!=INVALID_HANDLE_VALUE,"pipe-original-default-server");readback(false);Handle denied;const DWORD error=open_client(name,false,denied);require(error==0xc0000022u,"pipe-original-default-writer-not-denied");require(CloseHandle(server.value)!=0,"pipe-default-server-close");server.value=nullptr;
      }
      server.value=create_server(0x00080001);require(server.value!=INVALID_HANDLE_VALUE,"pipe-exact-server-create");readback();exact_sync_positive();
      server.value=create_server(0x40080001);require(server.value!=INVALID_HANDLE_VALUE,"pipe-overlapped-server-create");connectEvent.value=CreateEventW(nullptr,TRUE,FALSE,nullptr);require(connectEvent.value!=nullptr,"pipe-connect-event-create");
      alignas(void*) std::array<BYTE,4096> buffer{};ULONG needed=0;NTSTATUS queried=queryObject(server.value,static_cast<OBJECT_INFORMATION_CLASS>(1),buffer.data(),static_cast<ULONG>(buffer.size()),&needed);require(queried==0,"pipe-handle-name-query");auto object=reinterpret_cast<UNICODE_STRING*>(buffer.data());
      require(object->Length%sizeof(wchar_t)==0&&object->Length<2048&&object->Buffer,"pipe-handle-name-bound");kernelName.assign(object->Buffer,object->Length/sizeof(wchar_t));readback();
    }catch(...){if(user){LocalFree(user);user=nullptr;}if(container){LocalFree(container);container=nullptr;}throw;}
  }
  PipeProof(const PipeProof&)=delete;
  PipeProof& operator=(const PipeProof&)=delete;
  ~PipeProof(){if(!closed){try{join_listener(true);}catch(...){fatal_cleanup();}}if(user)LocalFree(user);if(container)LocalFree(container);}
  bool available(){PipeLocal info{};IO_STATUS_BLOCK io{};NTSTATUS result=queryFile(server.value,&io,&info,sizeof(info),static_cast<FILE_INFORMATION_CLASS>(24));if(result==static_cast<NTSTATUS>(0x103))fatal_cleanup();return result==0&&info.state==2&&info.current==1;}
  void positive(bool minimal){
    require(available(),"pipe-positive-server-not-free");Handle client;open_client(name,minimal,client);require(client.value!=INVALID_HANDLE_VALUE,"pipe-own-client-open");join_listener(false);require(connected,"pipe-own-connect");
    if(!minimal)roundtrip(client.value,true);
    require(CloseHandle(client.value)!=0,"pipe-own-client-close");client.value=nullptr;disconnect();
  }
  void before(){start_listener();positive(false);ownBefore=true;positive(true);minimalBefore=true;require(available(),"pipe-before-not-free");}
  void inherited_writer(){
    require(diagnostic&&ordinary&&available(),"raw-inherited-fixture");
    Handle writer;open_client(name,false,writer);require(writer.value!=INVALID_HANDLE_VALUE,"raw-inherited-writer-open");join_listener(false);readback(true,writer.value);
    line("{\"kind\":\"rawpipe-parent-handle\",\"nonce\":"+quote(nonce)+",\"appSidMask\":"+std::to_string(appSidMask)+",\"role\":\"writer\","+raw_pipe_handle(api,writer.value)+"}");
    line("{\"kind\":\"rawpipe-parent-handle\",\"nonce\":"+quote(nonce)+",\"appSidMask\":"+std::to_string(appSidMask)+",\"role\":\"reader\","+raw_pipe_handle(api,server.value)+"}");
    DWORD flags=0;require(GetHandleInformation(writer.value,&flags)&&(flags&HANDLE_FLAG_INHERIT),"raw-writer-inherit-flag");
    std::array<Handle,3> streams;const std::array<DWORD,3> kinds={STD_INPUT_HANDLE,STD_OUTPUT_HANDLE,STD_ERROR_HANDLE};
    for(size_t i=0;i<streams.size();++i)require(DuplicateHandle(GetCurrentProcess(),GetStdHandle(kinds[i]),GetCurrentProcess(),&streams[i].value,0,TRUE,DUPLICATE_SAME_ACCESS)!=0,"raw-child-standard-stream");
    std::array<HANDLE,4> inherited={writer.value,streams[0].value,streams[1].value,streams[2].value};
    require(std::find(inherited.begin(),inherited.end(),server.value)==inherited.end(),"raw-reader-not-in-handle-list");
    SIZE_T needed=0;InitializeProcThreadAttributeList(nullptr,1,0,&needed);require(needed&&needed<8192,"raw-child-attribute-size");std::vector<BYTE> storage(needed);
    auto attributesList=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());require(InitializeProcThreadAttributeList(attributesList,1,0,&needed)!=0,"raw-child-attribute-init");
    bool attributesLive=true;Handle child,thread;bool childClosed=false,forced=false;DWORD childPid=0,exitCode=STILL_ACTIVE;
    auto closeChild=[&](){if(child.value&&!childClosed){if(WaitForSingleObject(child.value,0)!=WAIT_OBJECT_0){forced=true;if(!TerminateProcess(child.value,124)||WaitForSingleObject(child.value,2000)!=WAIT_OBJECT_0)fatal_cleanup();}childClosed=true;}};
    try{
      require(UpdateProcThreadAttribute(attributesList,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited.data(),sizeof(inherited),nullptr,nullptr)!=0,"raw-child-handle-list");
      std::array<wchar_t,MAX_PATH> image{};DWORD length=GetModuleFileNameW(nullptr,image.data(),static_cast<DWORD>(image.size()));require(length&&length<image.size(),"raw-child-image");
      std::wstring command=L"\""+std::wstring(image.data())+L"\" rawpipe-writer "+std::to_wstring(reinterpret_cast<uintptr_t>(writer.value))+L" "+std::wstring(nonce.begin(),nonce.end())+L" "+std::to_wstring(appSidMask)+L" "+std::to_wstring(GetCurrentProcessId());
      STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;startup.StartupInfo.hStdInput=streams[0].value;startup.StartupInfo.hStdOutput=streams[1].value;startup.StartupInfo.hStdError=streams[2].value;startup.lpAttributeList=attributesList;PROCESS_INFORMATION process{};
      BOOL created=CreateProcessW(image.data(),command.data(),nullptr,nullptr,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_NO_WINDOW,nullptr,nullptr,&startup.StartupInfo,&process);DWORD createError=created?0:GetLastError();
      if(created){child.value=process.hProcess;thread.value=process.hThread;childPid=process.dwProcessId;}
      DeleteProcThreadAttributeList(attributesList);attributesLive=false;
      line("{\"kind\":\"rawpipe-child-created\",\"nonce\":"+quote(nonce)+",\"appSidMask\":"+std::to_string(appSidMask)+",\"created\":"+(created?"true":"false")+",\"error\":"+std::to_string(createError)+",\"childPid\":"+std::to_string(childPid)+",\"pipeReaderExcluded\":true,\"explicitHandleList\":true}");
      require(created!=FALSE,"raw-child-create");require(CloseHandle(writer.value)!=0,"raw-parent-writer-close");writer.value=nullptr;
      DWORD waited=WaitForSingleObject(child.value,7000);if(waited!=WAIT_OBJECT_0)closeChild();else childClosed=true;
      require(GetExitCodeProcess(child.value,&exitCode)!=0,"raw-child-exit-code");
      line("{\"kind\":\"rawpipe-child-closed\",\"nonce\":"+quote(nonce)+",\"appSidMask\":"+std::to_string(appSidMask)+",\"childPid\":"+std::to_string(childPid)+",\"exitCode\":"+std::to_string(exitCode)+",\"childClosed\":true,\"forced\":"+(forced?"true":"false")+",\"parentWriterClosed\":true}");
      require(!forced,"raw-child-deadline");
      std::string expected="RAW_PIPE_"+nonce;std::array<char,128> actual{};DWORD count=transfer(server.value,false,true,actual.data(),static_cast<DWORD>(actual.size()));
      require(count==expected.size()&&memcmp(actual.data(),expected.data(),count)==0,"raw-inherited-readback");
      char byte=0;require(transfer(server.value,false,true,&byte,1,true)==0&&lastTransferEof,"raw-inherited-eof");
      require(exitCode==0,"raw-child-write-failed");
      line("{\"kind\":\"rawpipe-roundtrip\",\"nonce\":"+quote(nonce)+",\"appSidMask\":"+std::to_string(appSidMask)+",\"sentinelMatched\":true,\"transferBytes\":"+std::to_string(expected.size())+",\"parentWriterClosedBeforeRead\":true,\"childClosedBeforeEof\":true,\"eof\":true}");
    }catch(...){if(attributesLive)DeleteProcThreadAttributeList(attributesList);closeChild();throw;}
  }
  void tracker(){
    require(ordinary,"tracker-default-template-required");
    SECURITY_ATTRIBUTES original={sizeof(SECURITY_ATTRIBUTES),&originalDescriptor,FALSE};
    HANDLE originalRead=nullptr,originalWrite=nullptr;
    const BOOL originalResult=CreatePipe(&originalRead,&originalWrite,&original,16);
    const DWORD originalError=originalResult?ERROR_SUCCESS:GetLastError();
    line("{\"kind\":\"tracker-original\",\"explicitCanonicalObjectDescriptor\":true,\"tokenDefaultUsed\":false,\"success\":"+std::string(originalResult?"true":"false")+",\"error\":"+std::to_string(originalError)+",\"failedOutputsInspected\":false}");
    // FALSE leaves both outputs undefined. They enter ownership only on TRUE.
    if(originalResult){Handle read,write;read.value=originalRead;write.value=originalWrite;
      require(read.value&&write.value&&read.value!=INVALID_HANDLE_VALUE&&write.value!=INVALID_HANDLE_VALUE&&read.value!=write.value,"tracker-original-handles");
      require(CloseHandle(write.value)!=0,"tracker-original-write-close");write.value=nullptr;require(CloseHandle(read.value)!=0,"tracker-original-read-close");read.value=nullptr;}
    HANDLE rawRead=nullptr,rawWrite=nullptr;
    const BOOL result=CreatePipe(&rawRead,&rawWrite,&attributes,16);
    const DWORD error=result?ERROR_SUCCESS:GetLastError();
    line("{\"kind\":\"tracker-adapted-create\",\"success\":"+std::string(result?"true":"false")+",\"error\":"+std::to_string(error)+",\"failedOutputsInspected\":false}");
    require(result!=FALSE,"tracker-adapted-create-failed");
    Handle read,write;read.value=rawRead;write.value=rawWrite;
    require(read.value&&write.value&&read.value!=INVALID_HANDLE_VALUE&&write.value!=INVALID_HANDLE_VALUE&&read.value!=write.value,"tracker-adapted-handles");
    const DWORD readType=GetFileType(read.value),writeType=GetFileType(write.value);
    DWORD readFlags=0,writeFlags=0;require(GetHandleInformation(read.value,&readFlags)&&GetHandleInformation(write.value,&writeFlags),"tracker-initial-flags");
    require(readType==FILE_TYPE_PIPE&&writeType==FILE_TYPE_PIPE&&readFlags==0&&writeFlags==0,"tracker-initial-type-inheritance");
    readback(true,read.value);readback(true,write.value);
    require(SetHandleInformation(write.value,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT)!=0,"tracker-set-writer-inherit");
    require(GetHandleInformation(read.value,&readFlags)&&GetHandleInformation(write.value,&writeFlags)&&readFlags==0&&writeFlags==HANDLE_FLAG_INHERIT,"tracker-writer-only-inherited");
    std::string marker=nonce.substr(0,16);std::array<char,16> actual{};
    require(marker.size()==16&&transfer(write.value,true,false,marker.data(),16)==16,"tracker-write");
    require(transfer(read.value,false,false,actual.data(),16)==16&&memcmp(marker.data(),actual.data(),16)==0,"tracker-readback");
    require(CloseHandle(write.value)!=0,"tracker-writer-close");write.value=nullptr;
    // Establish the broken/empty endpoint before the synchronous EOF read, so
    // an unexpected surviving writer is a failure rather than a blocking read.
    DWORD available=0;const BOOL peek=PeekNamedPipe(read.value,nullptr,0,nullptr,&available,nullptr);const DWORD peekError=peek?ERROR_SUCCESS:GetLastError();
    require(!peek&&peekError==ERROR_BROKEN_PIPE,"tracker-writer-still-open");
    char byte=0;DWORD readBytes=0;const BOOL eof=ReadFile(read.value,&byte,1,&readBytes,nullptr);const DWORD eofError=eof?ERROR_SUCCESS:GetLastError();
    require(!eof&&eofError==ERROR_BROKEN_PIPE&&readBytes==0,"tracker-eof-after-writer-close");
    require(CloseHandle(read.value)!=0,"tracker-reader-close");read.value=nullptr;
    line("{\"kind\":\"tracker-proof\",\"originalSuccess\":"+std::string(originalResult?"true":"false")+",\"originalError\":"+std::to_string(originalError)+",\"adaptedSuccess\":true,\"readType\":"+std::to_string(readType)+",\"writeType\":"+std::to_string(writeType)+",\"initialReadFlags\":0,\"initialWriteFlags\":0,\"finalReadFlags\":"+std::to_string(readFlags)+",\"finalWriteFlags\":"+std::to_string(writeFlags)+",\"transferBytes\":16,\"writerClosedBeforeEof\":true,\"eofError\":"+std::to_string(eofError)+",\"handlesClosed\":true,\"failedOutputsInspected\":false}");
  }

  std::pair<DWORD,DWORD> foreign(const std::wstring& peer,const std::wstring& peerRoot){
    // The ready record names an existing held object in the peer's NPFS root.
    // A Win32/relative leaf would instead resolve in this caller's namespace.
    const std::wstring prefix=L"\\Device\\NamedPipe"+peerRoot+L"\\"+(ordinary?key+L"-":L"msys-"+key+L"-"),suffix=ordinary?L"-pipe-nt-0x1":L"-sigwait";
    require(peerRoot!=id.root&&peer.starts_with(prefix)&&peer.ends_with(suffix)&&peer!=kernelName,"pipe-peer-kernel-name");
    auto pid=peer.substr(prefix.size(),peer.size()-prefix.size()-suffix.size());require(!pid.empty()&&pid.size()<=10&&pid[0]!=L'0'&&pid.find_first_not_of(L"0123456789")==std::wstring::npos,"pipe-peer-pid");
    require(std::stoull(pid)<=MAXDWORD,"pipe-peer-pid-bound");
    auto openNative=api.load<NativeOpen>("NtOpenFile");using NativeError=ULONG(NTAPI*)(NTSTATUS);auto dosError=api.load<NativeError>("RtlNtStatusToDosError");require(openNative&&dosError,"pipe-peer-native-exports");
    auto open=[&](bool minimal){
      std::wstring target=peer;Name object(target,nullptr,nullptr,ordinary?OBJ_INHERIT:0);IO_STATUS_BLOCK io{};HANDLE output=nullptr;
      const ACCESS_MASK access=minimal?FILE_WRITE_DATA:0x40100080u;const ULONG options=(!ordinary&&!minimal)?0x20u:0u;
      const NTSTATUS value=openNative(&output,access,&object.attributes,&io,0,options);if(value==static_cast<NTSTATUS>(0x103))fatal_cleanup();
      Handle client;if(value>=0)client.value=output; // Failed NT outputs are indeterminate.
      const DWORD result=ordinary?static_cast<DWORD>(value):dosError(value);
      line("{\"kind\":\"pipe-foreign-target\",\"ordinary\":"+std::string(ordinary?"true":"false")+",\"target\":"+quote(utf8(peer))+",\"peerRoot\":"+quote(utf8(peerRoot))+",\"absoluteKernelTarget\":true,\"access\":"+std::to_string(access)+",\"options\":"+std::to_string(options)+",\"objectAttributes\":"+std::to_string(object.attributes.Attributes)+",\"minimalWriteData\":"+std::string(minimal?"true":"false")+",\"nativeStatus\":"+status(value)+",\"reportedResult\":"+std::to_string(result)+"}");return result;
    };
    DWORD writer=open(false),data=open(true);positive(false);ownAfter=true;positive(true);minimalAfter=true;require(available(),"pipe-after-not-free");return{writer,data};
  }
  void finish(){
    join_listener(true);require(CloseHandle(server.value)!=0,"pipe-server-close");server.value=nullptr;
    Handle missingClient;DWORD missingError=open_client(name,false,missingClient);require(ordinary?(missingError==0xc0000034u||missingError==0xc000003au):missingError==ERROR_FILE_NOT_FOUND,"pipe-last-handle-not-released");
    Handle recreated;recreated.value=create_server(0x00080001);require(recreated.value!=INVALID_HANDLE_VALUE,"pipe-first-instance-not-reusable");require(CloseHandle(recreated.value)!=0,"pipe-recreated-close");recreated.value=nullptr;closed=true;
    if(npfs.value){require(CloseHandle(npfs.value)!=0,"pipe-npfs-root-close");npfs.value=nullptr;}
    if(ordinary)observe_token_default(true);
    line("{\"kind\":\"pipe-cleanup\",\"fixture\":"+quote(ordinary?"ordinary-nt":"signal-win32")+",\"pendingConnectCompleted\":true,\"lastHandleAbsent\":true,\"firstInstanceRecreatedAndClosed\":true}");
  }
};

int wmain(int argc,wchar_t** argv){
  try{
    if(argc==2&&std::wstring(argv[1])==L"breakaway-child")return 0;
    if(argc>1&&std::wstring(argv[1])==L"rawpipe-writer")return raw_pipe_writer(argc,argv);
    if(argc>1&&std::wstring(argv[1])==L"job-proof-native-child")return job_proof_native_child(argc,argv);
    require(argc==6,"arguments");std::wstring mode=argv[1],key=argv[2],nonce=argv[3];require(lowerHex(key,16)&&lowerHex(nonce,24),"fixed-identity");
    DWORD workerPid=static_cast<DWORD>(std::stoul(argv[4])),executorPid=static_cast<DWORD>(std::stoul(argv[5]));require(workerPid&&executorPid&&workerPid!=executorPid,"process-identities");
    Api api;Identity id=identity(api);std::wstring gd=absolute(id.root,globalLeaf(key)),sd=id.session?absolute(id.root,sessionLeaf(id.session,key)):gd;
    std::wstring eventLeaf=L"isolation-event-"+nonce,sectionLeaf=L"isolation-section-"+nonce;
    if(mode==L"rawpipe"){
      raw_pipe_job_observation("parent",nonce);
      int succeeded=0;
      for(DWORD mask:std::array<DWORD,2>{0x00120196,0x0012019f}){
        bool passed=false;std::string error;
        try{PipeProof pipe(id,api,key,nonce,true,mask,true);pipe.before();pipe.inherited_writer();pipe.finish();passed=true;++succeeded;}
        catch(const std::exception& failure){error=failure.what();}
        line("{\"kind\":\"rawpipe-case\",\"nonce\":"+quote(utf8(nonce))+",\"appSidMask\":"+std::to_string(mask)+",\"diagnosticOnly\":true,\"roundtripPassed\":"+(passed?"true":"false")+",\"error\":"+quote(error)+"}");
      }
      line("{\"kind\":\"rawpipe-summary\",\"nonce\":"+quote(utf8(nonce))+",\"diagnosticOnly\":true,\"rawProbeUnshimmed\":true,\"runtimeGrantsChanged\":false,\"casesCompleted\":2,\"casesPassed\":"+std::to_string(succeeded)+"}");return 0;
    }
    job_proof_through_native_child(workerPid,executorPid,id,nonce);
    if(mode==L"identity"){line("{\"kind\":\"identity\","+identityFields(id)+"}");return 0;}
    if(mode==L"absent"){
      Handle g,s;NTSTATUS gs=openDir(api,gd,g),ss=openDir(api,sd,s);
      line("{\"kind\":\"absence\","+identityFields(id)+",\"globalDirectory\":"+status(gs)+",\"sessionDirectory\":"+status(ss)+"}");require(missing(gs)&&missing(ss),"namespace-still-live");return 0;
    }
    require(mode==L"hold","mode");Handle g,s,event,section;NTSTATUS gs=openDir(api,gd,g),ss=openDir(api,sd,s);require(gs==0&&ss==0,"redirected-directory-open");
    // Match MSYS child-object behavior: an explicit NULL DACL, not a stronger
    // test ACL that could hide a namespace traversal/isolation failure.
    SECURITY_DESCRIPTOR security{};require(InitializeSecurityDescriptor(&security,SECURITY_DESCRIPTOR_REVISION)!=0,"sd-init");require(SetSecurityDescriptorDacl(&security,TRUE,nullptr,FALSE)!=0,"null-dacl");
    Name eventName(eventLeaf,g.value,&security);NTSTATUS es=api.createEvent(&event.value,EVENT_ALL_ACCESS,&eventName.attributes,0,FALSE);require(es==0,"own-event-create");
    LARGE_INTEGER size{};size.QuadPart=4096;Name sectionName(sectionLeaf,g.value,&security);NTSTATUS ms=api.createSection(&section.value,0xf001f,&sectionName.attributes,&size,PAGE_READWRITE,SEC_COMMIT,nullptr);require(ms==0,"own-section-create");
    View view;view.value=MapViewOfFile(section.value,FILE_MAP_READ|FILE_MAP_WRITE,0,0,4096);require(view.value!=nullptr,"own-section-map");std::string marker="NEMOCLAW_SECTION_"+utf8(nonce);memcpy(view.value,marker.data(),marker.size());require(memcmp(view.value,marker.data(),marker.size())==0,"own-section-readback");
    PipeProof pipe(id,api,key,nonce);pipe.before();
    PipeProof ordinaryPipe(id,api,key,nonce,true);ordinaryPipe.before();ordinaryPipe.tracker();
    line("{\"kind\":\"ready\","+identityFields(id)+",\"key\":"+quote(utf8(key))+",\"globalDirectory\":"+quote(utf8(gd))+",\"sessionDirectory\":"+quote(utf8(sd))+",\"nullDaclChildren\":true,\"ownEvent\":"+status(es)+",\"ownSection\":"+status(ms)+",\"ownSectionReadback\":true,\"pipeExactSynchronousPositive\":"+std::string(pipe.exactSynchronousPositive?"true":"false")+",\"pipeOverlappedFixture\":true,\"pipeName\":"+quote(utf8(pipe.name))+",\"pipeKernelName\":"+quote(utf8(pipe.kernelName))+",\"pipeAvailable\":true,\"pipeDescriptorMatched\":true,\"ordinaryPipeName\":"+quote(utf8(ordinaryPipe.name))+",\"ordinaryPipeKernelName\":"+quote(utf8(ordinaryPipe.kernelName))+",\"ordinaryExactSynchronousPositive\":true,\"ordinaryOverlappedFixture\":true,\"ordinaryPipeAvailable\":true,\"ordinaryDescriptorMatched\":true,\"trackerComplete\":true}");
    bool checked=false;
    for(int count=0;count<3;++count){
      std::string command=readLine();
      if(command=="stop"){ordinaryPipe.finish();pipe.finish();line("{\"kind\":\"closed\",\"checked\":"+std::string(checked?"true":"false")+"}");return 0;}
      require(!checked&&command.starts_with("check "),"command");const size_t delimiter=command.find(' ',6);require(delimiter!=std::string::npos,"peer-pipe-command");const size_t second=command.find(' ',delimiter+1);require(second!=std::string::npos,"peer-ordinary-command");std::wstring other(command.begin()+6,command.begin()+delimiter),peerPipe(command.begin()+delimiter+1,command.begin()+second),peerOrdinary(command.begin()+second+1,command.end());
      auto split=id.root.rfind(L'\\');require(split!=std::wstring::npos&&other.starts_with(id.root.substr(0,split+1))&&other!=id.root,"foreign-root");std::wstring sid=other.substr(split+1);PSID parsed=nullptr;require(ConvertStringSidToSidW(sid.c_str(),&parsed)!=0,"foreign-sid");bool valid=IsValidSid(parsed)&&sid.starts_with(L"S-1-15-2-");LocalFree(parsed);require(valid,"foreign-sid-family");
      std::wstring foreign=absolute(other,globalLeaf(key)),foreignSession=id.session?absolute(other,sessionLeaf(id.session,key)):foreign;
      std::wstring ep=absolute(foreign,eventLeaf),mp=absolute(foreign,sectionLeaf);
      // Each minimal right is requested independently. Denial of ALL_ACCESS
      // alone would not rule out a usable synchronization or mapping handle.
      auto directory=[&](std::wstring name,ACCESS_MASK mask){Handle opened;Name object(name);return api.openDirectory(&opened.value,mask,&object.attributes);};
      auto eventOpen=[&](ACCESS_MASK mask){Handle opened;Name object(ep);return api.openEvent(&opened.value,mask,&object.attributes);};
      auto sectionOpen=[&](ACCESS_MASK mask){Handle opened;Name object(mp);return api.openSection(&opened.value,mask,&object.attributes);};
      std::vector<std::pair<std::string,NTSTATUS>> checks={
        {"foreignDirectory",directory(foreign,0x2000f)},
        {"foreignGlobalQuery",directory(foreign,0x1)},
        {"foreignGlobalCreateObject",directory(foreign,0x4)},
        {"foreignGlobalCreateSubdirectory",directory(foreign,0x8)},
        {"foreignSessionQuery",directory(foreignSession,0x1)},
        {"foreignSessionCreateObject",directory(foreignSession,0x4)},
        {"foreignSessionCreateSubdirectory",directory(foreignSession,0x8)},
        {"foreignEvent",eventOpen(EVENT_ALL_ACCESS)},
        {"foreignEventSynchronize",eventOpen(SYNCHRONIZE)},
        {"foreignEventModifyState",eventOpen(EVENT_MODIFY_STATE)},
        {"foreignSection",sectionOpen(SECTION_MAP_READ)},
        {"foreignSectionMapWrite",sectionOpen(SECTION_MAP_WRITE)}
      };
      std::wstring original=L"\\BaseNamedObjects\\msys-2.0S5-"+key;Name originalName(original,nullptr,&security,0x80);Handle glob;
      checks.emplace_back("originalGlobalCreate",api.createDirectory(&glob.value,0x2000f,&originalName.attributes));
      std::string fields;bool allDenied=true;constexpr auto denied=static_cast<NTSTATUS>(0xc0000022u);
      for(const auto& check:checks){fields+=","+quote(check.first)+":"+status(check.second);allDenied=allDenied&&check.second==denied;}
      const auto pipeDenials=pipe.foreign(peerPipe,other);const auto ordinaryDenials=ordinaryPipe.foreign(peerOrdinary,other);
      line("{\"kind\":\"denials\","+identityFields(id)+",\"foreignRoot\":"+quote(utf8(other))+fields+",\"pipeForeignWriter\":"+std::to_string(pipeDenials.first)+",\"pipeForeignWriteData\":"+std::to_string(pipeDenials.second)+",\"pipeOwnBefore\":"+std::string(pipe.ownBefore?"true":"false")+",\"pipeOwnMinimalBefore\":"+std::string(pipe.minimalBefore?"true":"false")+",\"pipeOwnAfter\":"+std::string(pipe.ownAfter?"true":"false")+",\"pipeOwnMinimalAfter\":"+std::string(pipe.minimalAfter?"true":"false")+",\"pipeServerAvailableAfter\":true,\"ordinaryForeignWriter\":"+status(static_cast<NTSTATUS>(ordinaryDenials.first))+",\"ordinaryForeignWriteData\":"+status(static_cast<NTSTATUS>(ordinaryDenials.second))+",\"ordinaryOwnBefore\":"+std::string(ordinaryPipe.ownBefore?"true":"false")+",\"ordinaryOwnMinimalBefore\":"+std::string(ordinaryPipe.minimalBefore?"true":"false")+",\"ordinaryOwnAfter\":"+std::string(ordinaryPipe.ownAfter?"true":"false")+",\"ordinaryOwnMinimalAfter\":"+std::string(ordinaryPipe.minimalAfter?"true":"false")+",\"ordinaryServerAvailableAfter\":true}");
      require(allDenied&&pipeDenials.first==ERROR_ACCESS_DENIED&&pipeDenials.second==ERROR_ACCESS_DENIED&&ordinaryDenials.first==0xc0000022u&&ordinaryDenials.second==0xc0000022u,"isolation-denial-failed");checked=true;
    }
    throw std::runtime_error("command-count");
  }catch(const std::exception& error){line("{\"kind\":\"failure\",\"error\":"+quote(error.what())+",\"win32\":"+std::to_string(GetLastError())+"}");return 1;}
}
