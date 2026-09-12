; DeepSeek Agent for Windows - Inno Setup script
; Usage: ISCC.exe DeepSeek-Agent.iss   (run from windows\installer\)
; NOTE: run a fresh `dotnet publish ... -o ..\publish` first so ..\publish is current.

#define MyAppName "DeepSeek Agent"
#define MyAppVersion "1.0.4"
#define MyAppPublisher "moxiuren"
#define MyAppExeName "DeepSeek.exe"
#define SrcDir "..\publish"
#define PrereqDir "prereq"

[Setup]
AppId={{8CC5564C-7AD3-4235-807C-02598A637483}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\DeepSeek-Agent
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\..\dist
OutputBaseFilename=DeepSeek-Agent-Setup-1.0.4
SetupIconFile=..\AppIcon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Chinese + English wizard pages
ShowLanguageDialog=no

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
chinesesimplified.LaunchAfterInstall=安装完成后启动 DeepSeek Agent
english.LaunchAfterInstall=Launch DeepSeek Agent after install
chinesesimplified.PrereqDotNet=正在安装 .NET 8 Desktop Runtime（约1分钟）…
english.PrereqDotNet=Installing .NET 8 Desktop Runtime (about 1 minute)...
chinesesimplified.PrereqWebView2=正在安装 WebView2 运行库（需联网下载）…
english.PrereqWebView2=Installing WebView2 Runtime (download required)...
chinesesimplified.DotNetFailed=.NET 8 安装失败（退出码 %1）。可稍后手动安装：https://aka.ms/dotnet/8.0/windowsdesktop-runtime-win-x64.exe
english.DotNetFailed=.NET 8 install failed (exit code %1). Install manually later: https://aka.ms/dotnet/8.0/windowsdesktop-runtime-win-x64.exe
chinesesimplified.WebView2Failed=WebView2 安装失败（退出码 %1）。可稍后手动安装：https://go.microsoft.com/fwlink/p/?LinkId=2124703
english.WebView2Failed=WebView2 install failed (exit code %1). Install manually later: https://go.microsoft.com/fwlink/p/?LinkId=2124703

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; App payload (multi-file publish; single-file is forbidden by PowerShell SDK, see csproj)
Source: "{#SrcDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Bundled offline prereqs (extracted to temp only when needed)
Source: "{#PrereqDir}\windowsdesktop-runtime.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall nocompression
Source: "{#PrereqDir}\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall nocompression

[Icons]
Name: "{autoprograms}\DeepSeek Agent"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\DeepSeek Agent"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchAfterInstall}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Remove our own logs on uninstall; WebView2 profile (%LOCALAPPDATA%\DeepSeek) is left intact
Type: filesandordirs; Name: "{app}\logs"

[Code]
const
  WV2_CLIENT_KEY = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function IsDotNet8DesktopInstalled(): Boolean;
var
  Names: TArrayOfString;
  I: Integer;
begin
  Result := False;
  { 64-bit registry view: 32-bit Setup would otherwise be redirected to WOW6432Node }
  if RegGetSubkeyNames(HKLM64, 'SOFTWARE\dotnet\Setup\InstalledVersions\x64\sharedfx\Microsoft.WindowsDesktop.App', Names) then
  begin
    for I := 0 to GetArrayLength(Names) - 1 do
    begin
      if Copy(Names[I], 1, 2) = '8.' then
      begin
        Result := True;
        Exit;
      end;
    end;
  end;
end;

function IsWebView2Installed(): Boolean;
var
  Ver: String;
begin
  Result := RegQueryStringValue(HKLM64, WV2_CLIENT_KEY, 'pv', Ver) and (Ver <> '');
end;

function InstallPrereq(const Exe, Args, FailMsg: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  { Prereq installers carry their own manifests and elevate themselves via UAC }
  if Exec(ExpandConstant(Exe), Args, '', SW_SHOW, ewWaitUntilTerminated, ResultCode) then
  begin
    if ResultCode <> 0 then
    begin
      MsgBox(FmtMessage(FailMsg, [IntToStr(ResultCode)]), mbInformation, MB_OK);
      Result := False;
    end;
  end
  else
  begin
    MsgBox(FmtMessage(FailMsg, ['-1']), mbInformation, MB_OK);
    Result := False;
  end;
end;

procedure KillRunningApp();
var
  ResultCode: Integer;
begin
  Exec('taskkill.exe', '/F /IM DeepSeek.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  KillRunningApp();
  if not IsDotNet8DesktopInstalled() then
  begin
    WizardForm.StatusLabel.Caption := CustomMessage('PrereqDotNet');
    WizardForm.Repaint;
    InstallPrereq('{tmp}\windowsdesktop-runtime.exe', '/install /quiet /norestart',
      CustomMessage('DotNetFailed'));
    { Continue even on failure: user can install manually; app will show its own error. }
  end;
  if not IsWebView2Installed() then
  begin
    WizardForm.StatusLabel.Caption := CustomMessage('PrereqWebView2');
    WizardForm.Repaint;
    InstallPrereq('{tmp}\MicrosoftEdgeWebView2RuntimeInstallerX64.exe', '/silent /install',
      CustomMessage('WebView2Failed'));
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    KillRunningApp();
end;
