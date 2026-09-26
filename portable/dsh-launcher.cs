// dsh 便携版启动器（C# 5.0，.NET Framework 4.8 的 csc 编译）
// 职责：定位自身目录 → 设 DSH_HOME=程序目录\data（绿色，不写 ~/.dsh）→ 把 node 加进 PATH
//       → 首次以新版本启动时跑一次会话代际迁移（app\migrate-sessions-v4.mjs）→ 运行 node bin.js
// 无参数时默认启动 web 模式，并自动打开浏览器。
// 子命令：--migrate-sessions 只跑会话代际迁移、不启动 dsh（迁移有失败项后的手动重跑入口）。

using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

class DshLauncher
{
    static int Main(string[] args)
    {
        // 统一输出 UTF-8：与 node 的 UTF-8 输出、现代终端（chcp 65001）对齐，
        // 避免中文在 GBK 代码页/CI 编译差异下显示乱码。
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }
        try
        {
            return Run(args);
        }
        catch (Exception ex)
        {
            try { Console.Error.WriteLine("dsh 启动失败：" + ex.ToString()); } catch { }
            PauseBeforeExit();
            return 1;
        }
    }

    static int Run(string[] args)
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string nodeExe = Path.Combine(baseDir, "node", "node.exe");
        string binJs = Path.Combine(baseDir, "app", "lib", "bin.js");
        string dataDir = Path.Combine(baseDir, "data");

        if (!File.Exists(nodeExe))
            return Fail("错误：未找到 node 运行时（" + nodeExe + "）。请勿把 dsh.exe 移出程序目录。");
        if (!File.Exists(binJs))
            return Fail("错误：未找到 dsh 入口（" + binJs + "）。程序不完整，请重新下载完整包。");

        // 绿色：数据放程序目录内 data/，绝不写 C 盘用户目录的 ~/.dsh
        Directory.CreateDirectory(dataDir);

        // 刷新 User 环境（读注册表 HKCU\Environment 合并进本进程），避免子进程继承到
        // 过期的启动快照（老终端里新 setx 的变量拿不到）。REG_EXPAND_SZ 先展开 %VAR%。
        // 放在 DSH_HOME/PATH 赋值之前：启动器自身的赋值优先级更高，可覆盖同名键。
        using (RegistryKey envKey = Registry.CurrentUser.OpenSubKey("Environment"))
        {
            if (envKey != null)
            {
                foreach (string name in envKey.GetValueNames())
                {
                    object raw = envKey.GetValue(name);
                    if (raw == null) continue;
                    string val;
                    string[] multi = raw as string[];
                    if (multi != null)
                        val = string.Join(";", multi);   // REG_MULTI_SZ：多行字符串按 ; 连接
                    else if (raw is byte[])
                        continue;                        // REG_BINARY：塞不进环境块，跳过
                    else
                        val = raw.ToString();            // REG_SZ / REG_EXPAND_SZ / REG_DWORD
                    if (envKey.GetValueKind(name) == RegistryValueKind.ExpandString)
                        val = Environment.ExpandEnvironmentVariables(val);
                    if (string.IsNullOrEmpty(val)) continue;
                    Environment.SetEnvironmentVariable(name, val, EnvironmentVariableTarget.Process);
                }
            }
        }

        Environment.SetEnvironmentVariable("DSH_HOME", dataDir);

        // 把 node 加入 PATH，供插件与子进程调用
        string nodeDir = Path.Combine(baseDir, "node");
        Environment.SetEnvironmentVariable("PATH", nodeDir + ";" + Environment.GetEnvironmentVariable("PATH"));

        // --migrate-sessions：只跑会话代际迁移、不启动 dsh（迁移失败后的手动重跑入口）
        if (HasFlag(args, "--migrate-sessions"))
        {
            Console.WriteLine("仅执行本地会话代际迁移（不启动 dsh）。");
            int migrateCode = RunSessionMigration(baseDir, nodeExe, dataDir, true);
            if (migrateCode == 2) migrateCode = 0;
            PauseBeforeExit();
            return migrateCode;
        }

        // 首次以新版本启动时，一次性把本地 v2/v3 会话补迁移到 v4（失败不阻断启动）
        RunSessionMigration(baseDir, nodeExe, dataDir, false);

        bool autoWeb = args.Length == 0;

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = nodeExe;
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        // 无参数自动 web 时传 --no-open：DSH 本体（node）在新版本里也会自动开浏览器，
        // 与启动器的 autoWeb 打开逻辑重复（会开两个窗口）。浏览器只由启动器开一次，
        // 且是在 3080 端口就绪之后。
        psi.Arguments = Quote(binJs) + (autoWeb ? " web --no-open" : "");
        foreach (string a in args)
        {
            psi.Arguments += " " + Quote(a);
        }

        // 累积 stderr 尾部：node 异常退出时落盘，终端乱码/已关闭也能追溯崩溃原因
        StringBuilder errTail = new StringBuilder();
        const int ERR_TAIL_MAX = 65536;

        Process p = new Process();
        p.StartInfo = psi;
        p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) Console.Out.WriteLine(e.Data); };
        p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            Console.Error.WriteLine(e.Data);
            lock (errTail)
            {
                if (errTail.Length > ERR_TAIL_MAX) errTail.Remove(0, errTail.Length - ERR_TAIL_MAX);
                errTail.AppendLine(e.Data);
            }
        };
        p.Start();
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();

        if (autoWeb)
        {
            string url = "http://127.0.0.1:3080";
            bool opened = false;
            for (int i = 0; i < 60 && !p.HasExited; i++)
            {
                if (PortOpen("127.0.0.1", 3080))
                {
                    try { Process.Start(url); opened = true; } catch { }
                    break;
                }
                Thread.Sleep(500);
            }
            if (!opened)
            {
                Console.WriteLine("Web UI 启动中或失败，手动访问 " + url);
            }
        }

        p.WaitForExit();
        if (p.ExitCode != 0)
        {
            try
            {
                // 把 stderr 尾部写入 data/launcher-crash.log，方便诊断（如睡眠唤醒后 node 静默退出）
                string tail;
                lock (errTail) { tail = errTail.ToString(); }
                string crashLog = Path.Combine(dataDir, "launcher-crash.log");
                File.AppendAllText(crashLog,
                    "\n===== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " dsh exit code " + p.ExitCode + " =====\n"
                    + tail
                    + "===== end =====\n");
            }
            catch { }
            try { Console.Error.WriteLine("dsh 已退出，退出码 " + p.ExitCode); } catch { }
            PauseBeforeExit();
        }
        return p.ExitCode;
    }

    // ── 会话代际迁移（本地 v2/v3 会话 → v4）─────────────────────────────────
    // 上游只在「写打开」（resume）时才把旧代际会话升级到当前代际，读取是只读的；所以从
    // v3 构建升到 v4 构建后，得有人把本机全部会话补迁移一遍 —— 这里做，用户不必逐条 resume。
    //
    // 迁移器是随包分发的 app\migrate-sessions-v4.mjs（构建期由 portable/build-migrator.mjs
    // 从上游 scripts/migrate-sessions-to-v4.ts 打包而来，用的是上游自己的迁移机器）。
    // 迁移只「新增一份当前代际的 generation 文件」，历史 generation 原样保留 → 可回滚
    // （删掉新写的 session.v4.jsonl.zstd 即可）。天然幂等：已是 v4 的会话只读打开。
    //
    // 幂等与静默：每个 VERSION 只跑一次。成功写 .done、失败写 .failed，两者都让后续启动
    // 静默跳过 —— 否则一个坏会话会让每次启动都刷一遍同样的报错。失败不阻断启动（新版本
    // 仍能按旧代际读取未升级的会话）；要重跑：dsh.exe --migrate-sessions。
    // 紧急跳过：设 DSH_SKIP_SESSION_MIGRATION=1。
    //
    // 目标代际：从随包的 @deepseek-ai/dsh-session 里解析 SESSION_FORMAT_VERSION（与迁移器同一
    // 事实来源，上游改版本号这里自动跟上）。读不到就返回 -1 → 调用方照常交给迁移器（失败安全）。
    static int ReadTargetGeneration(string baseDir)
    {
        try
        {
            string file = Path.Combine(baseDir, "app", "node_modules", "@deepseek-ai", "dsh-session", "lib", "index.js");
            if (!File.Exists(file)) return -1;
            Match m = Regex.Match(File.ReadAllText(file), @"SESSION_FORMAT_VERSION\s*=\s*(\d+)");
            if (!m.Success) return -1;
            int v;
            return int.TryParse(m.Groups[1].Value, out v) ? v : -1;
        }
        catch { return -1; }
    }

    // 数一遍：sessions\<项目>\<会话>\ 下有多少个会话目录，其中多少个还没有"目标代际或更新"的
    // generation 文件。只看文件名里的代际号（与迁移器判断"已是什么代际"的口径一致），不读内容 ——
    // 几百次目录枚举，毫秒级。没有任何 generation 文件的目录也算"缺"，交给迁移器去报布局异常。
    static int CountSessionDirs(string sessionsDir, int target, out int missing)
    {
        missing = 0;
        int total = 0;
        Regex generation = new Regex(@"^session(\.[0-9]+)?(\.v([0-9]+))?\.jsonl\.zstd$", RegexOptions.IgnoreCase);
        foreach (string project in Directory.GetDirectories(sessionsDir))
        {
            foreach (string dir in Directory.GetDirectories(project))
            {
                total++;
                bool hasTarget = false;
                foreach (string file in Directory.GetFiles(dir))
                {
                    Match m = generation.Match(Path.GetFileName(file));
                    if (!m.Success) continue;
                    int version = m.Groups[3].Success ? int.Parse(m.Groups[3].Value) : 0;
                    if (version >= target) { hasTarget = true; break; }
                }
                if (!hasTarget) missing++;
            }
        }
        return total;
    }

    // 返回：0 成功；1 失败；2 跳过（无需迁移 / 已跑过 / 被禁用 / 缺迁移器）。
    static int RunSessionMigration(string baseDir, string nodeExe, string dataDir, bool force)
    {
        string sessionsDir = Path.Combine(dataDir, "sessions");
        string migrator = Path.Combine(baseDir, "app", "migrate-sessions-v4.mjs");

        if (!force && Environment.GetEnvironmentVariable("DSH_SKIP_SESSION_MIGRATION") == "1")
            return 2;
        if (!Directory.Exists(sessionsDir))
        {
            if (force) Console.WriteLine("没有本地会话目录（" + sessionsDir + "），无需迁移。");
            return 2;
        }
        if (!File.Exists(migrator))
        {
            if (force) Console.Error.WriteLine("未找到会话迁移器：" + migrator);
            return 2;
        }

        string version = "";
        string versionFile = Path.Combine(baseDir, "VERSION");
        if (File.Exists(versionFile)) version = File.ReadAllText(versionFile).Trim();
        if (version.Length == 0) version = "unknown";

        string markerDir = Path.Combine(dataDir, ".migrations");
        string doneMarker = Path.Combine(markerDir, "session-v4-" + version + ".done");
        string failedMarker = Path.Combine(markerDir, "session-v4-" + version + ".failed");
        if (!force && (File.Exists(doneMarker) || File.Exists(failedMarker)))
            return 2;   // 本版本已处理过：静默跳过
        try { Directory.CreateDirectory(markerDir); } catch { }

        // 但标记文件本身不可靠（实测被清掉过一次，于是每次启动都白跑一遍迁移检查、还刷 87 行日志），
        // 所以先自己看一眼会话目录：每个会话目录里都已经有目标代际的文件 = 没有任何可迁的 → 毫秒级跳过。
        // 目标代际从随包的 @deepseek-ai/dsh-session 里解析（不写死）；解析不出来就照常交给迁移器（失败安全）。
        int targetVersion = ReadTargetGeneration(baseDir);
        if (!force && targetVersion > 0)
        {
            int missing;
            int total = CountSessionDirs(sessionsDir, targetVersion, out missing);
            if (total > 0 && missing == 0)
            {
                Console.WriteLine("本地会话已是 v" + targetVersion + "（" + total + " 个），跳过迁移检查。");
                try { File.WriteAllText(doneMarker, DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss") + " " + version + " precheck"); } catch { }
                return 2;
            }
        }

        // 迁移器的文字日志与 JSON 摘要默认写系统临时目录；改成程序目录内，保持绿色。
        // 只改子进程环境（不改本进程），免得 dsh 本体也把临时文件写进来。
        string tmpDir = Path.Combine(markerDir, "tmp");
        try { Directory.CreateDirectory(tmpDir); } catch { }

        string targetLabel = targetVersion > 0 ? targetVersion.ToString() : "4";
        if (!force)
        {
            // 强制重跑（--migrate-sessions）时上面已经印过一行了，这里不再误导成"首次以本版本启动"
            Console.WriteLine("首次以本版本启动：正在把本地会话格式升级到 v" + targetLabel + "（一次性，可回滚）...");
            Console.WriteLine();
        }

        // 最多两轮：首轮并发迁移父子会话时可能有个别会话失败（父会话的 generation 在子会话
        // 准备期间被改写），重跑时父会话已是 v4、不会再有变化，串行补齐通常一次就干净。
        int exit = 1;
        for (int attempt = 1; attempt <= 2; attempt++)
        {
            if (attempt == 2)
            {
                Console.WriteLine();
                Console.WriteLine("仍有会话未升级，自动重试一次...");
            }
            exit = RunMigratorOnce(nodeExe, migrator, sessionsDir, baseDir, version, tmpDir);
            if (exit == 0) break;
        }

        Console.WriteLine();
        if (exit == 0)
        {
            try { File.WriteAllText(doneMarker, DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss") + " " + version); } catch { }
            Console.WriteLine("本地会话已全部升级到 v4。历史代际文件仍保留，回滚只需删除 session.v4.jsonl.zstd。");
            return 0;
        }
        try { File.WriteAllText(failedMarker, DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss") + " " + version + " exit=" + exit); } catch { }
        Console.Error.WriteLine("部分会话未能升级（迁移器退出码 " + exit + "）。本次继续启动；未升级的会话仍按旧代际可读。");
        Console.Error.WriteLine("详情：" + tmpDir + " 下的 migration.log / summary.json");
        Console.Error.WriteLine("排除原因后可手动重跑：dsh.exe --migrate-sessions");
        return 1;
    }

    // 跑一轮迁移器；返回它的退出码（0 = 全部成功）。
    // 兜底超时：迁移器卡死时不能把启动器一起拖住（会话多也就几十秒到几分钟）。
    static int RunMigratorOnce(string nodeExe, string migrator, string sessionsDir, string baseDir, string version, string tmpDir)
    {
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = nodeExe;
        psi.Arguments = Quote(migrator) + " --sessions-dir " + Quote(sessionsDir);
        psi.WorkingDirectory = Path.Combine(baseDir, "app");   // 让 @deepseek-ai/* 从 app\node_modules 解析
        psi.UseShellExecute = false;
        psi.EnvironmentVariables["DSH_BUILD_COMMIT"] = version;   // 代上游脚本里的 `git rev-parse HEAD`
        psi.EnvironmentVariables["TEMP"] = tmpDir;                // 迁移报告留在程序目录内（绿色）
        psi.EnvironmentVariables["TMP"] = tmpDir;
        try
        {
            Process proc = Process.Start(psi);
            if (!proc.WaitForExit(15 * 60 * 1000))
            {
                try { proc.Kill(); } catch { }
                Console.Error.WriteLine("会话迁移超时（15 分钟），已中止。");
                return 1;
            }
            return proc.ExitCode;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("会话迁移器启动失败：" + ex.Message);
            return 1;
        }
    }

    static bool HasFlag(string[] args, string flag)
    {
        foreach (string a in args)
        {
            if (a == flag) return true;
        }
        return false;
    }

    static int Fail(string msg)
    {
        try { Console.Error.WriteLine(msg); } catch { }
        PauseBeforeExit();
        return 1;
    }

    static void PauseBeforeExit()
    {
        try
        {
            Console.WriteLine();
            Console.WriteLine("按任意键退出...");
            Console.ReadKey(true);
        }
        catch { }
    }

    static bool PortOpen(string host, int port)
    {
        try
        {
            using (TcpClient c = new TcpClient())
            {
                c.Connect(host, port);
                return true;
            }
        }
        catch
        {
            return false;
        }
    }

    static string Quote(string s)
    {
        return "\"" + s.Replace("\"", "\\\"") + "\"";
    }
}
