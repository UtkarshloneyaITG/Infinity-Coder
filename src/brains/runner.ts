import { Engine } from '../engine/agent';
import { dispatch as baseDispatch } from '../engine/tools';
import { ChatStreamEvent, UsageInfo } from '../types';
import { BRAIN_PROTOCOL } from './defaults';
import { BrainDef, BrainMessage, FileChange, Proposal, Task } from './types';
import { BrainStage, StagingWorkspace, createBrainDispatch, toolAllowed } from './staging';
import { ContextBuilder } from './context';
import { MemoryManager } from './memory';
import { ConversationBus } from './bus';
import { ProviderRouter, estimateCost } from './router';

/**
 * The Brain Runner — one brain, one task, one isolated turn.
 *
 * This is where all the isolation is actually applied: a private prompt, a
 * private tool set, a private slice of the workspace, a private memory view and
 * a staged filesystem. Nothing in here reaches across to another brain, which is
 * what makes running a dozen of them concurrently safe.
 */

export interface RunnerDeps {
  engine: Engine;
  bus: ConversationBus;
  memory: MemoryManager;
  router: ProviderRouter;
  context: ContextBuilder;
  workspaceRoot: string;
  logDir: string;
  isTrusted: boolean;
}

export interface RunTaskOptions {
  task: Task;
  brain: BrainDef;
  staging: StagingWorkspace;
  /** The user's original request, for relevance ranking and framing. */
  goal: string;
  /** Distinguishes the members of a debate. */
  variant?: number;
  spentThisRun: number;
  timeoutMs: number;
  signal: AbortSignal;
  onStage?: (change: FileChange) => void;
  onStream?: (event: ChatStreamEvent) => void;
}

export class BrainRunner {
  constructor(private readonly deps: RunnerDeps) {}

  public async run(options: RunTaskOptions): Promise<Proposal> {
    const { task, brain, staging, goal, signal } = options;
    const key = options.variant ? `${task.id}#${brain.id}#${options.variant}` : `${task.id}#${brain.id}`;
    const started = Date.now();

    const route = this.deps.router.route(brain, options.spentThisRun);
    const stage = new BrainStage(staging, brain.id, task.id);

    const proposal: Proposal = {
      key,
      taskId: task.id,
      brainId: brain.id,
      provider: route.providers[0] || 'auto',
      model: route.model,
      summary: '',
      reasoning: '',
      pros: [],
      cons: [],
      risks: [],
      evidence: [],
      complexity: 'medium',
      confidence: 0,
      changes: [],
      raw: '',
      latencyMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    };

    if (route.downgradedFrom) {
      this.deps.bus.publish({
        type: 'status',
        from: brain.id,
        taskId: task.id,
        subject: 'Budget downgrade',
        body: `Running on ${route.model} instead of ${route.downgradedFrom} — the configured budget is exhausted.`,
      });
    }

    // A brain that hangs must not hold a concurrency slot forever, and the run's
    // own cancellation has to win over the timeout.
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.max(10_000, options.timeoutMs));

    let text = '';
    let usage: UsageInfo | undefined;

    try {
      const system = this.buildSystem(brain, staging, goal);
      const history: Array<Record<string, any>> = [];

      text = await this.deps.engine.chat({
        userText: this.buildUserMessage(options),
        history,
        workspaceRoot: this.deps.workspaceRoot,
        logDir: this.deps.logDir,
        isTrusted: this.deps.isTrusted,
        signal: controller.signal,
        systemOverride: system,
        modelOverride: route.model,
        providerOrder: route.providers,
        temperature: route.temperature,
        maxTokens: route.maxTokens,
        toolFilter: name => toolAllowed(brain, name),
        dispatchOverride: createBrainDispatch({
          brain,
          stage,
          workspaceRoot: this.deps.workspaceRoot,
          base: baseDispatch,
          onStage: options.onStage,
        }),
        onEvent: event => {
          if (event.type === 'usage') {
            usage = event.usage;
          }
          options.onStream?.(event);
        },
      });
    } catch (e: any) {
      const aborted = signal.aborted;
      proposal.error = aborted
        ? 'Cancelled.'
        : controller.signal.aborted
          ? `Timed out after ${Math.round(options.timeoutMs / 1000)}s.`
          : e?.message || String(e);
      proposal.summary = proposal.error || 'Failed.';
      proposal.confidence = 0;
      proposal.latencyMs = Date.now() - started;
      this.publish(proposal, task, 'criticism');
      return proposal;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }

    const parsed = parseReport(text);
    Object.assign(proposal, parsed);
    proposal.raw = text;
    proposal.changes = stage.changes();
    proposal.latencyMs = Date.now() - started;
    proposal.tokensIn = usage?.promptTokens || 0;
    proposal.tokensOut = usage?.completionTokens || 0;
    proposal.costUsd = estimateCost(route.model, proposal.tokensIn, proposal.tokensOut);
    // Weight the self-report: a brain the user trusts less should not be able to
    // win consensus by simply claiming certainty.
    proposal.confidence = clamp01(parsed.confidence * brain.confidenceWeight);

