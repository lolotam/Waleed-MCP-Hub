import { tmpdir } from 'node:os';
// Real bridge, real process host, real process tree: exclusively disposable
// roots, never a real agent, a user file or a secret.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  openStateStore,
  openSafetyLedger,
  createLifecycle,
  localRuntimeAdapters,
  windowsAgentTargets,
  definitionHash,
  writeBootRecord,
} from '@waleed/hub-core';
if (process.platform !== 'win32')
  throw new Error('Windows session containment smoke requires Windows.');
const peerFixture = fileURLToPath(
  new URL('../tests/fixtures/stateful-peer.mjs', import.meta.url),
);
const bridgeFixture = fileURLToPath(
  new URL('../tests/fixtures/session-bridge.mjs', import.meta.url),
);
// The agent of the disposable registry: one integration record is enough.
const agentId = 'cursor';
// The containment budget of the spec: five seconds.
const containment = 5000;
// The idle limit of the case that expires it: two seconds.
const idleLimit = 2000;
// The connector of the peer is unavailable once the pool replaced it.
const connectorUnavailable =
  'The connector is unavailable, changed, disabled, or requires authentication. Inspect the hub and refresh tools.';
// The disposable roots of the cases. They are removed when every case passed
// and the cleanup left nothing behind.
const roots = [];
// Whether a case left a process behind or could not prove it did not. Either
// fails the whole run and keeps the roots.
let cleanupFailed = false;

