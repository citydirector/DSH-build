// dsh 便携版更新器（C# 5.0，.NET Framework 4.8 的 csc 编译）
// 职责：读 VERSION → 查 GitHub 最新 Release → 有更新则下载 zip → robocopy 原地覆盖（保留 data/）
// 绿色：不写注册表、不写 C 盘用户目录；一切在程序目录内完成。

using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

class DshUpdater
{
    const string Repo = "citydirector/DSH-build";

    static int Main()
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

        Console.WriteLine("发现新版本 " + tag + "，正在下载...");

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
                wc.DownloadFile(url, path);
            }
            return true;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return false;
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
