@echo off
set "OUT=%TEMP%\deepseek_screenshot_%RANDOM%.png"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $b = New-Object System.Drawing.Bitmap $s.Width, $s.Height; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($s.Location, [System.Drawing.Point]::Empty, $s.Size); $b.Save('%OUT%', [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose();"
echo [[AGENT_ATTACH_FILE:%OUT%:屏幕截图已捕获，请查看附件图片进行分析与判断。]]