const powershell = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
// The C# helper of one case. It holds a handle of every process the case
// owns until the case ends: while a handle is open, Windows never hands the
// id of its process to another program, so every check and every end reaches
// the process the case confirmed and never a stranger. It reads one command
// per line and answers one line.
const helperSource = `using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

public static class WaleedSmokeHelper
{
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint PROCESS_TERMINATE = 0x0001;
    const uint SYNCHRONIZE = 0x00100000;
    const uint WAIT_OBJECT_0 = 0x00000000;
    const uint WAIT_TIMEOUT = 0x00000102;
    const int ERROR_INVALID_PARAMETER = 87;
    static readonly string[] Roles = { "host", "server", "grandchild" };

    [StructLayout(LayoutKind.Sequential)]
    struct FILETIME { public uint Low; public uint High; }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr process, int informationClass, ref PROCESS_BASIC_INFORMATION information, int length, out int returned);

    class Held
    {
        public int Pid;
        public IntPtr Handle;
        public ulong Created;
        public long Parent;
    }

    // The processes of the case by tree and role, and every handle in the
    // order it was taken.
    static readonly Dictionary<string, Held> held = new Dictionary<string, Held>();
    static readonly List<Held> handles = new List<Held>();
    // The bridge of the case. Its handle cannot end it: the script ends the
    // bridge through its own handle. It anchors a tree only once the script
    // confirmed, after the handle was open, that its bridge still ran.
    static Held bridge;
    static bool trusted;

    public static void Serve()
    {
        TextReader input = Console.In;
        TextWriter output = Console.Out;
        output.WriteLine("ready");
        output.Flush();
        string line;
        while ((line = input.ReadLine()) != null)
        {
            string answer;
            try { answer = Answer(line.Trim().Split(' ')); }
            catch { answer = "unknown"; }
            output.WriteLine(answer);
            output.Flush();
        }
        foreach (Held process in handles) CloseHandle(process.Handle);
        handles.Clear();
        held.Clear();
        if (bridge != null) CloseHandle(bridge.Handle);
        bridge = null;
    }

    static string Answer(string[] words)
    {
        switch (words[0])
        {
            case "bridge":
                return HoldBridge(int.Parse(words[1]));
            case "trust-bridge":
                if (bridge == null) return "unknown";
                trusted = true;
                return "trusted";
            case "capture":
                return Capture(words[1], new int[] { int.Parse(words[2]), int.Parse(words[3]), int.Parse(words[4]) });
            case "alive":
                return State(Find(words[1], words[2]), 0);
            case "wait":
                return State(Find(words[1], words[2]), uint.Parse(words[3]));
            case "kill-host":
                return KillHost(words[1], long.Parse(words[2]));
            case "terminate":
                return TerminateAll();
            default:
                return "unknown";
        }
    }

    // The creation moment and the parent of a process, read through its own
    // handle.
    static bool Read(Held process)
    {
        FILETIME creation, exit, kernel, user;
        if (!GetProcessTimes(process.Handle, out creation, out exit, out kernel, out user)) return false;
        process.Created = ((ulong)creation.High << 32) | creation.Low;
        PROCESS_BASIC_INFORMATION information = new PROCESS_BASIC_INFORMATION();
        int returned;
        if (NtQueryInformationProcess(process.Handle, 0, ref information, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out returned) != 0) return false;
        process.Parent = information.InheritedFromUniqueProcessId.ToInt64();
        return true;
    }

    // Opens the bridge of the case once. The handle may query and wait, never
    // end the process.
    static string HoldBridge(int pid)
    {
        if (bridge != null) return "unknown";
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, pid);
        if (handle == IntPtr.Zero) return "unknown";
        Held process = new Held();
        process.Pid = pid;
        process.Handle = handle;
        if (!Read(process)) { CloseHandle(handle); return "unknown"; }
        bridge = process;
        return "held";
    }

    // The ownership of one tree: the process host of the trusted bridge, the
    // server of the host and the grandchild of the server. Every handle is
    // open before any check, so no id of the chain can pass to another
    // program while it is checked. A process belongs to the tree when the
    // process before it in the chain created it and was created first: an
    // earlier process with the same id ended before that one was created, so
    // it cannot be the parent. Every link that holds stays held, so the
    // cleanup still ends it when the rest of the chain fails. The tree is
    // confirmed only when the whole chain holds and every process of it runs.
    static string Capture(string tree, int[] pids)
    {
        if (!trusted || held.ContainsKey(tree + ".host")) return "foreign";
        Held[] chain = new Held[pids.Length];
        string verdict = "confirmed";
        int opened = 0;
        for (; opened < pids.Length; opened++)
        {
            IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, false, pids[opened]);
            if (handle == IntPtr.Zero)
            {
                verdict = Marshal.GetLastWin32Error() == ERROR_INVALID_PARAMETER ? "missing" : "foreign";
                break;
            }
            chain[opened] = new Held();
            chain[opened].Pid = pids[opened];
            chain[opened].Handle = handle;
        }
        int owned = 0;
        for (; owned < opened; owned++)
        {
            Held process = chain[owned];
            if (!Read(process)) { verdict = "foreign"; break; }
            Held parent = owned == 0 ? bridge : chain[owned - 1];
            if (process.Parent != parent.Pid || process.Created < parent.Created) { verdict = "foreign"; break; }
        }
        for (int index = 0; index < opened; index++)
        {
            if (index < owned)
            {
                held[tree + "." + Roles[index]] = chain[index];
                handles.Add(chain[index]);
            }
            else CloseHandle(chain[index].Handle);
        }
        if (verdict != "confirmed") return verdict;
        for (int index = 0; index < chain.Length; index++)
        {
            uint waited = WaitForSingleObject(chain[index].Handle, 0);
            if (waited == WAIT_OBJECT_0) return "missing";
            if (waited != WAIT_TIMEOUT) return "foreign";
        }
        return "confirmed";
    }

    static Held Find(string tree, string role)
    {
        if (Array.IndexOf(Roles, role) < 0) return null;
        Held process;
        return held.TryGetValue(tree + "." + role, out process) ? process : null;
    }

    // Whether a held process ends within the wait: gone or alive. A process
    // that is not held is unknown.
    static string State(Held process, uint milliseconds)
    {
        if (process == null) return "unknown";
        uint waited = WaitForSingleObject(process.Handle, milliseconds);
        if (waited == WAIT_OBJECT_0) return "gone";
        if (waited == WAIT_TIMEOUT) return "alive";
        return "unknown";
    }

    // Ends the process host of a tree. The server and the grandchild must run
    // right before the end, checked in the same command; the clock starts
    // right before the end and measures until each of them is gone.
    static string KillHost(string tree, long budget)
    {
        Held host = Find(tree, "host");
        Held server = Find(tree, "server");
        Held grandchild = Find(tree, "grandchild");
        if (host == null || server == null || grandchild == null) return "unknown";
        if (WaitForSingleObject(host.Handle, 0) != WAIT_TIMEOUT) return "not-ready";
        if (WaitForSingleObject(server.Handle, 0) != WAIT_TIMEOUT) return "not-ready";
        if (WaitForSingleObject(grandchild.Handle, 0) != WAIT_TIMEOUT) return "not-ready";
        Stopwatch clock = Stopwatch.StartNew();
        if (!TerminateProcess(host.Handle, 1)) return "unknown";
        long serverGone = WaitGone(server, budget, clock);
        long grandchildGone = WaitGone(grandchild, budget, clock);
        if (serverGone < 0 || grandchildGone < 0) return "outlived";
        return "killed " + serverGone + " " + grandchildGone;
    }

    // The milliseconds of the clock when the process was gone, or -1 when
    // the budget ended first.
    static long WaitGone(Held process, long budget, Stopwatch clock)
    {
        long remaining = budget - clock.ElapsedMilliseconds;
        if (remaining < 0) return -1;
        if (WaitForSingleObject(process.Handle, (uint)remaining) != WAIT_OBJECT_0) return -1;
        long elapsed = clock.ElapsedMilliseconds;
        return elapsed <= budget ? elapsed : -1;
    }

    // Ends every held process that still runs, through its held handle. The
    // case is clean when every one of them is gone.
    static string TerminateAll()
    {
        int stuck = 0;
        foreach (Held process in handles)
        {
            if (WaitForSingleObject(process.Handle, 0) == WAIT_OBJECT_0) continue;
            TerminateProcess(process.Handle, 1);
            if (WaitForSingleObject(process.Handle, 5000) != WAIT_OBJECT_0) stuck++;
        }
        return stuck == 0 ? "clean" : "dirty";
    }
}
`;
// The first and only script of the shell: it compiles the helper and hands
// the standard input to it. The source arrives as base64, so the shell reads
// one line, and nothing of this run reaches a command line.
const helperBootstrap =
  `$ErrorActionPreference='Stop';` +
  `Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(helperSource, 'utf8').toString('base64')}')));` +
  `[WaleedSmokeHelper]::Serve();exit`;
