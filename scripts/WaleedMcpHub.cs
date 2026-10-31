using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace WaleedMcpHub
{
    internal static class Launcher
    {
        [STAThread]
        private static int Main(string[] args)
        {
            bool selfTest = args.Length == 1 && args[0] == "--self-test";
            if (args.Length != 0 && !selfTest) return 2;
            try
            {
                string root = AppDomain.CurrentDomain.BaseDirectory;
                string node = Path.Combine(root, "runtime", "node.exe");
                string script = Path.Combine(root, "scripts", "desktop.mjs");
                foreach (string file in new string[] { node, script, Path.Combine(root, "apps", "server", "dist", "main.js"), Path.Combine(root, "apps", "web", "dist", "index.html") })
                    if (!File.Exists(file)) throw new IOException("An application file is missing. Run Waleed-MCP-Hub-Setup.exe again.");
                ProcessStartInfo start = new ProcessStartInfo(node, selfTest ? "--version" : "\"" + script + "\"");
                start.WorkingDirectory = root;
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.RedirectStandardError = true;
                start.RedirectStandardOutput = true;
                // Connector subprocesses can find the shipped runtime without a
                // system Node installation or a machine-wide PATH change.
                start.EnvironmentVariables["PATH"] = Path.GetDirectoryName(node) + ";" + (Environment.GetEnvironmentVariable("PATH") ?? "");
                using (Process process = Process.Start(start))
                {
                    string diagnostic = "";
                    process.OutputDataReceived += delegate { };
                    process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null && diagnostic.Length < 8192) diagnostic += e.Data + Environment.NewLine; };
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();
                    process.WaitForExit();
                    // Exit code -1 (0xFFFFFFFF) indicates external process termination (taskkill/shutdown); only alert on actual crashes (> 0).
                    if (process.ExitCode != 0 && process.ExitCode != -1 && !selfTest)
                        MessageBox.Show("Waleed MCP Hub could not start.\n\n" + diagnostic + "\nSee %LOCALAPPDATA%\\WaleedMcpHub\\desktop.log for details.", "Waleed MCP Hub", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return process.ExitCode;
                }
            }
            catch (Exception error)
            {
                if (!selfTest) MessageBox.Show(error.Message, "Waleed MCP Hub", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
    }
}
