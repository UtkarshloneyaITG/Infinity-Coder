import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess, execFile } from 'child_process';
import { ToolSpec, ToolContext, normalizePath, errText } from './common';

/**
 * Shell tools: run a command, list the background ones, stop one.
 *
 * A long-running command (a dev server) is spawned detached with its output going
 * to a log file, and tracked so it can be listed and stopped later. On Windows the
 * whole tree is killed with taskkill /T, so `npm run dev` takes its child node
 * processes down with it.
 */

const IS_WINDOWS = process.platform === 'win32';

// Clearly-catastrophic command patterns, refused before running. The model is the
// primary gate; this is the safety net under it.
const DENY = new RegExp(
  [
    /\bformat\s+[a-z]:/,                      // format C:
    /\bdel\b[^\n]*\s\/[sq]\b/,               // del /s or /q
    /\b(rmdir|rd)\b[^\n]*\s\/s\b/,           // rmdir /s
    /\brm\s+-[rf]{1,2}\s+(\/|~|\*|\.)(\s|$)/, // rm -rf / | ~ | * | .
    /\bshutdown\b/, /\brestart\b/,
    /\bdiskpart\b/, /\bmkfs\b/, /\bformat-volume\b/,
    /\bcipher\b[^\n]*\s\/w/,
    /\bdd\b[^\n]*of=\/dev\//, />\s*\/dev\/sd/,
    /:\(\)\s*\{/,                             // fork bomb :(){ :|:& };:
    /\bdeltree\b/,
  ].map(r => r.source).join('|'),
  'i'
);

const MAX_OUTPUT = 4000;

interface Proc {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  child: ChildProcess;
  logPath: string;
  startedAt: number;
  exitCode: number | null;
  alive: boolean;
}

class Registry {
  private procs = new Map<string, Proc>();
  private counter = 0;

  public start(command: string, cwd: string, logDir: string): Proc {
    this.reap();
    const id = `p${++this.counter}`;
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `proc-${id}.log`);
    const logFd = fs.openSync(logPath, 'w');

    let child: ChildProcess;
    try {
      child = spawn(command, {
        shell: true,
        cwd,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      });
    } finally {
      fs.closeSync(logFd); // the child keeps its own inherited handle
    }

    const proc: Proc = {
      id, command, cwd,
      pid: child.pid ?? -1,
      child, logPath,
      startedAt: Date.now(),
      exitCode: null,
      alive: true,
    };
    child.on('exit', code => { proc.alive = false; proc.exitCode = code; });
    child.on('error', () => { proc.alive = false; });
    // Detached + unref so a running dev server does not keep the extension host
    // alive, and so it survives independently of this tool call.
    child.unref();

    this.procs.set(id, proc);
    return proc;
  }

  public async stop(proc: Proc): Promise<void> {
    if (IS_WINDOWS && proc.pid > 0) {
      await new Promise<void>(resolve => {
        execFile('taskkill', ['/F', '/T', '/PID', String(proc.pid)], () => resolve());
      });
    } else {
      try {
        // Negative pid kills the whole detached process group.
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        try { proc.child.kill('SIGTERM'); } catch { /* already gone */ }
      }
    }
    proc.alive = false;
    this.procs.delete(proc.id);
  }

  public list(): Proc[] {
    this.reap();
    return [...this.procs.values()];
  }

  public find(id?: string, match?: string): Proc[] {
    this.reap();
    if (id) {
      const found = this.procs.get(id);
      return found ? [found] : [];
    }
    if (match) {
      const m = match.toLowerCase();
      return this.list().filter(p => p.command.toLowerCase().includes(m));
    }
    return [];
  }

  /** Forget processes that exited on their own. */
  private reap(): void {
    for (const [id, p] of this.procs) {
      if (!p.alive) {
        this.procs.delete(id);
      }
    }
  }

  /** Called on extension deactivate so dev servers do not outlive the window. */
  public async stopAll(): Promise<void> {
    await Promise.all(this.list().map(p => this.stop(p)));
  }
}

export const registry = new Registry();

function resolveCwd(cwd: unknown, ctx: ToolContext): string | null {
  if (cwd && String(cwd).trim()) {
    const p = normalizePath(String(cwd), ctx);
    return fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null;
  }
  return ctx.workspaceRoot || process.cwd();
}