// A process id of this run: a positive 32-bit integer and nothing else ever
// reaches a command of the helper.
const processId = (value) => {
  if (!Number.isInteger(value) || value <= 0 || value > 0xffffffff)
    throw new Error('A process id of the case is invalid.');
  return value;
};

// Whether a child of this script leaves within the budget. The child is
// watched through the handle this script holds.
const waitExitQuiet = async (child, budget) => {
  const deadline = Date.now() + budget;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
};

// The helper of one case: one Windows PowerShell 5.1 process of this machine.
// Its output is read as answers only and never printed. A helper that breaks,
// answers out of turn or takes too long answers nothing more, so every check
// after it is unknown and the case fails. Only an end of the helper after its
// input ended, with every answer read, is a clean end.
async function startHelper() {
  const child = spawn(
    powershell,
    ['-NoProfile', '-NonInteractive', '-Command', '-'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
  );
  const waiting = [];
  let pending = '';
  let broken = false;
  let closing = false;
  let failed = false;
  let closed = false;
  let resolveClosed;
  const whenClosed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  // Every way the helper breaks is a failure, except the end of its streams
  // once this script ended its input.
  const breakDown = (expected = false) => {
    broken = true;
    if (!(expected && closing)) failed = true;
    for (const answer of waiting.splice(0)) answer(null);
    if (running(child)) child.kill();
  };
  child.stdin.on('error', () => undefined);
  child.once('error', () => breakDown());
  child.once('close', () => {
    closed = true;
    resolveClosed();
    breakDown(true);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    let index;
    while ((index = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, index).trim();
      pending = pending.slice(index + 1);
      if (!line) continue;
      const answer = waiting.shift();
      if (answer) answer(line);
      else breakDown();
    }
  });
  // One command and its answer. The helper answers in the order it was asked.
  const ask = (line, budget) =>
    new Promise((resolve) => {
      if (broken) {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => breakDown(), budget);
      waiting.push((answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      child.stdin.write(line + '\n');
    });
  // Whether the streams of the helper closed within the budget.
  const closedWithin = (budget) =>
    Promise.race([
      whenClosed.then(() => true),
      delay(budget).then(() => closed),
    ]);
  // The helper releases its handles and leaves once its input ends. A helper
  // that has to be forced fails the case. Whether the helper is gone.
  const shutdown = async () => {
    closing = true;
    try {
      child.stdin.end();
    } catch {
      /* The helper is gone. */
    }
    if (await closedWithin(10000)) return true;
    failed = true;
    child.kill();
    return closedWithin(containment);
  };
  // The compiler of the helper may take a while on a cold machine.
  if ((await ask(helperBootstrap, 60000)) !== 'ready') {
    breakDown();
    if (!(await shutdown())) cleanupFailed = true;
    throw new Error('The process helper did not start.');
  }
  return {
    holdBridge: (pid) => ask(`bridge ${processId(pid)}`, 30000),
    trustBridge: () => ask('trust-bridge', 30000),
    capture: (tree) =>
      ask(
        `capture ${tree.id} ${processId(tree.host)} ${processId(tree.server)} ${processId(tree.grandchild)}`,
        30000,
      ),
    alive: (tree, role) => ask(`alive ${tree.id} ${role}`, 30000),
    wait: (tree, role, budget) => {
      const wait = Math.max(0, Math.ceil(budget));
      return ask(`wait ${tree.id} ${role} ${wait}`, wait + 30000);
    },
    killHost: (tree, budget) =>
      ask(`kill-host ${tree.id} ${budget}`, 2 * budget + 30000),
    // Every held process that still runs ends through its held handle.
    terminate: () => ask('terminate', 60000),
    // Whether the helper left cleanly: its streams closed after its input
    // ended, it said nothing more, and nothing broke before.
    async close() {
      const gone = await shutdown();
      return gone && !failed && pending.trim() === '';
    },
  };
}

// Waits until a held process of the tree is gone and returns the
// milliseconds since the start of the deadline.
const waitGone = async (helper, tree, role, budget, since) => {
  const remaining = budget - (Date.now() - since);
  if (remaining <= 0)
    throw new Error('A contained process outlived its budget.');
  const answer = await helper.wait(tree, role, remaining);
  const elapsed = Date.now() - since;
  if (answer !== 'gone' || elapsed > budget)
    throw new Error('A contained process outlived its budget.');
  return elapsed;
};
// The readiness of a case: the server and the grandchild of the tree run.
const treeRunning = async (helper, tree) =>
  (await helper.alive(tree, 'server')) === 'alive' &&
  (await helper.alive(tree, 'grandchild')) === 'alive';
// Whether a child of this script still runs, read through its handle.
const running = (child) => child.exitCode === null && child.signalCode === null;
// The evidence of the peer: the three process ids of its tree. The file does
// not exist until the peer wrote it.
const readEvidenceFile = async (path) => {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    const valid = (value) =>
      Number.isInteger(value) && value > 0 && value <= 0xffffffff;
    if (valid(parsed.server) && valid(parsed.host) && valid(parsed.grandchild))
      return parsed;
  } catch {
    /* The peer has not written its evidence yet. */
  }
  return null;
};
// The trees of one case: every peer that wrote its evidence. The helper
// takes the handles of a tree and confirms it before the tree becomes ready,
// so every later check and the cleanup only ever reach a process the case
// owns. A tree that is not confirmed fails the case, and its processes the
// helper could not confirm are never signalled.
const watchTrees = (evidencePath, helper) => {
  const trees = [];
  let seen = '';
  let stopped = false;
  let failure;
  let resolveFirst;
  let rejectFirst;
  const first = new Promise((resolve, reject) => {
    resolveFirst = resolve;
    rejectFirst = reject;
  });
  first.catch(() => undefined);
  const giveUpAt = Date.now() + 15000;
  // Reads the evidence once and captures the tree it names when that tree is
  // not the one that was captured before.
  const capture = async () => {
    if (failure) return;
    const evidence = await readEvidenceFile(evidencePath);
    if (!evidence) return;
    const key = `${evidence.server}:${evidence.host}:${evidence.grandchild}`;
    if (key === seen) return;
    seen = key;
    const tree = {
      id: trees.length + 1,
      server: evidence.server,
      host: evidence.host,
      grandchild: evidence.grandchild,
    };
    trees.push(tree);
    const verdict = await helper.capture(tree);
    if (verdict === 'confirmed') {
      if (trees.length === 1) resolveFirst(tree);
      return;
    }
    failure = new Error('A peer tree of the case was not confirmed.');
    if (trees.length === 1) rejectFirst(failure);
  };
  const loop = (async () => {
    while (!stopped) {
      await capture();
      if (failure) break;
      if (!trees.length && Date.now() > giveUpAt) {
        resolveFirst(undefined);
        break;
      }
      await delay(50);
    }
  })();
  return {
    trees,
    first,
    // The last look at the evidence: a peer that started a moment before the
    // case ended is still captured while its processes live.
    flush: capture,
    stop: () => {
      stopped = true;
    },
    settled: loop,
    get failure() {
      return failure;
    },
  };
};

// A transport over the bridge process this script started. The script keeps
// the handle of the process, so the bridge always ends through the handle
// and never through its process id, and the stdin of the bridge ends without
// the escalation of the SDK transport: no kill follows it.
class BridgeTransport {
  constructor(child) {
    this._child = child;
    this._pending = '';
    this.onclose = undefined;
    this.onerror = undefined;
    this.onmessage = undefined;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._read(chunk));
    child.stdin.on('error', () => undefined);
    child.once('error', () =>
      this.onerror?.(new Error('The bridge could not be started.')),
    );
    child.once('close', () => this.onclose?.());
  }
  get pid() {
    return this._child.pid;
  }
  async start() {
    /* The bridge is already running. */
  }
  async send(message) {
    this._child.stdin.write(JSON.stringify(message) + '\n');
  }
  async close() {
    try {
      this._child.stdin.end();
    } catch {
      /* The bridge is gone. */
    }
  }
  _read(chunk) {
    this._pending += chunk;
    let index;
    while ((index = this._pending.indexOf('\n')) !== -1) {
      const line = this._pending.slice(0, index).replace(/\r$/, '');
      this._pending = this._pending.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.onerror?.(new Error('The bridge sent an unreadable frame.'));
        continue;
      }
      this.onmessage?.(message);
    }
  }
}

