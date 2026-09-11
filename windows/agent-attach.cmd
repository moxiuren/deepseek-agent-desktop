@echo off
if "%~1"=="" (
    echo Usage: agent-attach ^<file_path^> [prompt]
    exit /b 1
)
set "PROMPT=%~2"
if "%PROMPT%"=="" set "PROMPT=相关文件已作为附件挂载，请直接阅读分析。"
echo [[AGENT_ATTACH_FILE:%~f1:%PROMPT%]]
