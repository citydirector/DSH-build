// dsh 便携版更新器（C# 5.0，.NET Framework 4.8 的 csc 编译）
// 职责：读 VERSION → 查 GitHub 最新 Release → 有更新则下载 zip → robocopy 原地覆盖（保留 data/）
// 绿色：不写注册表、不写 C 盘用户目录；一切在程序目录内完成。

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

class DshUpdater
{
    const string Repo = "citydirector/DSH-build";

    static int Main()
    {
        // 统一输出 UTF-8（与 launcher 一致，避免 CI 编译/终端代码页差异导致中文乱码）
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }
        int code = Run();
        // 停留窗口：update 双击运行时一闪而过，用户看不到信息。统一在退出前暂停。
        // 例外：code==42 表示已启动后台 apply（robocopy + 自替换 update.exe），
        // 此时要立即退出让出 update.exe 文件锁，否则 apply 覆盖自身会失败。
        if (code != 42)
        {
            Console.WriteLine();
            Console.WriteLine("按任意键退出...");
            try { Console.ReadKey(); } catch { }
        }
        return code;
    }

    static int Run()
    {
        // GitHub 要求 TLS 1.2
        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // Tls12

        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string versionFile = Path.Combine(baseDir, "VERSION");
        string current = File.Exists(versionFile) ? File.ReadAllText(versionFile).Trim() : "";

        Console.WriteLine("检查更新中... 当前版本: " + (current.Length >= 7 ? current.Substring(0, 7) : (current == "" ? "未知" : current)));

        string channel = ChooseChannel();
        string releaseUrl = channel == "dev"
            ? "https://api.github.com/repos/" + Repo + "/releases/tags/dsh-dev-latest"
            : "https://api.github.com/repos/" + Repo + "/releases/latest";
        string json = HttpGet(releaseUrl);
        if (json == null)
        {
            Console.Error.WriteLine("无法连接 GitHub，检查更新失败（需要网络）。");
            return 1;
        }

        string tag = JsonValue(json, "tag_name");
        string latestSha = ExtractSha(json);

        bool upToDate = latestSha != "" && latestSha == current;
        if (upToDate)
        {
            bool force = HasForceArg() || AskForceUpdate(tag);
            if (!force)
            {
                Console.WriteLine("已是最新版本（" + tag + "）。");
                return 0;
            }
        }

        string assetUrl = FindPortableAsset(json);
        if (assetUrl == null)
        {
            Console.Error.WriteLine("最新 Release 中未找到便携版 zip。");
            return 1;
        }

        string newShort = latestSha.Length >= 7 ? latestSha.Substring(0, 7) : tag;
        Console.WriteLine("发现新版本 " + newShort + "（" + tag + "），正在下载...");

        string updateDir = Path.Combine(baseDir, "data", ".update");
        Directory.CreateDirectory(updateDir);
        string zipPath = Path.Combine(updateDir, "dsh-portable.zip");
        string newDir = Path.Combine(updateDir, "new");

        if (!Download(assetUrl, zipPath))
        {
            Console.Error.WriteLine("下载失败。");
            return 1;
        }

        if (Directory.Exists(newDir)) Directory.Delete(newDir, true);
        if (!ExtractZip(zipPath, newDir))
        {
            return 1;
        }

        if (IsDshRunning(baseDir))
        {
            Console.Error.WriteLine("检测到 dsh 正在运行，请先关闭 dsh 再执行更新。");
            return 1;
        }

        // 更新前备份旧版本（app/node/启动器/版本/更新器），出问题可回滚
        BackupOld(baseDir);

        // 生成延迟覆盖脚本，规避覆盖正在运行的 update.exe 自身的锁
        string applyCmd = Path.Combine(updateDir, "apply-update.cmd");
        StringBuilder sb = new StringBuilder();
        sb.AppendLine("@echo off");
        sb.AppendLine("timeout /t 1 /nobreak >nul");
        // 只镜像 app/node 两个子目录 + 复制几个顶层文件；不用整目录 /MIR，
        // 避免删掉根目录里用户自己放的文件（如 update.exe 的备份）。
        sb.AppendLine("robocopy \"" + newDir + "\\app\" \"" + baseDir.TrimEnd('\\') + "\\app\" /MIR /NFL /NDL /NJH /NJS");
        sb.AppendLine("if errorlevel 8 exit /b 1");
        sb.AppendLine("robocopy \"" + newDir + "\\node\" \"" + baseDir.TrimEnd('\\') + "\\node\" /MIR /NFL /NDL /NJH /NJS");
        sb.AppendLine("if errorlevel 8 exit /b 1");
        sb.AppendLine("timeout /t 2 /nobreak >nul");
        // 自替换 update.exe：此时旧进程已退出(返回42)，应可覆盖。
        sb.AppendLine("copy /y \"" + newDir + "\\update.exe\" \"" + baseDir.TrimEnd('\\') + "\\update.exe\"");
        sb.AppendLine("copy /y \"" + newDir + "\\dsh.exe\" \"" + baseDir.TrimEnd('\\') + "\\dsh.exe\"");
        sb.AppendLine("copy /y \"" + newDir + "\\VERSION\" \"" + baseDir.TrimEnd('\\') + "\\VERSION\"");
        sb.AppendLine("exit /b 0");
        File.WriteAllText(applyCmd, sb.ToString());

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = "cmd.exe";
        psi.Arguments = "/c \"\"" + applyCmd + "\"\"";
        psi.UseShellExecute = true;
        Process.Start(psi);

        Console.WriteLine("更新已开始，后台正在应用，本窗口即将关闭。");
        return 42;
    }

    // 选择更新通道：3 秒倒计时默认 main；按 2 选 dev，其余/超时选 main。
    // 现网 update.exe 只走 master（releases/latest）；dev 为预发布需按 tags 拉取。
    static string ChooseChannel()
    {
        try
        {
            Console.WriteLine();
            Console.WriteLine("选择更新通道（默认 main，3 秒后自动选 main）：");
            Console.WriteLine("  [1] main（正式）   [2] dev（预发布）");
            int deadline = 3;
            Console.Write("等待选择... 3 秒后自动 main");
            DateTime start = DateTime.UtcNow;
            int last = 4;
            while ((DateTime.UtcNow - start).TotalSeconds < deadline)
            {
                if (Console.KeyAvailable)
                {
                    ConsoleKeyInfo k = Console.ReadKey(true);
                    if (k.KeyChar == '2')
                    {
                        Console.WriteLine();
                        Console.WriteLine("已选择 dev（预发布）");
                        return "dev";
                    }
                    Console.WriteLine();
                    Console.WriteLine("已选择 main（正式）");
                    return "main";
                }
                int left = deadline - (int)(DateTime.UtcNow - start).TotalSeconds;
                if (left != last)
                {
                    last = left;
                    Console.Write("\r等待选择... " + left + " 秒后自动 main  ");
                }
                Thread.Sleep(100);
            }
            Console.WriteLine();
            Console.WriteLine("超时，默认 main（正式）");
            return "main";
        }
        catch
        {
            return "main";
        }
    }
        // 是否以命令行参数强制更新（--force / -force / -f），用于脚本/非交互场景。
    static bool HasForceArg()
    {
        try
        {
            foreach (string a in Environment.GetCommandLineArgs())
            {
                if (a == "--force" || a == "-force" || a == "-f") return true;
            }
        }
        catch { }
        return false;
    }

    // 已是最新版本时的强制更新提示：按 F 强制重新下载并覆盖，其它键/超时退出。
    static bool AskForceUpdate(string tag)
    {
        try
        {
            Console.WriteLine();
            Console.WriteLine("已是最新版本（" + tag + "）。");
            Console.WriteLine("按 F 强制重新下载并覆盖更新；其它键或超时则退出。");
            Console.Write("等待选择... 3 秒后退出");
            DateTime start = DateTime.UtcNow;
            int deadline = 3;
            int last = 4;
            while ((DateTime.UtcNow - start).TotalSeconds < deadline)
            {
                if (Console.KeyAvailable)
                {
                    ConsoleKeyInfo k = Console.ReadKey(true);
                    if (k.KeyChar == 'F' || k.KeyChar == 'f')
                    {
                        Console.WriteLine();
                        Console.WriteLine("已选择：强制更新。");
                        return true;
                    }
                    Console.WriteLine();
                    Console.WriteLine("已选择：退出。");
                    return false;
                }
                int left = deadline - (int)(DateTime.UtcNow - start).TotalSeconds;
                if (left != last)
                {
                    last = left;
                    Console.Write("\r等待选择... " + left + " 秒后退出  ");
                }
                Thread.Sleep(100);
            }
            Console.WriteLine();
            Console.WriteLine("超时，退出。");
            return false;
        }
        catch
        {
            return false;
        }
    }
        // 解压 zip 并实时显示进度。ZipFile.ExtractToDirectory 对大 zip 长时间静默，
    // 用户会误以为卡死；这里逐条解压并刷新计数（每 400ms 一次）。带路径穿越防护。
    static bool ExtractZip(string zipPath, string outDir)
    {
        try
        {
            string fullOut = Path.GetFullPath(outDir);
            Directory.CreateDirectory(fullOut);
            DateTime last = DateTime.UtcNow;
            long done = 0;
            long total = 0;
            using (ZipArchive zip = ZipFile.OpenRead(zipPath))
            {
                total = zip.Entries.Count;
                Console.Write("正在解压...");
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    bool isDir = entry.FullName.EndsWith("/");
                    string entryName = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                    string dest = Path.GetFullPath(Path.Combine(fullOut, entryName));
                    if (!dest.StartsWith(fullOut, StringComparison.OrdinalIgnoreCase)) continue;
                    if (isDir) { Directory.CreateDirectory(dest); continue; }
                    string dir = Path.GetDirectoryName(dest);
                    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                    using (Stream es = entry.Open())
                    using (Stream ds = File.Create(dest))
                    {
                        es.CopyTo(ds);
                    }
                    done++;
                    if ((DateTime.UtcNow - last).TotalMilliseconds > 400)
                    {
                        last = DateTime.UtcNow;
                        Console.Write("\r正在解压... {0}/{1} 个文件  ", done, total);
                    }
                }
            }
            Console.Write("\r" + new string(' ', 50) + "\r");
            Console.WriteLine("解压完成（共 {0} 个条目）", total);
            return true;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("解压失败：" + ex.Message);
            return false;
        }
    }
        static string HttpGet(string url)
    {
        try
        {
            using (WebClient wc = new WebClient())
            {
                wc.Headers.Add("User-Agent", "dsh-portable-updater");
                return wc.DownloadString(url);
            }
        }
        catch
        {
            return null;
        }
    }

    static bool Download(string url, string path)
    {
        try
        {
            using (WebClient wc = new WebClient())
            {
                wc.Headers.Add("User-Agent", "dsh-portable-updater");
                using (AutoResetEvent done = new AutoResetEvent(false))
                {
                    Exception error = null;
                    int lastPct = -1;
                    wc.DownloadProgressChanged += delegate(object s, DownloadProgressChangedEventArgs e)
                    {
                        int pct = e.ProgressPercentage;
                        if (pct != lastPct)
                        {
                            lastPct = pct;
                            double got = e.BytesReceived / 1048576.0;
                            double total = e.TotalBytesToReceive / 1048576.0;
                            Console.Write("\r下载中... {0}%（{1:0.0} / {2:0.0} MB）  ", pct, got, total);
                        }
                    };
                    wc.DownloadFileCompleted += delegate(object s, AsyncCompletedEventArgs e)
                    {
                        error = e.Error;
                        done.Set();
                    };
                    wc.DownloadFileAsync(new Uri(url), path);
                    done.WaitOne();
                    Console.WriteLine();
                    if (error != null) { Console.Error.WriteLine(error.Message); return false; }
                }
            }
            return true;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return false;
        }
    }

    // 更新前把旧版本关键内容打成 zip（app/node/dsh.exe/VERSION/update.exe），便于回滚。
    // node 零散文件很多，deflate 压缩的 CPU 开销是主要耗时；备份只求能回滚、不求体积，
    // 所以用 NoCompression 纯拷贝，并实时显示文件数进度（每 1% 刷新一次行内提示）。
    static void BackupOld(string baseDir)
    {
        try
        {
            List<string[]> files = new List<string[]>();
            CollectFiles(files, Path.Combine(baseDir, "app"), "app");
            CollectFiles(files, Path.Combine(baseDir, "node"), "node");
            AddOne(files, Path.Combine(baseDir, "dsh.exe"), "dsh.exe");
            AddOne(files, Path.Combine(baseDir, "VERSION"), "VERSION");
            AddOne(files, Path.Combine(baseDir, "update.exe"), "update.exe");
            if (files.Count == 0)
            {
                Console.WriteLine("没有可备份的文件，跳过备份。");
                return;
            }
            string backupDir = Path.Combine(baseDir, "data", "backups");
            Directory.CreateDirectory(backupDir);
            string zipPath = Path.Combine(backupDir, "dsh-backup-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".zip");
            Console.WriteLine("正在备份 " + files.Count + " 个文件...");
            using (ZipArchive zip = ZipFile.Open(zipPath, ZipArchiveMode.Create))
            {
                int done = 0;
                int lastPct = -1;
                foreach (string[] item in files)
                {
                    using (Stream src = File.OpenRead(item[0]))
                    using (Stream dst = zip.CreateEntry(item[1], CompressionLevel.NoCompression).Open())
                    {
                        src.CopyTo(dst);
                    }
                    done++;
                    int pct = (int)((long)done * 100 / files.Count);
                    if (pct != lastPct)
                    {
                        lastPct = pct;
                        Console.Write("\r备份中... {0}%（{1}/{2} 文件）  ", pct, done, files.Count);
                    }
                }
            }
            Console.WriteLine();
            Console.WriteLine("已备份旧版本: " + zipPath);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("备份旧版本失败（继续更新）: " + ex.Message);
        }
    }

    static void CollectFiles(List<string[]> list, string dir, string prefix)
    {
        if (!Directory.Exists(dir)) return;
        // 手写递归遍历并实时输出扫描进度：Directory.GetFiles(..., AllDirectories) 在
        // 巨大 node_modules 上会长时间无输出，用户会误以为卡死。这里边扫边刷新计数。
        var stack = new Stack<string>();
        stack.Push(dir);
        DateTime last = DateTime.UtcNow;
        long scanned = 0;
        Console.Write("正在扫描本地文件...");
        while (stack.Count > 0)
        {
            string current = stack.Pop();
            string[] subdirs;
            try { subdirs = Directory.GetDirectories(current); } catch { subdirs = new string[0]; }
            foreach (string sd in subdirs) stack.Push(sd);
            string[] fileEntries;
            try { fileEntries = Directory.GetFiles(current); } catch { fileEntries = new string[0]; }
            foreach (string file in fileEntries)
            {
                string rel = prefix + "/" + file.Substring(dir.Length) .TrimStart('\\', '/') .Replace('\\', '/');
                list.Add(new string[] { file, rel });
                scanned++;
                if ((DateTime.UtcNow - last).TotalMilliseconds > 400)
                {
                    last = DateTime.UtcNow;
                    Console.Write("\r正在扫描本地文件... {0} 个  ", scanned);
                }
            }
        }
        Console.Write("\r" + new string(' ', 50) + "\r"); // 清掉扫描进度行
    }


    static void AddOne(List<string[]> list, string path, string entryName)
    {
        if (File.Exists(path)) list.Add(new string[] { path, entryName });
    }

    static string JsonValue(string json, string key)
    {
        Match m = Regex.Match(json, "\"" + key + "\":\\s*\"([^\"]*)\"");
        return m.Success ? m.Groups[1].Value : "";
    }

    // Release body 形如 "Auto build master@<40位sha>"
    static string ExtractSha(string json)
    {
        Match m = Regex.Match(json, "@([0-9a-f]{40})");
        return m.Success ? m.Groups[1].Value : "";
    }

    static string FindPortableAsset(string json)
    {
        MatchCollection matches = Regex.Matches(json, "\"browser_download_url\":\\s*\"([^\"]*)\"");
        foreach (Match m in matches)
        {
            string url = m.Groups[1].Value.Replace("\\/", "/");
            if (url.IndexOf("dsh-portable-win64", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return url;
            }
        }
        return null;
    }

    static bool IsDshRunning(string baseDir)
    {
        string[] names = new string[] { "node", "dsh" };
        foreach (string name in names)
        {
            Process[] procs = Process.GetProcessesByName(name);
            foreach (Process p in procs)
            {
                try
                {
                    string fn = p.MainModule.FileName;
                    if (fn.StartsWith(baseDir, StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }
                catch { }
            }
        }
        return false;
    }
}
