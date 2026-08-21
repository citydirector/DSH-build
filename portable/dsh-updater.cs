// dsh 便携版更新器（C# 5.0，.NET Framework 4.8 的 csc 编译）
// 职责：读 VERSION → 查 GitHub 最新 Release → 有更新则下载 zip → robocopy 原地覆盖（保留 data/）
// 绿色：不写注册表、不写 C 盘用户目录；一切在程序目录内完成。

using System;
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
        Console.WriteLine();
        Console.WriteLine("按任意键退出...");
        try { Console.ReadKey(); } catch { }
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

        string json = HttpGet("https://api.github.com/repos/" + Repo + "/releases/latest");
        if (json == null)
        {
            Console.Error.WriteLine("无法连接 GitHub，检查更新失败（需要网络）。");
            return 1;
        }

        string tag = JsonValue(json, "tag_name");
        string latestSha = ExtractSha(json);

        if (latestSha != "" && latestSha == current)
        {
            Console.WriteLine("已是最新版本（" + tag + "）。");
            return 0;
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
        try
        {
            ZipFile.ExtractToDirectory(zipPath, newDir);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("解压失败：" + ex.Message);
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
        sb.AppendLine("robocopy \"" + newDir + "\" \"" + baseDir.TrimEnd('\\') + "\" /MIR /XD data /XF update.exe /NFL /NDL /NJH /NJS");
        sb.AppendLine("if errorlevel 8 exit /b 1");
        sb.AppendLine("exit /b 0");
        File.WriteAllText(applyCmd, sb.ToString());

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = "cmd.exe";
        psi.Arguments = "/c \"\"" + applyCmd + "\"\"";
        psi.UseShellExecute = true;
        Process.Start(psi);

        Console.WriteLine("更新已开始，本窗口稍后关闭。");
        return 0;
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

    // 更新前把旧版本关键内容打成 zip（app/node/dsh.exe/VERSION/update.exe），便于回滚
    static void BackupOld(string baseDir)
    {
        try
        {
            string backupDir = Path.Combine(baseDir, "data", "backups");
            Directory.CreateDirectory(backupDir);
            string zipPath = Path.Combine(backupDir, "dsh-backup-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".zip");
            using (ZipArchive zip = ZipFile.Open(zipPath, ZipArchiveMode.Create))
            {
                AddDir(zip, Path.Combine(baseDir, "app"), "app");
                AddDir(zip, Path.Combine(baseDir, "node"), "node");
                AddFile(zip, Path.Combine(baseDir, "dsh.exe"), "dsh.exe");
                AddFile(zip, Path.Combine(baseDir, "VERSION"), "VERSION");
                AddFile(zip, Path.Combine(baseDir, "update.exe"), "update.exe");
            }
            Console.WriteLine("已备份旧版本: " + zipPath);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("备份旧版本失败（继续更新）: " + ex.Message);
        }
    }

    static void AddDir(ZipArchive zip, string dir, string prefix)
    {
        if (!Directory.Exists(dir)) return;
        foreach (string file in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
        {
            string rel = prefix + "/" + file.Substring(dir.Length).TrimStart('\\', '/').Replace('\\', '/');
            AddFile(zip, file, rel);
        }
    }

    static void AddFile(ZipArchive zip, string path, string entryName)
    {
        if (!File.Exists(path)) return;
        ZipArchiveEntry entry = zip.CreateEntry(entryName, CompressionLevel.Optimal);
        using (Stream src = File.OpenRead(path))
        using (Stream dst = entry.Open())
        {
            src.CopyTo(dst);
        }
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
