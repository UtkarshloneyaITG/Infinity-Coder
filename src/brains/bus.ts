import { BrainMessage, BrainMessageType } from './types';

/**
 * The Conversation Bus — every structured message brains exchange.
 *
 * Observer pattern, deliberately synchronous: subscribers are the UI and the
 * transcript, and an async fan-out would let a task finish before its own
 * messages had been recorded.
 *
 * The bus is also the run transcript. Nothing else stores what was said, so
 * `history()` is what the Reviewer and the Consensus brain are shown.
 */

export type BusListener = (message: BrainMessage) => void;

let counter = 0;

export class ConversationBus {
  private readonly messages: BrainMessage[] = [];
  private readonly listeners = new Set<BusListener>();

  constructor(private readonly limit = 2000) {}

  public publish(message: Omit<BrainMessage, 'id' | 'ts'>): BrainMessage {
    const full: BrainMessage = { ...message, id: `msg-${++counter}`, ts: Date.now() };
    this.messages.push(full);
    while (this.messages.length > this.limit) {
      this.messages.shift();
    }
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch {
        // A broken subscriber (a disposed webview) must not stop the run or
        // starve the other subscribers of this message.
      }
    }
    return full;
  }

  public subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public history(filter?: { taskId?: string; from?: string; type?: BrainMessageType }): BrainMessage[] {
    return this.messages.filter(m => {
      if (filter?.taskId && m.taskId !== filter.taskId) {
        return false;
      }
      if (filter?.from && m.from !== filter.from) {
        return false;
      }
      if (filter?.type && m.type !== filter.type) {
        return false;
      }
      return true;
    });
  }

  /** A compact transcript for prompting a downstream brain. */
  public render(filter?: { taskId?: string }, limit = 60): string {
    return this.history(filter)
      .slice(-limit)
      .map(m => `[${m.type}] ${m.from}${m.to ? ` -> ${m.to}` : ''}: ${m.subject}${m.body ? `\n  ${m.body}` : ''}`)
      .join('\n');
  }

  public clear(): void {
    this.messages.length = 0;
  }
}
