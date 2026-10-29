using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace WaleedMcpHub
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                
                string nodePath = Path.Combine(baseDir, "runtime", "node.exe");
                if (!File.Exists(nodePath))
                {
                    string toolsNode = @"E:\Dev\Tools_and_Utilities\nodejs24\node.exe";
                    if (File.Exists(toolsNode))
                    {
                        nodePath = toolsNode;
                    }
                    else
                    {
                        string envNode = Environment.GetEnvironmentVariable("HUB_NODE_PATH");
                        if (!string.IsNullOrEmpty(envNode) && File.Exists(envNode))
                        {
                            nodePath = envNode;
                        }
                        else
                        {
                            nodePath = "node.exe";
                        }
                    }
                }

                string scriptPath = Path.Combine(baseDir, "scripts", "desktop.mjs");
                if (!File.Exists(scriptPath))
                {
                    MessageBox.Show("Could not find scripts\\desktop.mjs in:\n" + baseDir, "Waleed MCP Hub", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }

                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = nodePath,
                    Arguments = "\"" + scriptPath + "\"",
                    WorkingDirectory = baseDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };

                Process process = Process.Start(psi);
                if (process == null)
                {
                    MessageBox.Show("Failed to start Waleed MCP Hub process.", "Waleed MCP Hub", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }

                process.WaitForExit();
                // Exit code -1 (0xFFFFFFFF) indicates external process termination (taskkill/shutdown); only alert on actual crashes (> 0).
                if (process.ExitCode != 0 && process.ExitCode != -1)
                {
                    string log = Path.Combine(
                        Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? baseDir,
                        "WaleedMcpHub", "desktop.log");
                    MessageBox.Show("Waleed MCP Hub stopped with an error (exit code " + process.ExitCode + ").\nSee the log:\n" + log, "Waleed MCP Hub", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                return process.ExitCode;
            }
            catch (Exception ex)
            {
                MessageBox.Show("Error launching Waleed MCP Hub:\n" + ex.Message, "Waleed MCP Hub", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
    }
}