// One disposable hub: a state folder, a safety ledger, a boot record and one
// agent integration. The agent configuration lives in the disposable home.
async function createHub(root) {
  const home = join(root, 'home');
  const runtime = join(root, 'runtime');
  await mkdir(home);
  await mkdir(runtime);
  const environment = {
    USERPROFILE: home,
    APPDATA: join(home, 'Roaming'),
    PATH: '',
  };
  const targets = windowsAgentTargets(home, environment);
  for (const target of targets) {
    await mkdir(dirname(target.paths[0]), { recursive: true });
    await writeFile(
      target.paths[0],
      target.format === 'codex'
        ? '# preserve this\n[tools]\nnode_repl=true\n'
        : '{\n// preserve this\n"unrelated":"SYNTHETIC-existing-private"\n}\n',
    );
  }
  const store = await openStateStore(runtime);
  const safety = await openSafetyLedger(runtime);
  // The compiled bridge fails closed without a boot record.
  await writeBootRecord(runtime);
  const hub = createLifecycle(
    store,
    Date.now,
    safety,
    await localRuntimeAdapters(runtime, environment, () => store.read()),
  );
  const apply = async (operation) => {
    const preview = await hub.preview(
      { expectedRevision: (await store.read()).revision, ...operation },
      'smoke',
    );
    const job = await hub.apply(preview.id, 'smoke');
    await hub.drain();
    assert.ok(
      hub.job(job.id, 'smoke').state === 'succeeded',
      'A hub operation did not succeed.',
    );
  };
  return {
    store,
    runtime,
    apply,
    // One native connector of the stateful peer, approved for execution.
    async addPeer(evidencePath, initializeDelayMs) {
      await apply({
        kind: 'create_connector',
        definition: {
          id: 'stateful',
          name: 'Stateful peer',
          description: '',
          enabled: true,
          environmentLiterals: {},
          secretBindings: {},
          headerBindings: {},
          trustApproval: null,
          executionMode: 'native',
          transport: 'stdio',
          executable: process.execPath,
          arguments: [
            peerFixture,
            evidencePath,
            ...(initializeDelayMs ? [String(initializeDelayMs)] : []),
          ],
        },
      });
      const connector = (await store.read()).connectors[0];
      await apply({
        kind: 'approve_connector',
        connectorId: connector.id,
        expectedConnectorRevision: connector.revision,
        definitionHash: definitionHash(connector),
        approveExecution: true,
      });
    },
    // The agent of the registry: the bridge reads its own integration record.
    async integrateAgent() {
      const scanned = await hub.integrations.scan();
      const scanned_agent = scanned.agents.find(
        (item) => item.agentId === agentId,
      );
      assert.ok(
        scanned_agent !== undefined,
        'The disposable agent was not discovered.',
      );
      await hub.integrations.integrate(agentId, {
        expectedRevision: (await store.read()).revision,
        fingerprint: scanned_agent.fingerprint,
        confirmConfigurationChange: true,
      });
    },
    async close() {
      await hub.close();
      await safety.close();
      await store.close();
    },
  };
}

