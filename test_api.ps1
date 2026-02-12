# PowerShell 测试脚本
# 测试 POST http://60.12.218.220:5030/receive_data

$testData = @{
    businessType = "DS01"
    conno = "ORD$(Get-Date -Format 'yyyyMMddHHmmss')"
    customid = "C001"
    memo = "测试订单备注信息"
    credate = Get-Date -Format "yyyy-MM-dd"
    entryid = "S001"
    inputmanid = "U001"
    assesscustomid = "AC001"
    detailList = @(
        @{
            conno = "ORD$(Get-Date -Format 'yyyyMMddHHmmss')"
            connodtlid = "1"
            goodsid = "G001"
            goodsqty = "10"
            dtlmemo = "测试备注：批号要求20240101"
        },
        @{
            conno = "ORD$(Get-Date -Format 'yyyyMMddHHmmss')"
            connodtlid = "2"
            goodsid = "G002"
            goodsqty = "5"
            dtlmemo = "测试备注：批号要求20240102"
        }
    )
} | ConvertTo-Json -Depth 10

# 确保 detailList 中的 conno 与主单一致
$jsonObj = $testData | ConvertFrom-Json
$mainConno = $jsonObj.conno
foreach ($item in $jsonObj.detailList) {
    $item.conno = $mainConno
}
$testData = $jsonObj | ConvertTo-Json -Depth 10

Write-Host "准备发送测试数据:" -ForegroundColor Cyan
Write-Host $testData
Write-Host "`n正在发送请求...`n" -ForegroundColor Yellow

try {
    $response = Invoke-RestMethod -Uri "http://60.12.218.220:5030/receive_data" `
        -Method Post `
        -ContentType "application/json" `
        -Body $testData `
        -TimeoutSec 30

    Write-Host "请求成功!" -ForegroundColor Green
    Write-Host "响应内容:" -ForegroundColor Cyan
    $response | ConvertTo-Json -Depth 10
} catch {
    Write-Host "请求失败!" -ForegroundColor Red
    Write-Host "错误信息: $($_.Exception.Message)" -ForegroundColor Red
    
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $responseBody = $reader.ReadToEnd()
        Write-Host "响应内容: $responseBody" -ForegroundColor Yellow
    }
}









