# 全家桶一键安装脚本
# 1) 若本目录已有安装包则直接运行；否则从 GitHub Release 下载（自动尝试系统代理）
$ErrorActionPreference = "Stop"
$url = "https://github.com/BHX-WL/DeepSeek-Project/releases/latest/download/ImgOCR.Setup.0.2.0.exe"
$out = Join-Path $PSScriptRoot "ImgOCR.Setup.0.2.0.exe"

function Get-Proxy {
  try {
    $p = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
    if ($p.ProxyEnable -eq 1 -and $p.ProxyServer) { return "http://" + $p.ProxyServer }
  } catch {}
  return $null
}

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  QQ 群大事监控全家桶 - 一键安装" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path $out)) {
  Write-Host "[1/2] 下载安装包（约 208MB）..." -ForegroundColor Yellow
  $proxy = Get-Proxy
  try {
    if ($proxy) {
      Write-Host "     使用系统代理: $proxy" -ForegroundColor DarkGray
      Invoke-WebRequest -Uri $url -OutFile $out -Proxy $proxy -UseBasicParsing
    } else {
      Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
    }
  } catch {
    Write-Host "下载失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "请手动下载安装包后放到本目录：" -ForegroundColor Yellow
    Write-Host "  $url" -ForegroundColor White
    Write-Host "下载地址: https://github.com/BHX-WL/DeepSeek-Project/releases"
    Read-Host "按回车退出"
    exit 1
  }
} else {
  Write-Host "[1/2] 已找到安装包" -ForegroundColor Green
}

Write-Host "[2/2] 启动安装程序（请按提示完成安装，阅读并同意免责声明）..." -ForegroundColor Yellow
Start-Process -FilePath $out
Write-Host ""
Write-Host "安装完成后：打开「大事汇总器全家桶」→ 首次启动按引导操作（用小号扫码登录）" -ForegroundColor Green
Read-Host "按回车关闭本窗口"