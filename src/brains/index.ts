import type * as vscode from 'vscode';
import * as path from 'path';
import { Engine } from '../engine/agent';
import { SettingsStore } from '../settings';
import { BrainRegistry } from './registry';
import { BrainRunner } from './runner';
import { TaskPlanner } from './planner';
import { Scheduler } from './scheduler';
import { ConsensusEngine } from './consensus';
import { ConflictResolver } from './conflicts';
import { ProviderRouter, CostTracker } from './router';
import { MemoryManager, FileMemoryPersistence } from './memory';
import { ConversationBus } from './bus';
import { ContextBuilder } from './context';
import { Orchestrator } from './orchestrator';
import { BrainDef, OrchestrationSettings, ORCHESTRATION_DEFAULTS } from './types';

/**
 * Composition root.
 *
 * Every module in this folder takes its collaborators through its constructor
 * and reaches for nothing global. This is the one place that knows how they fit
 * together, which is what makes each of them testable in isolation — see
 * orchestration.test.ts, which builds the same graph with fakes.
 */

const STORAGE_KEY = 'infinityCoder.orchestration';

/** Orchestration settings, persisted in globalState next to the rest. */
export class OrchestrationStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  public get(): OrchestrationSettings {
    const saved = this.context.globalState.get<Partial<OrchestrationSettings>>(STORAGE_KEY);
    return {
      ...structuredClone(ORCHESTRATION_DEFAULTS),
      ...(saved || {}),
      overrides: { ...(saved?.overrides || {}) },
      brainRoots: saved?.brainRoots?.length ? saved.brainRoots : [...ORCHESTRATION_DEFAULTS.brainRoots],
    };
  }

  public async patch(patch: Partial<OrchestrationSettings>): Promise<OrchestrationSettings> {
    const next = { ...this.get(), ...patch };
    await this.context.globalState.update(STORAGE_KEY, next);
    return next;
  }

  /** Save a per-brain override. Passing an empty object clears it. */
  public async setBrainOverride(id: string, override: Partial<BrainDef>): Promise<OrchestrationSettings> {
    const current = this.get();
    const overrides = { ...current.overrides };
    if (Object.keys(override).length === 0) {
      delete overrides[id];
    } else {
      overrides[id] = { ...(overrides[id] || {}), ...override };
    }
    return this.patch({ overrides });
  }
}

export interface Orchestration {
  orchestrator: Orchestrator;
  registry: BrainRegistry;
  bus: ConversationBus;
  memory: MemoryManager;
  router: ProviderRouter;
  store: OrchestrationStore;
}

export interface CreateOptions {
  context: vscode.ExtensionContext;
  settings: SettingsStore;
  engine: Engine;
  workspaceRoot: string;
  isTrusted: boolean;
}

export function createOrchestration(options: CreateOptions): Orchestration {
  const storageRoot = options.context.globalStorageUri.fsPath;
  const store = new OrchestrationStore(options.context);
  const readOrchestration = () => store.get();

  const registry = new BrainRegistry(readOrchestration);
  const bus = new ConversationBus();
  const memory = new MemoryManager(
    new FileMemoryPersistence(path.join(storageRoot, 'brain-memory.json')),
    readOrchestration().memoryLimitEntries
  );
  const router = new ProviderRouter(
    () => options.settings.get(),
    readOrchestration,
    new CostTracker(path.join(storageRoot, 'brain-costs.json'))
  );
  const context = new ContextBuilder(options.workspaceRoot);

  const runner = new BrainRunner({
    engine: options.engine,
    bus,
    memory,
    router,
    context,
    workspaceRoot: options.workspaceRoot,
    logDir: path.join(storageRoot, 'procs'),
    isTrusted: options.isTrusted,
  });

  const orchestrator = new Orchestrator({
    registry,
    runner,
    planner: new TaskPlanner({ runner, registry }),
    scheduler: new Scheduler({ runner, registry, bus }),
    consensus: new ConsensusEngine({ runner, registry, bus }),
    conflicts: new ConflictResolver(),
    router,
    memory,
    bus,
    readSettings: readOrchestration,
  });

  return { orchestrator, registry, bus, memory, router, store };
}

export { Orchestrator } from './orchestrator';
export { BrainRegistry } from './registry';
export { ConversationBus } from './bus';
export { MemoryManager } from './memory';
export { Executor, changeSetStat } from './executor';
export * from './types';