function readLogHead(logPath: string, limit = 1500): string {
  try {
    const fd = fs.openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(limit);
      const read = fs.readSync(fd, buf, 0, limit, 0);
      return buf.subarray(0, read).toString('utf8').trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Run a command to completion, killing the whole tree if it outlives `timeoutMs`. */
function runForeground(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn(command, {
      shell: true,
      cwd,
      // No stdin: an interactive prompt gets EOF and aborts fast instead of
      // hanging until the timeout.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !IS_WINDOWS, // own process group, so the timeout can kill the tree
    });

    let out = '';
    let timedOut = false;
    const append = (chunk: Buffer) => {
      if (out.length < MAX_OUTPUT * 2) {
        out += chunk.toString('utf8');
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const timer = setTimeout(() => {
      timedOut = true;
      if (IS_WINDOWS && child.pid) {
        execFile('taskkill', ['/F', '/T', '/PID', String(child.pid)], () => undefined);
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, timeoutMs);

    child.on('error', err => {
      clearTimeout(timer);
      resolve({ code: null, out: String(err), timedOut: false });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, out, timedOut });
    });
  });
}

const runCommand: ToolSpec = {
  name: 'run_command',
  group: 'shell',
  description:
    'Run a shell command in the project and return its output. Use this for build ' +
    "and dev commands — 'npm install', 'git status', 'python main.py', running " +
    'tests. For a long-running server that never exits (npm run dev, uvicorn) you ' +
    'MUST pass background=true — it starts detached and returns a process id you ' +
    'can later stop with stop_process or see with list_processes. Pass cwd to run ' +
    'in a subfolder.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      cwd: { type: 'string', description: 'Folder to run in (default: the project root).' },
      background: { type: 'boolean', description: 'True for a long-running server so it runs detached.' },
      timeout: { type: 'integer', description: 'Seconds to wait for a foreground command (default 60, max 300).' },
    },
    required: ['command'],
  },
  async run(args, ctx) {
    const cmd = String(args.command || '').trim();
    if (!cmd) {
      return 'What command should I run?';
    }
    if (DENY.test(cmd)) {
      return `I won't run that — it looks destructive: ${cmd}`;
    }
    const workdir = resolveCwd(args.cwd, ctx);
    if (workdir === null) {
      return `That folder doesn't exist: ${args.cwd}`;
    }

    if (args.background) {
      let proc: Proc;
      try {
        proc = registry.start(cmd, workdir, ctx.logDir);
      } catch (e) {
        return `Couldn't start '${cmd}': ${errText(e)}`;
      }
      // Give it a moment to start so an immediate failure is caught and reported.
      await new Promise(r => setTimeout(r, 2000));
      const status = proc.alive ? 'running' : `exited immediately (code ${proc.exitCode})`;
      const head = readLogHead(proc.logPath);
      let msg = `Started '${cmd}' in ${workdir} — ${status} (id ${proc.id}, pid ${proc.pid}).`;
      if (head) {
        msg += `\nFirst output:\n${head}`;
      }
      return msg;
    }

    let seconds = parseInt(args.timeout, 10);
    seconds = Number.isFinite(seconds) ? Math.max(1, Math.min(seconds, 300)) : 60;

    const { code, out, timedOut } = await runForeground(cmd, workdir, seconds * 1000);
    if (timedOut) {
      return (
        `'${cmd}' didn't finish within ${seconds}s. If it's a long-running server ` +
        '(like npm run dev or uvicorn), run it again with background=true.'
      );
    }

    let body = out.trim();
    if (body.length > MAX_OUTPUT) {
      body = body.slice(0, MAX_OUTPUT) + '\n…(output truncated)';
    }
    const header = `Command finished (exit ${code}).`;
    return body ? `${header}\n${body}` : `${header} (no output)`;
  },
};

const listProcesses: ToolSpec = {
  name: 'list_processes',
  group: 'shell',
  description:
    'List the background processes started with run_command that are still running ' +
    '(dev servers, etc.), with their id, command, folder, pid and uptime. Use this ' +
    'to see what is running, or to find the id for stop_process.',
  parameters: { type: 'object', properties: {} },
  async run() {
    const running = registry.list();
    if (running.length === 0) {
      return 'No background processes are running.';
    }
    const lines = [`${running.length} running process(es):`];
    for (const p of running) {
      const up = Math.round((Date.now() - p.startedAt) / 1000);
      lines.push(`- ${p.id}: ${p.command}  [pid ${p.pid}, up ${up}s, cwd ${p.cwd}]`);
    }
    return lines.join('\n');
  },
};

const stopProcess: ToolSpec = {
  name: 'stop_process',
  group: 'shell',
  description:
    'Stop a background process started with run_command. Identify it by id (from ' +
    "list_processes) or by a piece of its command in match (e.g. 'uvicorn'). Use " +
    "list_processes first if you're unsure which is running.",
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: "The process id from list_processes, e.g. 'p1'." },
      match: { type: 'string', description: "Text to match in the command, e.g. 'uvicorn'." },
    },
  },
  async run(args) {
    if (!args.id && !args.match) {
      const running = registry.list();
      if (running.length === 0) {
        return 'No background processes are running.';
      }
      const which = running.map(p => `${p.id} (${p.command})`).join(', ');
      return `Which should I stop? Give an id or a name. Running: ${which}`;
    }

    const found = registry.find(args.id, args.match);
    if (found.length === 0) {
      return 'No running process matches that. Use list_processes to see what is running.';
    }
    if (found.length > 1) {
      const which = found.map(p => `${p.id} (${p.command})`).join(', ');
      return `That matches several: ${which}. Stop it by id.`;
    }

    await registry.stop(found[0]);
    return `Stopped ${found[0].id} (${found[0].command}).`;
  },
};

export const SHELL_TOOLS: ToolSpec[] = [runCommand, listProcesses, stopProcess];
