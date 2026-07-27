import type { ChatMessage } from '../types';
import type { Msg } from './agent';

/**
 * Rebuild the engine's OpenAI-format history from a saved chat session.
 *
 * The live history lives in memory, so it is lost whenever the extension host
 * restarts. What survives is the rendered session — and its blocks already carry
 * every tool call, its arguments, and its result. Reconstructing from those gives
 * a reloaded session the same context it had before, so "continue" resumes
 * instead of starting the exploration over.
 *
 * The naive version (keep messages that have text) silently drops every
 * tool-only round, which is most of an agentic turn.
 */
export function rebuildEngineHistory(messages: ChatMessage[]): Msg[] {
  const history: Msg[] = [];
  let callCounter = 0;

  for (const message of messages) {
    if (message.role === 'user') {
      if (message.content) {
        history.push({ role: 'user', content: message.content });
      }
      continue;
    }
    if (message.role !== 'assistant' || message.error) {
      continue;
    }

    const blocks = message.blocks || [];
    if (blocks.length === 0) {
      // A legacy message, or one that never produced blocks.
      if (message.content) {
        history.push({ role: 'assistant', content: message.content });
      }
      continue;
    }

    // Text accumulates until a tool call flushes it, mirroring how the model
    // actually emitted it: some prose, then a call, then more prose.
    let pending = '';
    let emitted = false;

    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        pending += block.text;
        continue;
      }
      // A tool call with no result would leave a dangling tool_call_id, which
      // providers reject outright. Skip anything unfinished.
      if (block.type !== 'tool' || !block.done || !block.name) {
        continue;
      }

      const id = `call_${++callCounter}`;
      history.push({
        role: 'assistant',
        content: pending,
        tool_calls: [
          {
            id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          },
        ],
      });
      history.push({ role: 'tool', tool_call_id: id, content: String(block.result ?? '') });
      pending = '';
      emitted = true;
    }

    const tail = pending || (emitted ? '' : message.content || '');
    if (tail) {
      history.push({ role: 'assistant', content: tail });
    }
  }

  return history;
}
