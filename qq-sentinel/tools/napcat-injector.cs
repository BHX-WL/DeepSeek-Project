using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// napcat-injector.cs — 魔改启动器：挂起启动 QQ（带 --user-data-dir 独立数据目录）+ 注入 NapCatWinBootHook.dll
// 用法: napcat-injector.exe <dataDir> [qqPath] [pidFile]
//   参数1 dataDir : 小号独立数据目录（默认 D:\QQNT-MULTI-DATA）
//   参数2 qqPath  : QQ.exe 路径（默认 D:\QQNT\QQ.exe）
//   参数3 pidFile : 输出 QQ 主进程 PID 的文件（可选）
// 说明: 替代 NapCatWinBootMain.exe（它不透传 --user-data-dir，导致与大号共用默认目录冲突）
public static class NapCatInjectorExe
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ResumeThread(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetModuleHandle(string m);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
    public static extern IntPtr GetProcAddress(IntPtr m, string p);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr VirtualAllocEx(IntPtr p, IntPtr a, uint s, uint t, uint f);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteProcessMemory(IntPtr p, IntPtr a, byte[] b, uint n, out UIntPtr w);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateRemoteThread(IntPtr p, IntPtr a, uint s, IntPtr start, IntPtr arg, uint f, IntPtr id);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr h, uint ms);

    public const uint CREATE_SUSPENDED = 0x4;
    public const uint MEM_COMMIT = 0x1000;
    public const uint PAGE_READWRITE = 0x04;

    public static int Main(string[] args)
    {
        // 防御性：日志目录不存在时静默（不抛异常）
        string logDir = Environment.GetEnvironmentVariable("TEMP") ?? @"C:\Windows\Temp";
        string log = Path.Combine(logDir, "napcat-injector.log");
        Action<string> logLine = (s) => { try { File.AppendAllText(log, "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + s + "\r\n", new UTF8Encoding(false)); } catch { } };
        Action<string> writePid = (s) => { try { File.WriteAllText(s, "0", new UTF8Encoding(false)); } catch { } };

        logLine("=== injector start ===");
        string selfDir = AppDomain.CurrentDomain.BaseDirectory;

        // 参数解析（全部可默认/可选，防御性）
        string dataDir = args.Length > 0 && !string.IsNullOrWhiteSpace(args[0]) ? args[0].Trim().Trim('"') : @"D:\QQNT-MULTI-DATA";
        string qqPath  = args.Length > 1 && !string.IsNullOrWhiteSpace(args[1]) ? args[1].Trim().Trim('"') : @"D:\QQNT\QQ.exe";
        string pidFile = args.Length > 2 && !string.IsNullOrWhiteSpace(args[2]) ? args[2].Trim().Trim('"') : null;

        // 路径防御：dataDir 规范化（去除尾部反斜杠，保证是绝对路径）
        try { dataDir = Path.GetFullPath(dataDir); } catch { }
        if (!Path.IsPathRooted(dataDir)) { logLine("dataDir 非绝对路径: " + dataDir); return 2; }
        if (!File.Exists(qqPath)) { logLine("QQ 不存在: " + qqPath); return 3; }

        string napcatDir = selfDir; // 注入器与 NapCat 同目录
        string hookDll = Path.Combine(napcatDir, "NapCatWinBootHook.dll");
        string qqntJson = Path.Combine(napcatDir, "qqnt.json");
        string loadJs = Path.Combine(napcatDir, "loadNapCat.js");
        string napcatMjs = Path.Combine(napcatDir, "napcat.mjs");
        if (!File.Exists(hookDll)) { logLine("hook DLL 不存在: " + hookDll); return 4; }
        if (!File.Exists(napcatMjs)) { logLine("napcat.mjs 不存在: " + napcatMjs); return 5; }

        // 设置 NapCat 环境变量（同官方 launcher.bat）
        Environment.SetEnvironmentVariable("NAPCAT_PATCH_PACKAGE", qqntJson);
        Environment.SetEnvironmentVariable("NAPCAT_LOAD_PATH", loadJs);
        Environment.SetEnvironmentVariable("NAPCAT_INJECT_PATH", hookDll);
        Environment.SetEnvironmentVariable("NAPCAT_LAUNCHER_PATH", Path.Combine(napcatDir, "NapCatWinBootMain.exe"));
        Environment.SetEnvironmentVariable("NAPCAT_MAIN_PATH", napcatMjs);

        // 生成 loadNapCat.js（内容：import napcat.mjs）
        try
        {
            string mainJs = napcatMjs.Replace("\\", "/");
            File.WriteAllText(loadJs, "(async () => {await import(\"file:///" + mainJs + "\")})() ", new UTF8Encoding(false));
        }
        catch (Exception ex) { logLine("loadNapCat.js 写入失败: " + ex.Message); return 6; }
        logLine("env + loadNapCat.js ok");

        // 挂起启动 QQ（关键：带 --user-data-dir）
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION pi;
        string cmdLine = "\"" + qqPath + "\" --enable-logging --multiple --user-data-dir=" + dataDir;
        logLine("CreateProcess: " + cmdLine);
        bool ok = CreateProcess(null, cmdLine, IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED, IntPtr.Zero, Path.GetDirectoryName(qqPath), ref si, out pi);
        if (!ok)
        {
            int err = Marshal.GetLastWin32Error();
            logLine("CreateProcess FAIL err=" + err);
            return 7;
        }
        logLine("Created PID=" + pi.dwProcessId + " suspended");
        writePidFile(pidFile, pi.dwProcessId, dataDir, writePid, logLine);

        // 注入 hook DLL
        try
        {
            IntPtr hKernel32 = GetModuleHandle("kernel32.dll");
            IntPtr loadLibAddr = GetProcAddress(hKernel32, "LoadLibraryW");
            byte[] dllPathBytes = Encoding.Unicode.GetBytes(hookDll + "\0");
            IntPtr remoteBuf = VirtualAllocEx(pi.hProcess, IntPtr.Zero, (uint)dllPathBytes.Length, MEM_COMMIT, PAGE_READWRITE);
            if (remoteBuf == IntPtr.Zero) { logLine("VirtualAllocEx FAIL err=" + Marshal.GetLastWin32Error()); return 8; }
            UIntPtr written;
            WriteProcessMemory(pi.hProcess, remoteBuf, dllPathBytes, (uint)dllPathBytes.Length, out written);
            IntPtr thread = CreateRemoteThread(pi.hProcess, IntPtr.Zero, 0, loadLibAddr, remoteBuf, 0, IntPtr.Zero);
            if (thread == IntPtr.Zero) { logLine("CreateRemoteThread FAIL err=" + Marshal.GetLastWin32Error()); return 9; }
            logLine("DLL injected, resuming");
            ResumeThread(pi.hThread);
            logLine("Resumed. QQ loading NapCat with --user-data-dir=" + dataDir);
            WaitForSingleObject(thread, 20000);
            CloseHandle(thread);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
        }
        catch (Exception ex) { logLine("注入异常: " + ex.Message); return 10; }
        logLine("=== injector done pid=" + pi.dwProcessId + " ===");
        Console.WriteLine("DONE PID=" + pi.dwProcessId + " dataDir=" + dataDir);
        return 0;
    }

    static void writePidFile(string pidFile, int pid, string dataDir, Action<string> writePid, Action<string> logLine)
    {
        if (string.IsNullOrEmpty(pidFile)) return;
        try { File.WriteAllText(pidFile, pid.ToString(), new UTF8Encoding(false)); logLine("pid file written: " + pidFile + " -> " + pid); }
        catch (Exception ex) { logLine("pid 文件写入失败: " + ex.Message); }
    }
}