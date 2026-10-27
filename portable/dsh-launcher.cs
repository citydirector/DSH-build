// dsh 便携版启动器（C# 5.0，.NET Framework 4.8 的 csc 编译）
// 职责：定位自身目录 → 设 DSH_HOME=程序目录\data（绿色，不写 ~/.dsh）→ 把 node 加进 PATH
//       → XDG_* 指到 data\xdg\（遵循 XDG 的插件如 billion-context 不再写 C 盘用户目录）
//       → 首次以新版本启动时跑一次会话代际迁移（app\migrate-sessions-v4.mjs）
//       → 同样在首次以新版本启动时，把 data\profiles\*\cordis.patch.yml 迁到本版本的口径上
//         （app\migrate-profiles.mjs）→ 运行 node bin.js
// 无参数时默认启动 web 模式，并自动打开浏览器。
// 子命令：--migrate-sessions 只跑会话代际迁移、不启动 dsh（迁移有失败项后的手动重跑入口）。
//       --migrate-profiles 只跑 profile 配置迁移、不启动 dsh（同上，手动重跑入口）。
//       plugin ...：改走 app\dsh-plugin-cli.mjs，把随包 pnpm 交给上游 CLI（否则要求 PATH 上有 pnpm）。

using System;
using System.Collections.Generic;
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
                    // PATH 一族是 system + user 两半：注册表只有 user 那一半，直接赋值会把
                    // system 目录（system32 等）整段丢掉，此后 bash/cmd 一类全解析不到。
                    // 这几项改为只补缺的项，进程已有的一半留在前面。
                    if (IsAdditiveName(name))
                    {
                        string existing = Environment.GetEnvironmentVariable(name);
                        if (!string.IsNullOrEmpty(existing)) val = AppendMissingEntries(existing, val);
                    }
                    Environment.SetEnvironmentVariable(name, val, EnvironmentVariableTarget.Process);
                }
            }
        }

        Environment.SetEnvironmentVariable("DSH_HOME", dataDir);

        // 把 node 加入 PATH，供插件与子进程调用
        string nodeDir = Path.Combine(baseDir, "node");
        Environment.SetEnvironmentVariable("PATH", nodeDir + ";" + Environment.GetEnvironmentVariable("PATH"));

        // 绿色：遵循 XDG 的插件（billion-context 的日志/配置/会话索引/MITM 证书）默认写
        // %USERPROFILE%\.config 等目录；改指到 data\xdg\。用户自己设过的变量不动。
        // 不能放进 DSH_HOME\.env：XDG_ 属 bootstrap-only，在那里写会让 dsh 启动报错。
        RedirectXdg(dataDir);

        // billion-context 的代理要自己起一个 node 进程，默认按 PATH 找 node.exe（可能找到系统里
        // 别的 node，甚至不是 Node 的同名程序，上游 #3383）。钉到随包 node；用户设过就不动。
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("BILLION_CONTEXT_NODE")))
            Environment.SetEnvironmentVariable("BILLION_CONTEXT_NODE", nodeExe);

        // --migrate-sessions：只跑会话代际迁移、不启动 dsh（迁移失败后的手动重跑入口）
        if (HasFlag(args, "--migrate-sessions"))
        {
            Console.WriteLine("仅执行本地会话代际迁移（不启动 dsh）。");
            int migrateCode = RunSessionMigration(baseDir, nodeExe, dataDir, true);
            if (migrateCode == 2) migrateCode = 0;
            PauseBeforeExit();
            return migrateCode;
        }

        // --migrate-profiles：只跑 profile 配置迁移、不启动 dsh（与上面同理的手动重跑入口）
        if (HasFlag(args, "--migrate-profiles"))
        {
            Console.WriteLine("仅执行 profile 配置迁移（不启动 dsh）。");
            int profileCode = RunProfileMigration(baseDir, nodeExe, dataDir, true);
            if (profileCode == 2) profileCode = 0;
            PauseBeforeExit();
            return profileCode;
        }

        // 首次以新版本启动时，一次性把本地 v2/v3 会话补迁移到 v4（失败不阻断启动）
        RunSessionMigration(baseDir, nodeExe, dataDir, false);

        // 同一个位置、同一个口径：把 profile 配置迁到本版本的认识上。
        // 放在会话迁移之后纯粹是历史顺序，两者互不依赖（一个动 sessions，一个动 profiles）。
        // 必须在这里而不是 update.exe 里做：那时新程序还没落地，判据用的不是将要运行的这一份。
        RunProfileMigration(baseDir, nodeExe, dataDir, false);

        bool autoWeb = args.Length == 0;

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = nodeExe;
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        // 无参数自动 web 时传 --no-open：DSH 本体（node）在新版本里也会自动开浏览器，
        // 与启动器的 autoWeb 打开逻辑重复（会开两个窗口）。浏览器只由启动器开一次，
        // 且是在 3080 端口就绪之后。
        // `dsh plugin ...` 需要 pnpm：便携版不在 PATH 上放 pnpm，由插件入口把随包 pnpm 交给上游 CLI。
        string pluginCli = Path.Combine(baseDir, "app", "dsh-plugin-cli.mjs");
        string entry = args.Length > 0 && args[0] == "plugin" && File.Exists(pluginCli) ? pluginCli : binJs;
        psi.Arguments = Quote(entry) + (autoWeb ? " web --no-open" : "");
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

    // ── profile 配置迁移 ─────────────────────────────────────────────────────
    // 上游改一个 config 键名、删一条子路径导出，用户手写的 cordis.patch.yml 就会 import 失败，
    // 预设整组挂不上 → 建不了会话（现象：预设显示加载失败、会话输入不可用、标题退化成 session-xxx）。
    // 迁移器是随包分发的 app\migrate-profiles.mjs，判据全部问本版本自己的运行时（见
    // app\lib\profile-compat.mjs 头注释），所以不需要版本对照表。
    // 返回：0 成功；1 有 profile 迁移失败；2 跳过（无需迁移 / 已跑过 / 被禁用 / 缺迁移器）。
    /// <summary>读出迁移标记里记录的运行时版本；读不到或不认识返回空串。</summary>
    static string ReadMarkerVersion(string marker)
    {
        try
        {
            if (!File.Exists(marker)) return "";
            return File.ReadAllText(marker).Trim();
        }
        catch { return ""; }
    }

    static int RunProfileMigration(string baseDir, string nodeExe, string dataDir, bool force)
    {
        string migrator = Path.Combine(baseDir, "app", "migrate-profiles.mjs");

        if (!force && Environment.GetEnvironmentVariable("DSH_SKIP_PROFILE_MIGRATION") == "1")
            return 2;
        if (!File.Exists(migrator))
        {
            if (force) Console.Error.WriteLine("未找到 profile 迁移器：" + migrator);
            return 2;
        }

        string version = "unknown";
        string versionFile = Path.Combine(baseDir, "VERSION");
        if (File.Exists(versionFile))
        {
            string read = File.ReadAllText(versionFile).Trim();
            if (read.Length > 0) version = read;
        }

        string markerDir = Path.Combine(dataDir, ".migrations");
        // 标记只记「上一次成功迁移时用的是哪个运行时版本」，不按版本各存一个：
        // dev → main → dev 这种来回切里，回到某个版本时若旧标记还在就会被跳过，
        // 而配置此刻已经被上一跳改成了对面的口径。版本没变才跳过。
        string doneMarker = Path.Combine(markerDir, "profile-compat.done");
        if (!force && ReadMarkerVersion(doneMarker) == version)
            return 2;   // 这一版已经处理过：静默跳过

        // 没有 profiles 目录 = 还没建过任何会话，没什么可迁的（也不该为它建目录）。
        string profilesDir = Path.Combine(dataDir, "profiles");
        if (!Directory.Exists(profilesDir))
        {
            if (force) Console.WriteLine("没有 profile 目录（" + profilesDir + "），无需迁移。");
            return 2;
        }

        try { Directory.CreateDirectory(markerDir); } catch { }

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = nodeExe;
        // 运行时就传 app\ 本身：迁移器据此 resolve 随包的 @deepseek-ai/*。
        psi.Arguments = Quote(migrator) + " --home " + Quote(dataDir) + " --runtime " + Quote(Path.Combine(baseDir, "app"));
        psi.WorkingDirectory = Path.Combine(baseDir, "app");
        psi.UseShellExecute = false;
        psi.EnvironmentVariables["DSH_HOME"] = dataDir;
        try
        {
            Process proc = Process.Start(psi);
            if (!proc.WaitForExit(5 * 60 * 1000))
            {
                try { proc.Kill(); } catch { }
                Console.Error.WriteLine("profile 配置迁移超时（5 分钟），已中止；配置保持原样。");
                return 1;
            }
            if (proc.ExitCode == 0)
            {
                // 只写版本号本身，读回来的比较就不会有歧义。
                try { File.WriteAllText(doneMarker, version); } catch { }
                return 0;
            }
            // 失败不写 done 标记：下一个版本、或手动 --migrate-profiles 还能再试一次。
            Console.Error.WriteLine("profile 配置迁移有未完成项（退出码 " + proc.ExitCode + "）。本次继续启动，未迁移的配置保持原样。");
            Console.Error.WriteLine("排除原因后可手动重跑：dsh.exe --migrate-profiles");
            return 1;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("profile 迁移器启动失败：" + ex.Message);
            return 1;
        }
    }

    // ── 系统/用户各占一半的环境变量 ────────────────────────────────────────────
    // 注册表 HKCU\Environment 只存用户那一半；PATH 一族必须与进程已有的（继承自
    // 父进程的 system 半段）合并，不能整段覆盖。比较按项、按大小写不敏感。
    static readonly string[] AdditiveNames = new string[] { "PATH", "PSMODULEPATH", "PATHEXT", "LIB", "INCLUDE" };

    static bool IsAdditiveName(string name)
    {
        foreach (string additive in AdditiveNames)
        {
            if (string.Equals(additive, name, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    static string AppendMissingEntries(string existing, string value)
    {
        HashSet<string> present = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string item in existing.Split(';'))
        {
            string trimmed = item.Trim();
            if (trimmed.Length > 0) present.Add(trimmed);
        }
        List<string> additions = new List<string>();
        foreach (string item in value.Split(';'))
        {
            string trimmed = item.Trim();
            if (trimmed.Length == 0) continue;
            if (present.Add(trimmed)) additions.Add(trimmed);
        }
        if (additions.Count == 0) return existing;
        string separator = existing.TrimEnd().EndsWith(";", StringComparison.Ordinal) || existing.Trim().Length == 0 ? "" : ";";
        return existing + separator + string.Join(";", additions);
    }

    // ── XDG 重定向 ───────────────────────────────────────────────────────────
    // 每个 XDG 变量：未设置时指到 data\xdg\<子目录>。第一次切换时把用户目录里已有的
    // billion-context 文件夹复制（不移动）过来，保住已压缩会话的索引；原件留着，确认无误后可自行删除。
    static readonly string[][] XdgDirs = new string[][]
    {
        new string[] { "XDG_CONFIG_HOME", "config", ".config" },
        new string[] { "XDG_DATA_HOME", "data", ".local\\share" },
        new string[] { "XDG_STATE_HOME", "state", ".local\\state" },
        new string[] { "XDG_CACHE_HOME", "cache", ".cache" },
    };
    static readonly string[] XdgCarryOver = new string[] { "billion-context" };

    static void RedirectXdg(string dataDir)
    {
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        foreach (string[] d in XdgDirs)
        {
            if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable(d[0]))) continue;
            string target = Path.Combine(Path.Combine(dataDir, "xdg"), d[1]);
            try { Directory.CreateDirectory(target); } catch { continue; }
            Environment.SetEnvironmentVariable(d[0], target);
            if (string.IsNullOrEmpty(home)) continue;
            foreach (string name in XdgCarryOver)
            {
                string legacy = Path.Combine(Path.Combine(home, d[2]), name);
                string destination = Path.Combine(target, name);
                if (!Directory.Exists(legacy) || Directory.Exists(destination)) continue;
                try { CopyDirectory(legacy, destination); }
                catch (Exception ex)
                {
                    try { Console.Error.WriteLine("复制 " + legacy + " 失败：" + ex.Message); } catch { }
                }
            }
        }
    }

    static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (string file in Directory.GetFiles(source))
            File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), false);
        foreach (string dir in Directory.GetDirectories(source))
            CopyDirectory(dir, Path.Combine(destination, Path.GetFileName(dir)));
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
