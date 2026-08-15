// dsh 便携版启动器（C# 5.0，.NET Framework 4.8 的 csc 编译）
// 职责：定位自身目录 → 设 DSH_HOME=程序目录\data（绿色，不写 ~/.dsh）→ 把 node 加进 PATH → 运行 node bin.js
// 无参数时默认启动 web 模式，并自动打开浏览器。

using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading;
using Microsoft.Win32;

class DshLauncher
{
    static int Main(string[] args)
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string nodeExe = Path.Combine(baseDir, "node", "node.exe");
        string binJs = Path.Combine(baseDir, "app", "lib", "bin.js");
        string dataDir = Path.Combine(baseDir, "data");

        if (!File.Exists(nodeExe))
        {
            Console.Error.WriteLine("错误：未找到 node 运行时（" + nodeExe + "）。请勿把 dsh.exe 移出程序目录。");
            return 1;
        }
        if (!File.Exists(binJs))
        {
            Console.Error.WriteLine("错误：未找到 dsh 入口（" + binJs + "）。程序不完整，请重新下载完整包。");
            return 1;
        }

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

        bool autoWeb = args.Length == 0;

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = nodeExe;
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.Arguments = Quote(binJs) + (autoWeb ? " web" : "");
        foreach (string a in args)
        {
            psi.Arguments += " " + Quote(a);
        }

        Process p = new Process();
        p.StartInfo = psi;
        p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) Console.Out.WriteLine(e.Data); };
        p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) Console.Error.WriteLine(e.Data); };
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
        return p.ExitCode;
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
