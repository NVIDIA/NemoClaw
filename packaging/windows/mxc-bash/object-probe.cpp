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
// Raw pipe fixture: no compatibility exports or hooks. Every handle belongs to
// this probe. Exact synchronous behavior is checked first; the independent
// isolation fixture then uses overlapped I/O for bounded observation/cleanup.
class PipeProof {
  const Identity& id;
  Api& api;
  std::wstring key;
  std::string nonce;
  Handle server;
  Handle connectEvent;
  OVERLAPPED connectOperation{};
  bool connectPending=false;
  bool connected=false;
  SECURITY_DESCRIPTOR descriptor{};
  SECURITY_ATTRIBUTES attributes{};
  std::array<DWORD,512/sizeof(DWORD)> aclStorage{};
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
  void roundtrip(HANDLE client,bool overlapped){
    std::string bytes="NEMOCLAW_PIPE_"+nonce;DWORD written=0,read=0;std::array<char,128> actual{};
    require(WriteFile(client,bytes.data(),static_cast<DWORD>(bytes.size()),&written,nullptr)!=0&&written==bytes.size(),"pipe-own-write");
    if(!overlapped){require(ReadFile(server.value,actual.data(),static_cast<DWORD>(actual.size()),&read,nullptr)!=0,"pipe-sync-read");}
    else{
      Handle event;event.value=CreateEventW(nullptr,TRUE,FALSE,nullptr);require(event.value!=nullptr,"pipe-read-event");OVERLAPPED operation{};operation.hEvent=event.value;
      BOOL ok=ReadFile(server.value,actual.data(),static_cast<DWORD>(actual.size()),nullptr,&operation);DWORD error=ok?0:GetLastError();
      if(!ok){require(error==ERROR_IO_PENDING,"pipe-read-submit");
        if(WaitForSingleObject(event.value,2000)!=WAIT_OBJECT_0){
          if(!CancelIoEx(server.value,&operation)&&GetLastError()!=ERROR_NOT_FOUND)fatal_cleanup();
          if(WaitForSingleObject(event.value,2000)!=WAIT_OBJECT_0)fatal_cleanup();DWORD ignored=0;BOOL drained=GetOverlappedResult(server.value,&operation,&ignored,FALSE);if(!drained&&GetLastError()!=ERROR_OPERATION_ABORTED)fatal_cleanup();
          throw std::runtime_error("pipe-read-deadline");
        }
      }
      require(GetOverlappedResult(server.value,&operation,&read,FALSE)!=0,"pipe-read-result");
    }
    require(read==bytes.size()&&memcmp(actual.data(),bytes.data(),read)==0,"pipe-own-readback");
  }
  void exact_sync_positive(){
    Handle client;client.value=CreateFileW(name.c_str(),0x40000080,0,nullptr,OPEN_EXISTING,0,nullptr);require(client.value!=INVALID_HANDLE_VALUE,"pipe-exact-writer-open");roundtrip(client.value,false);
    require(CloseHandle(client.value)!=0,"pipe-sync-client-close");client.value=nullptr;require(CloseHandle(server.value)!=0,"pipe-sync-server-close");server.value=nullptr;exactSynchronousPositive=true;
  }
  void disconnect(){require(DisconnectNamedPipe(server.value)!=0,"pipe-disconnect");start_listener();}
  void readback(){
    PACL acl=nullptr;PSECURITY_DESCRIPTOR sd=nullptr;DWORD error=GetSecurityInfo(server.value,SE_KERNEL_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,&acl,nullptr,&sd);
    require(error==ERROR_SUCCESS&&sd,"pipe-security-readback");
    try{
      require(acl&&acl->AceCount==4,"pipe-readback-ace-count");SECURITY_DESCRIPTOR_CONTROL control=0;DWORD revision=0;require(GetSecurityDescriptorControl(sd,&control,&revision)!=0,"pipe-readback-control");
      std::array<PSID,4> sids={user,adminSid.data(),systemSid.data(),container};std::string fields;
      for(DWORD index=0;index<4;++index){PVOID raw=nullptr;require(GetAce(acl,index,&raw)!=0,"pipe-readback-ace");auto ace=static_cast<ACCESS_ALLOWED_ACE*>(raw);
        require(ace->Header.AceType==ACCESS_ALLOWED_ACE_TYPE&&ace->Header.AceFlags==0&&EqualSid(&ace->SidStart,sids[index]),"pipe-readback-principal");
        DWORD original=index==3?0x00120196:GENERIC_ALL,mapped=original;GENERIC_MAPPING mapping={FILE_GENERIC_READ,FILE_GENERIC_WRITE,FILE_GENERIC_EXECUTE,FILE_ALL_ACCESS};MapGenericMask(&mapped,&mapping);
        require(ace->Mask==original||ace->Mask==mapped,"pipe-readback-mask");if(index)fields+=",";fields+=std::to_string(ace->Mask);
      }
      line("{\"kind\":\"pipe-descriptor\",\"rawProbeUnshimmed\":true,\"inputControl\":4,\"actualControl\":"+std::to_string(control)+",\"aceCount\":4,\"aceMasks\":["+fields+"],\"actualTokenSidsMatched\":true,\"genericMappingOnly\":true}");
    }catch(...){LocalFree(sd);throw;}LocalFree(sd);
  }
  HANDLE create_server(DWORD mode){return CreateNamedPipeW(name.c_str(),mode,0x0000000c,1,65472,65472,0,&attributes);}
 public:
  std::wstring name;
  std::wstring kernelName;
  bool exactSynchronousPositive=false,ownBefore=false,minimalBefore=false,ownAfter=false,minimalAfter=false;
  PipeProof(const Identity& identity,Api& calls,const std::wstring& installationKey,const std::wstring& marker):id(identity),api(calls),key(installationKey),nonce(utf8(marker)){
    queryFile=api.load<QueryFile>("NtQueryInformationFile");queryObject=api.load<QueryObject>("NtQueryObject");require(queryFile&&queryObject,"pipe-native-queries");
    try{
      require(ConvertStringSidToSidW(id.userSid.c_str(),&user)!=0&&ConvertStringSidToSidW(id.sid.c_str(),&container)!=0,"pipe-token-sids");
      DWORD size=static_cast<DWORD>(sizeof(adminSid));require(CreateWellKnownSid(WinBuiltinAdministratorsSid,nullptr,adminSid.data(),&size)!=0,"pipe-admin-sid");size=static_cast<DWORD>(sizeof(systemSid));require(CreateWellKnownSid(WinLocalSystemSid,nullptr,systemSid.data(),&size)!=0,"pipe-system-sid");
      const size_t aclBytes=sizeof(ACL)+4*(sizeof(ACCESS_ALLOWED_ACE)-sizeof(DWORD))+GetLengthSid(user)+GetLengthSid(adminSid.data())+GetLengthSid(systemSid.data())+GetLengthSid(container);require(aclBytes<=sizeof(aclStorage),"pipe-acl-bound");
      auto acl=reinterpret_cast<PACL>(aclStorage.data());require(InitializeAcl(acl,static_cast<DWORD>(aclBytes),ACL_REVISION)!=0,"pipe-acl-init");
      for(PSID sid:std::array<PSID,3>{user,adminSid.data(),systemSid.data()})require(AddAccessAllowedAceEx(acl,ACL_REVISION,0,GENERIC_ALL,sid)!=0,"pipe-original-ace");
      require(AddAccessAllowedAceEx(acl,ACL_REVISION,0,0x00120196,container)!=0,"pipe-container-ace");
      require(InitializeSecurityDescriptor(&descriptor,SECURITY_DESCRIPTOR_REVISION)!=0&&SetSecurityDescriptorDacl(&descriptor,TRUE,acl,FALSE)!=0,"pipe-descriptor-init");attributes={sizeof(attributes),&descriptor,FALSE};
      name=L"\\\\.\\pipe\\msys-"+key+L"-"+std::to_wstring(GetCurrentProcessId())+L"-sigwait";
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
    require(available(),"pipe-positive-server-not-free");Handle client;client.value=CreateFileW(name.c_str(),minimal?FILE_WRITE_DATA:0x40000080,0,nullptr,OPEN_EXISTING,minimal?FILE_FLAG_OVERLAPPED:0,nullptr);require(client.value!=INVALID_HANDLE_VALUE,"pipe-own-client-open");join_listener(false);require(connected,"pipe-own-connect");
    if(!minimal)roundtrip(client.value,true);
    require(CloseHandle(client.value)!=0,"pipe-own-client-close");client.value=nullptr;disconnect();
  }
  void before(){start_listener();positive(false);ownBefore=true;positive(true);minimalBefore=true;require(available(),"pipe-before-not-free");}
  std::pair<DWORD,DWORD> foreign(const std::wstring& peer){
    const std::wstring prefix=L"\\\\.\\pipe\\msys-"+key+L"-",suffix=L"-sigwait";require(peer.starts_with(prefix)&&peer.ends_with(suffix)&&peer!=name,"pipe-peer-name");
    auto pid=peer.substr(prefix.size(),peer.size()-prefix.size()-suffix.size());require(!pid.empty()&&pid.size()<=10&&pid[0]!=L'0'&&pid.find_first_not_of(L"0123456789")==std::wstring::npos,"pipe-peer-pid");
    auto open=[&](bool minimal){Handle client;client.value=CreateFileW(peer.c_str(),minimal?FILE_WRITE_DATA:0x40000080,0,nullptr,OPEN_EXISTING,minimal?FILE_FLAG_OVERLAPPED:0,nullptr);return client.value==INVALID_HANDLE_VALUE?GetLastError():ERROR_SUCCESS;};
    DWORD writer=open(false),data=open(true);positive(false);ownAfter=true;positive(true);minimalAfter=true;require(available(),"pipe-after-not-free");return{writer,data};
  }
  void finish(){
    join_listener(true);require(CloseHandle(server.value)!=0,"pipe-server-close");server.value=nullptr;
    Handle missingClient;missingClient.value=CreateFileW(name.c_str(),0x40000080,0,nullptr,OPEN_EXISTING,0,nullptr);DWORD missingError=missingClient.value==INVALID_HANDLE_VALUE?GetLastError():0;require(missingError==ERROR_FILE_NOT_FOUND,"pipe-last-handle-not-released");
    Handle recreated;recreated.value=create_server(0x00080001);require(recreated.value!=INVALID_HANDLE_VALUE,"pipe-first-instance-not-reusable");require(CloseHandle(recreated.value)!=0,"pipe-recreated-close");recreated.value=nullptr;closed=true;
    line("{\"kind\":\"pipe-cleanup\",\"pendingConnectCompleted\":true,\"lastHandleAbsent\":true,\"firstInstanceRecreatedAndClosed\":true}");
  }
};

int wmain(int argc,wchar_t** argv){
  try{
    if(argc==2&&std::wstring(argv[1])==L"breakaway-child")return 0;
    require(argc==6,"arguments");std::wstring mode=argv[1],key=argv[2],nonce=argv[3];require(lowerHex(key,16)&&lowerHex(nonce,24),"fixed-identity");
    DWORD workerPid=static_cast<DWORD>(std::stoul(argv[4])),executorPid=static_cast<DWORD>(std::stoul(argv[5]));require(workerPid&&executorPid&&workerPid!=executorPid,"process-identities");
    Api api;Identity id=identity(api);jobProof(workerPid,executorPid);std::wstring gd=absolute(id.root,globalLeaf(key)),sd=id.session?absolute(id.root,sessionLeaf(id.session,key)):gd;
    std::wstring eventLeaf=L"isolation-event-"+nonce,sectionLeaf=L"isolation-section-"+nonce;
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
    line("{\"kind\":\"ready\","+identityFields(id)+",\"key\":"+quote(utf8(key))+",\"globalDirectory\":"+quote(utf8(gd))+",\"sessionDirectory\":"+quote(utf8(sd))+",\"nullDaclChildren\":true,\"ownEvent\":"+status(es)+",\"ownSection\":"+status(ms)+",\"ownSectionReadback\":true,\"pipeExactSynchronousPositive\":"+std::string(pipe.exactSynchronousPositive?"true":"false")+",\"pipeOverlappedFixture\":true,\"pipeName\":"+quote(utf8(pipe.name))+",\"pipeKernelName\":"+quote(utf8(pipe.kernelName))+",\"pipeAvailable\":true,\"pipeDescriptorMatched\":true}");
    bool checked=false;
    for(int count=0;count<3;++count){
      std::string command=readLine();
      if(command=="stop"){pipe.finish();line("{\"kind\":\"closed\",\"checked\":"+std::string(checked?"true":"false")+"}");return 0;}
      require(!checked&&command.starts_with("check "),"command");const size_t delimiter=command.find(' ',6);require(delimiter!=std::string::npos,"peer-pipe-command");std::wstring other(command.begin()+6,command.begin()+delimiter),peerPipe(command.begin()+delimiter+1,command.end());
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
      const auto pipeDenials=pipe.foreign(peerPipe);
      line("{\"kind\":\"denials\","+identityFields(id)+",\"foreignRoot\":"+quote(utf8(other))+fields+",\"pipeForeignWriter\":"+std::to_string(pipeDenials.first)+",\"pipeForeignWriteData\":"+std::to_string(pipeDenials.second)+",\"pipeOwnBefore\":"+std::string(pipe.ownBefore?"true":"false")+",\"pipeOwnMinimalBefore\":"+std::string(pipe.minimalBefore?"true":"false")+",\"pipeOwnAfter\":"+std::string(pipe.ownAfter?"true":"false")+",\"pipeOwnMinimalAfter\":"+std::string(pipe.minimalAfter?"true":"false")+",\"pipeServerAvailableAfter\":true}");
      require(allDenied&&pipeDenials.first==ERROR_ACCESS_DENIED&&pipeDenials.second==ERROR_ACCESS_DENIED,"isolation-denial-failed");checked=true;
    }
    throw std::runtime_error("command-count");
  }catch(const std::exception& error){line("{\"kind\":\"failure\",\"error\":"+quote(error.what())+",\"win32\":"+std::to_string(GetLastError())+"}");return 1;}
}
