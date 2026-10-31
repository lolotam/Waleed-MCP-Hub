using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading;
using System.Windows.Forms;

namespace WaleedMcpHub
{
    internal static class Setup
    {
        private static string Hash(Stream stream)
        {
            using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }

        private static void LocalDirectory(string path)
        {
            if (!Path.IsPathRooted(path) || path.StartsWith(@"\\") || path.IndexOfAny(new char[] { '"', '\r', '\n' }) >= 0)
                throw new IOException("Choose an absolute local installation folder.");
            for (DirectoryInfo item = new DirectoryInfo(path); item != null; item = item.Parent)
                if (item.Exists && (item.Attributes & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("The installation folder must not contain directory links.");
        }

        private static string EntryPath(string root, ZipArchiveEntry entry)
        {
            // .NET Framework's Windows ZIP writer uses backslashes. Normalize
            // both ZIP separator styles before checking traversal and duplicates.
            string name = entry.FullName.Replace('\\', '/');
            if (name.Length == 0 || name.Contains(":") || name.StartsWith("/") || ((entry.ExternalAttributes >> 16) & 0xf000) == 0xa000)
                throw new IOException("Invalid application archive entry.");
            foreach (string part in name.TrimEnd('/').Split('/'))
                if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" "))
                    throw new IOException("Invalid application archive path.");
            string path = Path.GetFullPath(Path.Combine(root, name.Replace('/', Path.DirectorySeparatorChar)));
            if (!path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Application archive path escaped the installation folder.");
            return path;
        }

        private static bool Matches(string root, ZipArchive archive)
        {
            LocalDirectory(root);
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                string path = EntryPath(root, entry);
                if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\")) { LocalDirectory(path); continue; }
                LocalDirectory(Path.GetDirectoryName(path));
                if (!File.Exists(path) || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) return false;
                using (Stream actual = File.OpenRead(path))
                using (Stream expected = entry.Open())
                    if (actual.Length != entry.Length || Hash(actual) != Hash(expected)) return false;
            }
            return true;
        }

        private static string Install(string root, Action<int, int> progress)
        {
            LocalDirectory(root);
            Directory.CreateDirectory(root);
            using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("wmh-payload.zip"))
            {
                if (resource == null || Hash(resource) != Payload.Sha256) throw new IOException("The installer payload is damaged. Download a fresh installer.");
                resource.Position = 0;
                using (ZipArchive archive = new ZipArchive(resource, ZipArchiveMode.Read))
                {
                    string target = Path.Combine(root, Payload.Version + "-" + Payload.Sha256.Substring(0, 16));
                    if (Directory.Exists(target))
                    {
                        if (Matches(target, archive)) return target;
                        // Repair into a new folder; running installations and
                        // previous connector pointers remain available.
                        target += "-repair-" + Guid.NewGuid().ToString("N");
                    }
                    string staging = Path.Combine(root, ".staging-" + Guid.NewGuid().ToString("N"));
                    Directory.CreateDirectory(staging);
                    HashSet<string> paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    int index = 0;
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        string path = EntryPath(staging, entry);
                        if (!paths.Add(path)) throw new IOException("Duplicate application archive entry.");
                        if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\")) Directory.CreateDirectory(path);
                        else
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(path));
                            using (Stream source = entry.Open())
                            using (Stream destination = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) source.CopyTo(destination);
                        }
                        progress(++index, archive.Entries.Count);
                    }
                    foreach (string required in new string[] { "WaleedMcpHub.exe", "runtime/node.exe", "apps/server/dist/main.js", "apps/web/dist/index.html", "node_modules/npm/package.json" })
                        if (!File.Exists(Path.Combine(staging, required))) throw new IOException("A required application package is missing.");
                    LocalDirectory(root);
                    Directory.Move(staging, target);
                    return target;
                }
            }
        }

        private static void Shortcut(string directory, string executable, string installationRoot)
        {
            if (String.IsNullOrEmpty(directory)) return;
            Directory.CreateDirectory(directory);
            string path = Path.Combine(directory, "Waleed MCP Hub.lnk");
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(shellType);
            object link = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
            Type linkType = link.GetType();
            if (File.Exists(path))
            {
                string existing = linkType.InvokeMember("TargetPath", BindingFlags.GetProperty, null, link, null) as string;
                if (String.IsNullOrEmpty(existing) || !Path.GetFullPath(existing).StartsWith(installationRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return;
            }
            linkType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { executable });
            linkType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, link, new object[] { Path.GetDirectoryName(executable) });
            linkType.InvokeMember("Description", BindingFlags.SetProperty, null, link, new object[] { "Waleed MCP Hub" });
            linkType.InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
        }

        [STAThread]
        private static int Main(string[] args)
        {
            string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "WaleedMcpHub");
            bool launch = true, shortcuts = true, silent = false;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--no-launch") launch = false;
                else if (args[i] == "--no-shortcuts") shortcuts = false;
                else if (args[i] == "--silent") silent = true;
                else if (args[i] == "--directory" && i + 1 < args.Length) root = args[++i];
                else return 2;
            }
            Form window = null;
            try
            {
                if (!Environment.Is64BitOperatingSystem) throw new IOException("Windows 10/11 x64 is required.");
                LocalDirectory(root);
                root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
                string sid = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
                using (Mutex mutex = new Mutex(false, @"Local\WaleedMcpHubSetup-" + sid))
                {
                    bool owned = false;
                    try
                    {
                        try { owned = mutex.WaitOne(0); } catch (AbandonedMutexException) { owned = true; }
                        if (!owned) throw new IOException("Another Waleed MCP Hub installer is running.");
                        ProgressBar bar = null;
                        if (!silent)
                        {
                            window = new Form { Text = "Waleed MCP Hub Setup", ClientSize = new Size(450, 110), FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, ControlBox = false, StartPosition = FormStartPosition.CenterScreen };
                            window.Controls.Add(new Label { Text = "Installing Waleed MCP Hub and its included packages...", Left = 20, Top = 20, Width = 410 });
                            bar = new ProgressBar { Left = 20, Top = 55, Width = 410 };
                            window.Controls.Add(bar);
                            window.Show();
                            Application.DoEvents();
                        }
                        string installed = Install(root, delegate(int value, int total) { if (bar != null) { bar.Maximum = total; bar.Value = value; Application.DoEvents(); } });
                        string executable = Path.Combine(installed, "WaleedMcpHub.exe");
                        if (shortcuts)
                        {
                            Shortcut(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), executable, root);
                            Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Waleed MCP Hub"), executable, root);
                        }
                        if (window != null) { window.Close(); window = null; }
                        if (launch) Process.Start(new ProcessStartInfo(executable) { WorkingDirectory = installed, UseShellExecute = false });
                        return 0;
                    }
                    finally { if (owned) mutex.ReleaseMutex(); }
                }
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                if (!silent) MessageBox.Show(error.Message, "Waleed MCP Hub Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            finally { if (window != null) window.Dispose(); }
        }
    }
}
