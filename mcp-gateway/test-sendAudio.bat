@echo off
chcp 65001 >nul
echo ===========================================
echo  TG sendAudio 测试脚本
echo ===========================================
echo.

set TOKEN=8899691503:AAHg7g4uj7Al20WbKA-7s0l01yimrwnX08c
set FILE=D:\kimi\workspace\twig-mnemosyne\mcp-gateway\test-music.mp3

echo 步骤 1: 获取 chat_id
echo 请先在 Telegram 里给 @koraxshuoshuo_bot 发送一条消息（比如 /start 或 "你好"）
echo 发送后按回车继续...
pause >nul

echo.
echo 正在获取 chat_id...
curl -s "https://api.telegram.org/bot%TOKEN%/getUpdates" -o updates.json

for /f "tokens=2 delims=:, " %%a in ('findstr "\"chat\":" updates.json ^| findstr "\"id\"" ^| findstr /r "[0-9][0-9]*"') do (
    set CHAT_ID=%%a
    goto :found
)

echo 未找到 chat_id，请确认已在 Telegram 发送过消息
goto :end

:found
echo 找到 chat_id: %CHAT_ID%
echo.

echo 步骤 2: 发送音频文件
echo 文件: %FILE%
curl -s -X POST "https://api.telegram.org/bot%TOKEN%/sendAudio" ^
    -F "chat_id=%CHAT_ID%" ^
    -F "audio=@%FILE%" ^
    -F "title=BonDance" ^
    -F "performer=Test Artist" ^
    -F "caption=🎵 测试本地文件上传" ^
    -o result.json

echo.
echo 结果:
type result.json | findstr "ok" | findstr /v "book"

for /f "tokens=2 delims=:," %%a in ('findstr "\"ok\":" result.json') do (
    if "%%a"=="true" (
        echo.
        echo ✅ 发送成功！请在 Telegram 查看音乐卡片
    ) else (
        echo.
        echo ❌ 发送失败，详见 result.json
    )
)

:end
echo.
echo ===========================================
echo 测试完成。检查 Telegram 是否收到音乐卡片。
echo 如果没有，请检查 result.json 中的错误信息。
echo.
pause
