// Windows 10+ only. Attach a non-breakaway, kill-on-close Job Object at process
// creation, not afterward: killing the host can never strand an unowned child.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace WaleedHub {
    public sealed class Request {
        public string Executable { get; set; }
        public string[] Arguments { get; set; }
        public Dictionary<string, string> Environment { get; set; }
        public string StandardInput { get; set; }
        public string WorkingDirectory { get; set; }
        public long Deadline { get; set; }
        public int OutputLimitBytes { get; set; }
        public bool Duplex { get; set; }
    }

    public static class ProcessHost {
        [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
            public int Length; public IntPtr Descriptor; public int Inherit;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
            public int Size; public string Reserved; public string Desktop; public string Title;
            public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
            public short ShowWindow, ReservedBytes; public IntPtr ReservedPointer;
            public IntPtr Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {
            public StartupInfo Info; public IntPtr Attributes;
        }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInformation {
            public IntPtr Process, Thread; public uint ProcessId, ThreadId;
        }
        [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
            public long ProcessTime, JobTime; public uint Flags;
            public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcessLimit;
            public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters {
            public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        }
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
            public BasicLimits Basic; public IoCounters Io;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
        [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation process);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

        static readonly object Gate = new object();
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 131072 };
        static int emittedBytes, outputExceeded, cancelled;
        static IntPtr activeJob;
        static long Now() { return (DateTime.UtcNow.Ticks - 621355968000000000L) / 10000; }
        static void Require(bool success) { if (!success) throw new InvalidOperationException("Host capability unavailable."); }
        static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }

        static void Emit(object frame) {
            lock (Gate) { Console.Out.WriteLine(Json.Serialize(frame)); Console.Out.Flush(); }
        }

        // Microsoft CRT/CommandLineToArgvW quoting. There is no cmd.exe, shell
        // expansion, PowerShell interpretation, or concatenated shell program.
        static string Quote(string value) {
            StringBuilder result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in value) {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
                else { result.Append('\\', slashes); result.Append(c); }
                slashes = 0;
            }
            result.Append('\\', slashes * 2); result.Append('"');
            return result.ToString();
        }

        static void Pump(IntPtr readHandle, string channel, int limit) {
            using (FileStream stream = new FileStream(new SafeFileHandle(readHandle, true), FileAccess.Read, 8192, false)) {
                byte[] buffer = new byte[8192];
                try {
                    int count;
                    while ((count = stream.Read(buffer, 0, buffer.Length)) > 0) {
                        lock (Gate) {
                            int allowed = Math.Max(0, Math.Min(count, limit - emittedBytes));
                            if (allowed > 0) {
                                Console.Out.WriteLine(Json.Serialize(new { @event = channel, data = Convert.ToBase64String(buffer, 0, allowed) }));
                                Console.Out.Flush();
                                emittedBytes += allowed;
                            }
                            if (allowed < count) {
                                Interlocked.Exchange(ref outputExceeded, 1);
                                TerminateJobObject(activeJob, 1);
                                break;
                            }
                        }
                    }
                } finally { Array.Clear(buffer, 0, buffer.Length); }
            }
        }

        static void Pipe(out IntPtr read, out IntPtr write) {
            SecurityAttributes attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = 1 };
            Require(CreatePipe(out read, out write, ref attributes, 0));
            Require(SetHandleInformation(read, 1, 0));
        }

        static void SupplyInput(IntPtr writeHandle, string value) {
            using (FileStream stream = new FileStream(new SafeFileHandle(writeHandle, true), FileAccess.Write, 4096, false)) {
                // A target may close stdin early or be terminated while input is
                // pending. That does not permit writing into the control channel.
                try {
                    if (value != null) {
                        byte[] bytes = new UTF8Encoding(false).GetBytes(value);
                        try {
                            stream.Write(bytes, 0, bytes.Length);
                            stream.Flush();
                        } finally { Array.Clear(bytes, 0, bytes.Length); }
                    }
                } catch (IOException) { }
            }
        }

        static void SupplyDuplexInput(IntPtr writeHandle, BlockingCollection<byte[]> queue) {
            using (FileStream stream = new FileStream(new SafeFileHandle(writeHandle, true), FileAccess.Write, 4096, false)) {
                try { foreach (byte[] bytes in queue.GetConsumingEnumerable()) { try { stream.Write(bytes, 0, bytes.Length); stream.Flush(); } finally { Array.Clear(bytes, 0, bytes.Length); } } }
                catch (IOException) { }
            }
        }

        public static int Run(string payload) {
            IntPtr job = IntPtr.Zero, inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero;
            IntPtr outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero, errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero;
            IntPtr attributes = IntPtr.Zero, handleList = IntPtr.Zero, jobList = IntPtr.Zero, environment = IntPtr.Zero;
            bool attributesInitialized = false;
            ProcessInformation process = new ProcessInformation();
            BlockingCollection<byte[]> inputQueue = new BlockingCollection<byte[]>(64);
            try {
                Request request = Json.Deserialize<Request>(payload);
                if (request == null || request.OutputLimitBytes < 1 || request.OutputLimitBytes > 1048576) throw new InvalidOperationException();
                if (Now() >= request.Deadline) { Emit(new { @event = "result", outcome = "timed_out", exitCode = (int?)null }); return 0; }
                // A detached parent closes stdin, causing the same owned-job cleanup
                // as explicit cancellation. No PID enumeration or taskkill is used.
                Task.Run(() => {
                    try { int supplied = 0; while (true) {
                        string line = Console.In.ReadLine();
                        if (line == null || line == "cancel") { inputQueue.CompleteAdding(); Interlocked.Exchange(ref cancelled, 1); return; }
                        if (request.Duplex && line == "eof") { inputQueue.CompleteAdding(); continue; }
                        if (request.Duplex && line.StartsWith("stdin ", StringComparison.Ordinal)) {
                            if (line.Length > 44000) throw new InvalidOperationException();
                            byte[] bytes = Convert.FromBase64String(line.Substring(6)); supplied += bytes.Length;
                            if (bytes.Length > 32768 || supplied > 1048576 || !inputQueue.TryAdd(bytes)) throw new InvalidOperationException();
                        }
                    } }
                    catch { Interlocked.Exchange(ref cancelled, 1); }
                });
                job = CreateJobObjectW(IntPtr.Zero, null);
                Require(job != IntPtr.Zero);
                activeJob = job;
                ExtendedLimits limits = new ExtendedLimits();
                limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
                Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
                Pipe(out inputRead, out inputWrite);
                // Input's child end is the read end, unlike output/error pipes.
                Require(SetHandleInformation(inputRead, 1, 1));
                Require(SetHandleInformation(inputWrite, 1, 0));
                Pipe(out outputRead, out outputWrite);
                Pipe(out errorRead, out errorWrite);
                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
                Require(size != IntPtr.Zero);
                attributes = Marshal.AllocHGlobal(size);
                Require(InitializeProcThreadAttributeList(attributes, 2, 0, ref size));
                attributesInitialized = true;
                handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(handleList, 0, inputRead);
                Marshal.WriteIntPtr(handleList, IntPtr.Size, outputWrite);
                Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, errorWrite);
                Require(UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x20002, handleList, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
                jobList = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobList, job);
                // PROC_THREAD_ATTRIBUTE_JOB_LIST attaches atomically at creation.
                Require(UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x2000D, jobList, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero));
                List<string> entries = new List<string>();
                foreach (KeyValuePair<string, string> pair in request.Environment) entries.Add(pair.Key + "=" + pair.Value);
                entries.Sort(StringComparer.OrdinalIgnoreCase);
                environment = Marshal.StringToHGlobalUni(String.Join("\0", entries.ToArray()) + "\0\0");
                StringBuilder command = new StringBuilder(Quote(request.Executable));
                foreach (string argument in request.Arguments) command.Append(" ").Append(Quote(argument));
                if (command.Length >= 32767) throw new InvalidOperationException();
                StartupInfoEx startup = new StartupInfoEx();
                startup.Info.Size = Marshal.SizeOf(typeof(StartupInfoEx));
                startup.Info.Flags = 0x100; // STARTF_USESTDHANDLES
                startup.Info.Input = inputRead; startup.Info.Output = outputWrite; startup.Info.Error = errorWrite;
                startup.Attributes = attributes;
                if (Now() >= request.Deadline || Volatile.Read(ref cancelled) != 0) {
                    Emit(new { @event = "result", outcome = Now() >= request.Deadline ? "timed_out" : "cancelled", exitCode = (int?)null }); return 0;
                }
                // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT |
                // EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW
                Require(CreateProcessW(request.Executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080404, environment, request.WorkingDirectory, ref startup, out process));
                Close(ref inputRead);
                Close(ref outputWrite); Close(ref errorWrite);
                IntPtr stdout = outputRead, stderr = errorRead, stdin = inputWrite;
                outputRead = IntPtr.Zero; errorRead = IntPtr.Zero; inputWrite = IntPtr.Zero;
                Task inTask = Task.Run(() => { if (request.Duplex) SupplyDuplexInput(stdin, inputQueue); else SupplyInput(stdin, request.StandardInput); });
                Task outTask = Task.Run(() => Pump(stdout, "stdout", request.OutputLimitBytes));
                Task errTask = Task.Run(() => Pump(stderr, "stderr", request.OutputLimitBytes));
                Emit(new { @event = "started" });
                Require(ResumeThread(process.Thread) != 0xFFFFFFFF);
                string outcome = "exited";
                while (true) {
                    uint waited = WaitForSingleObject(process.Process, 25);
                    if (waited == 0) break;
                    Require(waited == 0x102);
                    if (Volatile.Read(ref outputExceeded) != 0) { outcome = "output_limit"; break; }
                    if (Volatile.Read(ref cancelled) != 0) { outcome = "cancelled"; break; }
                    if (Now() >= request.Deadline) { outcome = "timed_out"; break; }
                }
                if (Volatile.Read(ref outputExceeded) != 0) outcome = "output_limit";
                // Also reap descendants left behind by a normally exited root.
                Require(TerminateJobObject(job, 1));
                inputQueue.CompleteAdding();
                Require(WaitForSingleObject(process.Process, 3000) == 0);
                Require(Task.WaitAll(new Task[] { inTask, outTask, errTask }, 3000));
                uint exitCode;
                Require(GetExitCodeProcess(process.Process, out exitCode));
                Emit(new { @event = "result", outcome = outcome, exitCode = (int?)unchecked((int)exitCode) });
                return 0;
            } catch {
                Emit(new { @event = "error", code = "host_unavailable" });
                return 1;
            } finally {
                byte[] remaining;
                while (inputQueue.TryTake(out remaining)) Array.Clear(remaining, 0, remaining.Length);
                // Closing the last job handle kills only this invocation's members,
                // even if creation failed or the host itself is force-terminated.
                Close(ref job); activeJob = IntPtr.Zero;
                Close(ref process.Thread); Close(ref process.Process);
                Close(ref inputRead); Close(ref inputWrite);
                Close(ref outputRead); Close(ref outputWrite); Close(ref errorRead); Close(ref errorWrite);
                if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
                if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            }
        }
    }
}