// The agent client: it starts the compiled bridge and speaks MCP to it. The
// process handle stays with this script.
async function startBridge(registry, idleMs) {
  const child = spawn(
    process.execPath,
    [
      bridgeFixture,
      registry,
      agentId,
      ...(idleMs === undefined ? [] : [String(idleMs)]),
    ],
    {
      env: getDefaultEnvironment(),
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: false,
      windowsHide: true,
    },
  );
  try {
    const transport = new BridgeTransport(child);
    const client = new Client(
      { name: 'synthetic-session-agent', version: '1' },
      { capabilities: {} },
    );
    await client.connect(transport, { timeout: 30000 });
    return { client, transport, child };
  } catch {
    // A bridge that never connected keeps its handle here: it ends through
    // the handle this script holds, never through a process id. A bridge
    // that does not leave fails the run.
    if (!(await stopBridge(child))) cleanupFailed = true;
    throw new Error('The compiled bridge did not start.');
  }
}

// Waits until the bridge process is gone and returns the milliseconds it
// took. The bridge is watched through the handle this script holds.
const waitExit = async (child, budget, since = Date.now()) => {
  while (Date.now() - since < budget) {
    if (!running(child)) return Date.now() - since;
    await delay(50);
  }
  throw new Error('The bridge outlived its budget.');
};
// The bridge ends on its own once its stdin ends. The force is the last
// resort, and it uses the handle this script holds, never a process id.
// Whether the bridge is gone at the end.
const stopBridge = async (child) => {
  if (!child) return true;
  if (!running(child)) return true;
  try {
    child.stdin.end();
  } catch {
    /* The bridge is gone. */
  }
  if (await waitExitQuiet(child, containment)) return true;
  try {
    child.kill();
  } catch {
    /* The bridge is gone. */
  }
  return waitExitQuiet(child, containment);
};
// The bridge of a case leaves with its session. Whether the bridge is gone.
const closeBridge = async (bridge) => {
  const child = bridge?.child;
  if (!child) return true;
  const stopped = await stopBridge(child);
  await bridge.client.close().catch(() => undefined);
  return stopped;
};

