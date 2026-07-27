import { ToolSpec, ToolContext } from './common';
import { FILE_TOOLS } from './files';
import { SEARCH_TOOLS } from './search';
import { SHELL_TOOLS, registry as procRegistry } from './shell';
import { WEB_TOOLS } from './web';

/**
 * The tool registry: schemas offered to the model, name aliases, and dispatch.
 *
 * `dispatch` never throws into the agent loop: a bad call comes back as a string
 * the model can read and correct. One failing tool must not kill the turn.
 */

export { ToolContext, ToolSpec } from './common';
export { procRegistry };

export const ALL_TOOLS: ToolSpec[] = [...FILE_TOOLS, ...SEARCH_TOOLS, ...SHELL_TOOLS, ...WEB_TOOLS];

const BY_NAME = new Map(ALL_TOOLS.map(t => [t.name, t]));

/**
 * Names models sometimes emit for a capability we expose under a different name.
 * 'search'/'grep' mean grep-a-file when a path is given, otherwise a web search.
 */
function resolveAlias(name: string, args: any): string | undefined {
  if (['search', 'grep', 'search_files', 'grep_files', 'find_in_files', 'search_text'].includes(name)) {
    return args && args.path ? 'search_in_files' : 'web_search';
  }
  if (['read', 'cat', 'read_text'].includes(name)) {
    return 'read_file';
  }
  if (['ls', 'dir', 'list_directory', 'list_dir'].includes(name)) {
    return 'list_folder';
  }
  if (['bash', 'shell', 'exec', 'execute_command', 'terminal'].includes(name)) {
    return 'run_command';
  }
  return undefined;
}

const UNTRUSTED_MESSAGE =
  'This workspace is not trusted, so shell commands are disabled. The user can ' +
  'enable them with "Workspaces: Manage Workspace Trust" in the command palette.';

const PLAN_MODE_MESSAGE =
  'Plan mode is on, so this tool is unavailable — nothing may be changed yet. ' +
  'Keep investigating with the read-only tools and present your plan for approval.';

/**
 * The tools plan mode allows. An allowlist rather than a list of mutating tools,
 * so a tool added later is withheld until someone has decided it is read-only —
 * the failure is "plan mode is too strict", never "plan mode edited the project".
 *
 * run_command is excluded even though plenty of commands only read: the argument
 * is free-form text, so allowing it would put the entire gate on the model's
 * judgement about its own command string.
 */
const PLAN_MODE_TOOLS = new Set([
  'read_file', 'list_folder',
  'find_files', 'search_in_files',
  'list_processes',
  'web_search', 'read_page', 'extract_links',
]);

/**
 * OpenAI `tools` array for the enabled groups. Omitting a tool here is the real
 * gate — a tool that is never offered cannot be called. `dispatch` re-checks
 * anyway, since a model can emit a tool name it was never given.
 */
export function toolSchemas(
  enabledGroups?: Record<string, boolean>,
  isTrusted = true,
  planMode = false
): any[] {
  const tools = ALL_TOOLS.filter(t => {
    if (t.group === 'shell' && !isTrusted) {
      return false;
    }
    if (planMode && !PLAN_MODE_TOOLS.has(t.name)) {
      return false;
    }
    return enabledGroups ? enabledGroups[t.group] !== false : true;
  });
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export async function dispatch(name: string, args: any, ctx: ToolContext): Promise<string> {
  let tool = BY_NAME.get(name);
  if (!tool) {
    const alias = resolveAlias(name, args);
    if (alias) {
      tool = BY_NAME.get(alias);
    }
  }
  if (!tool) {
    return `Unknown tool: ${name}. Available tools: ${[...BY_NAME.keys()].join(', ')}`;
  }
  if (tool.group === 'shell' && !ctx.isTrusted) {
    return UNTRUSTED_MESSAGE;
  }
  // Withholding the schema is the real gate, but a model can call a tool it was
  // never offered — and in plan mode that call would be a write to the project.
  if (ctx.planMode && !PLAN_MODE_TOOLS.has(tool.name)) {
    return PLAN_MODE_MESSAGE;
  }
  try {
    return String(await tool.run(args || {}, ctx));
  } catch (e: any) {
    // A tool that throws is a bug, but the model can still recover from a message.
    return `Tool '${tool.name}' failed: ${e?.message || String(e)}`;
  }
}