    if (!proposal.summary) {
      // No report block. The turn still did real work, so keep it and use its
      // prose — discarding a staged change set over a formatting miss is worse.
      proposal.summary = text.trim().slice(0, 1200) || 'No response.';
      proposal.confidence = Math.min(proposal.confidence || 0.3, 0.3);
    }

    this.rememberOutcome(brain, task, proposal);
    this.publish(proposal, task, 'proposal');
    return proposal;
  }

  private buildSystem(brain: BrainDef, staging: StagingWorkspace, goal: string): string {
    const context = this.deps.context.build(brain, staging, goal);
    const memory = this.deps.memory.render(brain);
    return [brain.systemPrompt, BRAIN_PROTOCOL, memory, context.text].filter(Boolean).join('\n\n');
  }

  private buildUserMessage(options: RunTaskOptions): string {
    const { task, goal, variant } = options;
    const parts = [
      `TEAM GOAL: ${goal}`,
      '',
      `YOUR TASK (${task.id}): ${task.title}`,
      task.instruction,
    ];
    if (task.acceptance) {
      parts.push('', `DONE MEANS: ${task.acceptance}`);
    }

    const upstream = this.deps.bus
      .history({ type: 'proposal' })
      .filter(m => task.dependsOn.includes(m.taskId || ''))
      .map(m => `- ${m.from} finished "${m.subject}": ${m.body}`);
    if (upstream.length > 0) {
      parts.push('', 'WHAT THE TEAM ALREADY DID (build on it, do not redo it):', ...upstream);
    }

    if (variant) {
      // Debate members must not converge by accident, so each is told to take a
      // genuinely different line rather than to be different for its own sake.
      parts.push(
        '',
        `You are approach #${variant} of several being tried independently on this task. ` +
          `Solve it the way YOU think is best and commit to it fully. Do not hedge toward ` +
          `a middle option, and do not try to guess what the others will do — the point of ` +
          `running several is to compare genuinely different answers.`
      );
    }
    return parts.join('\n');
  }

  private rememberOutcome(brain: BrainDef, task: Task, proposal: Proposal): void {
    if (brain.memory.private) {
      this.deps.memory.remember('private', brain.id, `Task ${task.id}: ${proposal.summary}`, task.id);
    }
    if (brain.memory.writesShared) {
      const files = proposal.changes.map(c => c.relPath);
      const note = files.length
        ? `${task.title} — done. Files: ${files.join(', ')}. ${proposal.summary}`
        : `${task.title} — ${proposal.summary}`;
      this.deps.memory.remember('shared', brain.id, note, `${task.id}:shared`);
    }
  }

  private publish(proposal: Proposal, task: Task, type: BrainMessage['type']): void {
    this.deps.bus.publish({
      type,
      from: proposal.brainId,
      taskId: task.id,
      subject: task.title,
      body: proposal.summary,
      data: {
        confidence: proposal.confidence,
        files: proposal.changes.map(c => c.relPath),
        risks: proposal.risks,
        model: proposal.model,
      },
    });
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/**
 * Pull the report block out of a brain's reply.
 *
 * Models get this wrong in predictable ways — a bare object with no fence, a
 * fence with prose after it, `json5`-ish trailing commas — and re-prompting for
 * a format fix costs a whole extra round trip. So: try the fenced block, then
 * the last balanced object, then give up gracefully and let the caller fall back
 * to the prose.
 */
export function parseReport(text: string): {
  summary: string;
  reasoning: string;
  pros: string[];
  cons: string[];
  risks: string[];
  evidence: string[];
  complexity: 'low' | 'medium' | 'high';
  confidence: number;
} {
  const empty = {
    summary: '',
    reasoning: '',
    pros: [] as string[],
    cons: [] as string[],
    risks: [] as string[],
    evidence: [] as string[],
    complexity: 'medium' as const,
    confidence: 0.5,
  };

  const raw = extractJson(text);
  if (!raw) {
    return empty;
  }
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    try {
      obj = JSON.parse(raw.replace(/,(\s*[}\]])/g, '$1'));
    } catch {
      return empty;
    }
  }
  if (!obj || typeof obj !== 'object') {
    return empty;
  }

  const complexity = ['low', 'medium', 'high'].includes(obj.complexity) ? obj.complexity : 'medium';
  return {
    summary: str(obj.summary),
    reasoning: str(obj.reasoning),
    pros: strArray(obj.pros),
    cons: strArray(obj.cons),
    risks: strArray(obj.risks),
    evidence: strArray(obj.evidence),
    complexity,
    confidence: typeof obj.confidence === 'number' ? obj.confidence : 0.5,
  };
}

export function extractJson(text: string): string | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const body = fences[i][1].trim();
    if (body.startsWith('{')) {
      return body;
    }
  }
  // Unfenced: scan forward for the LAST balanced top-level object, ignoring
  // braces inside strings — a summary describing code is full of them. Forward,
  // not backward, because escape sequences can only be read left to right.
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let last: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        last = text.slice(start, i + 1);
      } else if (depth < 0) {
        depth = 0; // a stray closing brace in prose — resynchronise
      }
    }
  }
  return last;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) {
    return typeof v === 'string' && v.trim() ? [v.trim()] : [];
  }
  return v.map(x => (typeof x === 'string' ? x.trim() : String(x))).filter(Boolean).slice(0, 12);
}