// One case: a disposable hub, one helper, one bridge, one peer and the case
// itself. The cleanup ends every process the case started, whatever it did,
// and a cleanup it cannot prove fails the run and keeps the roots.
async function withCase(options, run) {
  const root = await mkdtemp(join(tmpdir(), 'hub-session-'));
  roots.push(root);
  const evidencePath = join(root, 'evidence.json');
  let hub;
  let helper;
  let bridge;
  let watcher;
  let outcome;
  let failure = null;
  try {
    helper = await startHelper();
    hub = await createHub(root);
    await hub.addPeer(evidencePath, options.initializeDelayMs);
    await hub.integrateAgent();
    bridge = await startBridge(join(hub.runtime, 'state.json'), options.idleMs);
    // The trees of the peer: the helper holds and confirms every tree while
    // it lives.
    // The helper holds the bridge first. The bridge is still this script's
    // child after the handle was open, so the id could not have passed to
    // another program: only then does the bridge anchor a tree.
    assert.ok(
      running(bridge.child) &&
        (await helper.holdBridge(bridge.child.pid)) === 'held' &&
        running(bridge.child) &&
        (await helper.trustBridge()) === 'trusted',
      'The helper could not hold the bridge.',
    );
    watcher = watchTrees(evidencePath, helper);
    const capture = async () => {
      const tree = await watcher.first;
      assert.ok(tree !== undefined, 'The peer wrote no containment evidence.');
      return tree;
    };
    outcome = await run({ bridge, capture, helper });
  } catch (error) {
    failure = error;
  }
  try {
    // The last look at the evidence: a peer that started a moment before
    // the case ended is still captured while its processes live. Then no new
    // tree is captured.
    if (watcher) {
      await watcher.flush();
      watcher.stop();
      await watcher.settled;
    }
    // The bridge ends through its handle first, so the tree it owns leaves
    // with it; every held process that is still alive ends through its held
    // handle afterwards.
    let clean = await closeBridge(bridge);
    if (helper) {
      if ((await helper.terminate()) !== 'clean') clean = false;
      if (!(await helper.close())) clean = false;
    }
    // A tree that was not confirmed may have left processes nobody could
    // prove to be the case's own: they are left alone and the run fails.
    if (watcher && watcher.failure) {
      clean = false;
      if (!failure) failure = watcher.failure;
    }
    if (!clean) {
      cleanupFailed = true;
      if (!failure)
        failure = new Error('A process of the case was left behind.');
    }
  } catch (error) {
    cleanupFailed = true;
    if (!failure) failure = error;
  }
  if (hub) await hub.close().catch(() => undefined);
  if (failure) throw failure;
  return outcome;
}

