@echo off
chcp 65001 >nul
echo 测试 POST http://60.12.218.220:5030/receive_data
echo.

REM 使用 curl 测试（如果已安装）
where curl >nul 2>&1
if %errorlevel% equ 0 (
    echo 使用 curl 发送测试请求...
    echo.
    
    curl -X POST http://60.12.218.220:5030/receive_data ^
        -H "Content-Type: application/json" ^
        -d "{\"businessType\":\"DS01\",\"conno\":\"ORD20240101001\",\"customid\":\"C001\",\"memo\":\"测试订单\",\"credate\":\"2024-01-01\",\"entryid\":\"S001\",\"inputmanid\":\"U001\",\"assesscustomid\":\"AC001\",\"detailList\":[{\"conno\":\"ORD20240101001\",\"connodtlid\":\"1\",\"goodsid\":\"G001\",\"goodsqty\":\"10\",\"dtlmemo\":\"测试备注\"}]}"
    
    echo.
    echo 测试完成！
) else (
    echo curl 未安装，请使用以下方式之一：
    echo 1. 安装 curl: https://curl.se/windows/
    echo 2. 使用 PowerShell: powershell -ExecutionPolicy Bypass -File test_api.ps1
    echo 3. 使用 Node.js: node test_api.js
    echo.
    pause
)









