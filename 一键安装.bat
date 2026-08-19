@echo off
chcp 65001 >nul
title QQ群大事监控全家桶 - 一键安装
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0一键安装.ps1"