// The named steps of the smoke. Each one proves one containment property.
const steps = [
  {
    name: 'a. the bridge is terminated',
    run: async () => {
      const measured = await withCase(
        {},
        async ({ bridge, capture, helper }) => {
          const tools = await bridge.client.listTools();
          assert.ok(
            tools.tools.length === 1,
            'The bridge did not list the tool of the peer.',
          );
          const name = tools.tools[0].name;
          const first = await bridge.client.callTool({ name, arguments: {} });
          assert.ok(
            first.content[0].text === '1',
            'The pooled peer did not answer the first count.',
          );
          const second = await bridge.client.callTool({ name, arguments: {} });
          assert.ok(
            second.content[0].text === '2',
            'The pooled peer did not answer the second count.',
          );
          const tree = await capture();
          // The readiness of the case: the tree runs before the bridge ends.
          assert.ok(
            await treeRunning(helper, tree),
            'The peer tree was not running before the bridge ended.',
          );
          // TerminateProcess on the bridge: the pipe of the process host ends.
          const killedAt = Date.now();
          bridge.child.kill();
          const server = await waitGone(
            helper,
            tree,
            'server',
            containment,
            killedAt,
          );
          const grandchild = await waitGone(
            helper,
            tree,
            'grandchild',
            containment,
            killedAt,
          );
          return { server, grandchild };
        },
      );
      return `the native tree was gone in ${Math.max(measured.server, measured.grandchild)} ms`;
    },
  },
  {
    name: 'b. the process host is killed',
    run: async () => {
      const measured = await withCase(
        {},
        async ({ bridge, capture, helper }) => {
          const tools = await bridge.client.listTools();
          const name = tools.tools[0].name;
          const first = await bridge.client.callTool({ name, arguments: {} });
          assert.ok(
            first.content[0].text === '1',
            'The pooled peer did not answer the first count.',
          );
          const second = await bridge.client.callTool({ name, arguments: {} });
          assert.ok(
            second.content[0].text === '2',
            'The pooled peer did not answer the second count.',
          );
          const tree = await capture();
          // The contained process host, not the bridge. The helper checks
          // that the server and the grandchild run, ends the host through its
          // held handle and measures from the moment right before the end.
          const answer = await helper.killHost(tree, containment);
          assert.ok(
            answer !== 'not-ready',
            'The peer tree was not running before the process host was killed.',
          );
          const parts = (answer ?? '').split(' ');
          assert.ok(
            parts.length === 3 && parts[0] === 'killed',
            'A contained process outlived its budget.',
          );
          const server = Number(parts[1]);
          const grandchild = Number(parts[2]);
          assert.ok(
            Number.isInteger(server) &&
              Number.isInteger(grandchild) &&
              server <= containment &&
              grandchild <= containment,
            'A contained process outlived its budget.',
          );
          // The bridge lives on: its next call never reaches the dead peer.
          const third = await bridge.client.callTool({ name, arguments: {} });
          const reply = third.content[0].text;
          assert.ok(
            reply === '1' || reply === connectorUnavailable,
            'The bridge answered a count of the dead peer.',
          );
          return { server, grandchild };
        },
      );
      return `the native tree was gone in ${Math.max(measured.server, measured.grandchild)} ms and the next count never reached the dead peer`;
    },
  },
  {
    name: 'c. the bridge shuts down during the startup',
    run: async () => {
      const measured = await withCase(
        { initializeDelayMs: 10_000 },
        async ({ bridge, capture, helper }) => {
          // The listing starts the peer; the peer delays its handshake.
          const listing = bridge.client.listTools();
          listing.catch(() => undefined);
          const tree = await capture();
          // The readiness of the case: the tree runs before the bridge ends.
          assert.ok(
            await treeRunning(helper, tree),
            'The peer tree was not running before the bridge shut down.',
          );
          // The stdin of the bridge ends while the peer is still starting.
          // The SDK transport is not used, so no kill escalates after the end
          // of the stdin: the bridge alone decides how it leaves.
          const closingAt = Date.now();
          bridge.child.stdin.end();
          // One deadline for the bridge and for the whole native tree.
          const exit = await waitExit(bridge.child, containment, closingAt);
          const server = await waitGone(
            helper,
            tree,
            'server',
            containment,
            closingAt,
          );
          const grandchild = await waitGone(
            helper,
            tree,
            'grandchild',
            containment,
            closingAt,
          );
          return { exit, server, grandchild };
        },
      );
      return `the bridge exited in ${measured.exit} ms and the native tree was gone in ${Math.max(measured.server, measured.grandchild)} ms`;
    },
  },
  {
    name: 'd. the idle limit expires',
    run: async () => {
      const measured = await withCase(
        { idleMs: idleLimit },
        async ({ bridge, capture, helper }) => {
          const tools = await bridge.client.listTools();
          const name = tools.tools[0].name;
          const first = await bridge.client.callTool({ name, arguments: {} });
          assert.ok(
            first.content[0].text === '1',
            'The pooled peer did not answer the first count.',
          );
          // One deadline for the whole expiry: the moment the count ended.
          const idleAt = Date.now();
          const tree = await capture();
          // The readiness of the case: the tree runs before the limit ends.
          assert.ok(
            await treeRunning(helper, tree),
            'The peer tree was not running before the idle limit expired.',
          );
          // The peer outlives half of the idle limit, so a death before the
          // limit is never read as an expiry. The sample is taken half of
          // the limit after the count, not after the wait that precedes it.
          const waited = Date.now() - idleAt;
          if (waited < idleLimit / 2) await delay(idleLimit / 2 - waited);
          assert.ok(
            (await helper.alive(tree, 'server')) === 'alive',
            'The pooled peer died before the idle limit expired.',
          );
          // The server and the grandchild share the deadline of the count.
          const server = await waitGone(
            helper,
            tree,
            'server',
            idleLimit + containment,
            idleAt,
          );
          const grandchild = await waitGone(
            helper,
            tree,
            'grandchild',
            idleLimit + containment,
            idleAt,
          );
          assert.ok(
            running(bridge.child),
            'The bridge did not survive the idle expiry.',
          );
          const second = await bridge.client.callTool({ name, arguments: {} });
          assert.ok(
            second.content[0].text === '1',
            'The idle expiry did not replace the peer.',
          );
          return { server, grandchild };
        },
      );
      return `the idle tree was gone in ${Math.max(measured.server, measured.grandchild)} ms and the next call started a fresh peer`;
    },
  },
];

let success = false;
let current = 'the startup';
try {
  for (const step of steps) {
    current = step.name;
    const measured = await step.run();
    console.info(`${step.name}: ${measured}.`);
  }
  success = true;
  console.info(
    'Compiled bridge containment passed: a terminated bridge, a killed process host and a shutdown during the startup each left no native tree behind within five seconds; a pooled peer answered two counts over one process and one count again after the idle expiry. No real agent, user file or secret was touched.',
  );
} catch {
  // The failure never prints a tool result, a server output or an argument.
  console.error(`The compiled bridge containment smoke failed in ${current}.`);
  process.exitCode = 1;
} finally {
  if (cleanupFailed) {
    console.error(
      'The compiled bridge containment smoke left processes behind or could not prove it did not; the temporary folders were kept for inspection.',
    );
    process.exitCode = 1;
  }
  if (success && !cleanupFailed)
    for (const root of roots)
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
  else
    console.error(
      `Only disposable recovery evidence retained at ${roots.join(', ')}.`,
    );
}
