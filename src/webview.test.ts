/**
 * Self-check for the generated webview HTML. Run with:
 *   npm run compile && node out/webview.test.js
 *
 * The webview script lives inside a TypeScript template literal, which makes two
 * mistakes invisible until the whole panel is dead on arrival:
 *
 *   1. A script tag without the CSP nonce — silently blocked, no UI at all.
 *   2. A regex written with single backslashes — `\s` collapses to `s` when the
 *      template literal is evaluated, so /\s+/ quietly becomes /s+/.
 *
 * Neither shows up in tsc. Both did happen. So the HTML is generated here and
 * checked, and the inline script is compiled (never executed) to catch a stray
 * backtick terminating the literal.
 */
import * as assert from 'assert';

const Module = require('module');
const realLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (request === 'vscode') {
    const disposable = { dispose() {} };
    return {
      Uri: {
        file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
        joinPath: (base: any, ...parts: string[]) => ({ toString: () => `${base}/${parts.join('/')}` }),
        from: (parts: any) => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}` }),
      },
      window: {
        onDidChangeActiveTextEditor: () => disposable,
        activeTextEditor: undefined,
        tabGroups: { all: [] },
      },
      workspace: {
        onDidChangeWorkspaceFolders: () => disposable,
        workspaceFolders: undefined,
        isTrusted: true,
        asRelativePath: (p: any) => String(p),
        fs: { delete: async () => {} },
        registerTextDocumentContentProvider: () => disposable,
      },
      commands: { executeCommand: async () => {} },
      TabInputTextDiff: class {},
    };
  }
  return realLoad.call(this, request, ...rest);
};

const { InfinityCoderSidebarProvider } = require('./sidebarProvider');
const { diffStat } = require('./approval');
const { ALL_TOOLS } = require('./engine/tools');

function fakeContext() {
  const state = new Map<string, any>();
  return {
    extensionUri: { toString: () => 'file:///ext' },
    globalStorageUri: { fsPath: '/tmp/storage' },
    globalState: {
      get: (k: string, d?: any) => (state.has(k) ? state.get(k) : d),
      update: async (k: string, v: any) => { state.set(k, v); },
    },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    subscriptions: [],
  } as any;
}

const fakeWebview = {
  asWebviewUri: (uri: any) => uri,
  cspSource: 'vscode-webview://fake',
} as any;

async function main() {
  const provider = new InfinityCoderSidebarProvider(fakeContext());
  const html: string = (provider as any)._getHtmlForWebview(fakeWebview);

  // ── CSP ──────────────────────────────────────────────────────────
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp, 'the webview must declare a CSP');
  assert.ok(csp![1].includes("default-src 'none'"), 'CSP must deny by default');

  const nonce = html.match(/nonce-([A-Za-z0-9]+)/)?.[1];
  assert.ok(nonce && nonce.length >= 16, 'CSP must carry a real nonce');

  // Every script tag needs that nonce, or it is silently blocked and no UI runs.
  const scripts = html.match(/<script[^>]*>/g) || [];
  assert.ok(scripts.length >= 3, `expected the vendored + inline scripts, found ${scripts.length}`);
  for (const tag of scripts) {
    assert.ok(tag.includes(`nonce="${nonce}"`), `script tag is missing the nonce: ${tag}`);
  }

  // ── nothing loads from the network ───────────────────────────────
  const remote = html.match(/(?:src|href)="https?:\/\/[^"]*"/g) || [];
  assert.deepStrictEqual(remote, [], `webview must not load remote resources: ${remote.join(', ')}`);

  // ── the inline script must at least compile ──────────────────────
  // A stray backtick in a comment terminates the template literal and produces
  // garbage that tsc happily accepts. new Function compiles without running.
  const inline = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inline && inline.length > 1000, 'the inline webview script should be present');
  assert.doesNotThrow(() => new Function(inline!), 'the inline webview script must parse');

  // ── regex escapes survived the template literal ──────────────────
  // These are the exact patterns that broke: written as \s they become s.
  const mustContain = [
    '[^\\s@]',        // @-mention token match
    '/\\s+/',         // language split in the code renderer
    '[\\\\/]',        // path separator split in the file picker
    'text.split(/\\s/)', // /<skill> token split in sendMessage
    '/^\\s*\\/[^\\s]*\\s?/', // stripping the typed /<skill> out of the box
  ];
  for (const needle of mustContain) {
    assert.ok(inline!.includes(needle), `regex escape was collapsed, expected to find: ${needle}`);
  }
  // A bare "(?:^|s)@" would mean the \s collapsed.
  assert.ok(!inline!.includes('(?:^|s)@'), 'the @-mention regex lost its \\s escape');

  // ── the pieces the panel needs in order to function ──────────────
  for (const id of [
    'settingsModal', 'providerList', 'toolGroupList', 'approvalSelect', 'maxContextInput',
    'filePopover', 'fileList', 'attachChips', 'promptInput', 'sendBtn', 'modelSelect',
    'streamStatus', 'streamStatusLabel', 'streamStatusTime',
    'maxRoundsInput', 'skillList', 'skillRootList', 'skillBudget',
    'addSkillRootBtn', 'rescanSkillsBtn', 'skillChips',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing element #${id}`);
  }

  // ── the empty-session landing view ───────────────────────────────
  // It is the first thing anyone sees, and it is pure markup, so nothing else
  // would catch it going missing.
  assert.ok(html.includes('class="landing-mark"'), 'the landing view shows the extension mark');
  assert.ok(html.includes('id="landingChips"'), 'the landing view offers starter prompts');
  assert.ok(!/<rect x="5" y="7" width="14" height="10"/.test(html), 'the placeholder robot art is gone');
  // A starter that sent on click would spend a turn before the user had typed
  // anything, so the handler must only fill the box.
  const chipWiring = inline!.slice(inline!.indexOf(".landing-chip'"));
  assert.ok(/promptInput\.value\s*=/.test(chipWiring), 'a starter fills the input');
  assert.ok(!/sendMessage\(\)/.test(chipWiring.slice(0, 400)), 'a starter must not send by itself');

  // ── path anchoring for tool-card file links ──────────────────────
  // The trap: path.isAbsolute('/src/app.tsx') is TRUE on win32, so using it here
  // would send a workspace-relative path straight to the filesystem root.
  const anchored = (p: string) => (provider as any).isAnchoredPath(p);
  assert.ok(!anchored('components/App.tsx'), 'a plain relative path is not anchored');
  assert.ok(!anchored('./components/App.tsx'), 'a dot-relative path is not anchored');
  if (process.platform === 'win32') {
    assert.ok(anchored('D:\\proj\\App.tsx'), 'a drive path is anchored');
    assert.ok(anchored('C:/proj/App.tsx'), 'a drive path with forward slashes is anchored');
    assert.ok(anchored('\\\\server\\share\\App.tsx'), 'a UNC path is anchored');
    assert.ok(!anchored('/src/App.tsx'), 'a leading slash is NOT anchored on Windows');
  } else {
    assert.ok(anchored('/src/App.tsx'), 'a leading slash is anchored on POSIX');
  }

  // ── inline approval card ─────────────────────────────────────────
  // It replaced a native modal, so the pieces that make it answerable have to
  // be present — without them the agent waits on a promise nothing can settle.
  for (const needle of ['renderApproval', 'approvalResponse', 'viewDiff', 'approval-feedback']) {
    assert.ok(inline!.includes(needle), `approval card is missing: ${needle}`);
  }
  assert.ok(!html.includes('showInformationMessage'), 'approval must not fall back to a native modal');

  // ── diff stat ────────────────────────────────────────────────────
  assert.deepStrictEqual(diffStat(null, 'a\nb\nc'), { added: 3, removed: 0 }, 'a new file is all additions');
  assert.deepStrictEqual(diffStat('a\nb\nc', null), { added: 0, removed: 3 }, 'a delete is all removals');
  assert.deepStrictEqual(diffStat('a\nb', 'a\nb'), { added: 0, removed: 0 }, 'no change counts as nothing');
  assert.deepStrictEqual(diffStat('a\nb', 'a\nb\nc'), { added: 1, removed: 0 }, 'an append is one addition');
  assert.deepStrictEqual(diffStat('a\nb\nc', 'a\nc'), { added: 0, removed: 1 }, 'a deleted line is one removal');
  assert.deepStrictEqual(diffStat('a\nold\nc', 'a\nnew\nc'), { added: 1, removed: 1 }, 'a replacement is one each');
  // Moving a line must not read as a rewrite — the counts are multiset-based.
  assert.deepStrictEqual(diffStat('a\nb\nc', 'c\nb\na'), { added: 0, removed: 0 }, 'a reorder changes no lines');

  // ── /<skill> invocation ──────────────────────────────────────────
  // Picking a skill must SEND, not park a chip in the input. Run the real
  // functions out of the generated script: this path has a loop and a mutual
  // call between sendMessage and executeSlashCmd, so a regression here would
  // silently break skill invocation or double-send.
  const grab = (signature: string) => {
    const start = inline!.indexOf(signature);
    assert.ok(start >= 0, `missing in the webview script: ${signature}`);
    let depth = 0;
    for (let i = inline!.indexOf('{', start); i < inline!.length; i++) {
      if (inline![i] === '{') { depth++; }
      else if (inline![i] === '}') { depth--; if (depth === 0) { return inline!.slice(start, i + 1); } }
    }
    throw new Error(`unbalanced braces in ${signature}`);
  };

  const sendSource = [
    grab('function skillCommandFor(token) {'),
    grab('function skillPromptFor(name) {'),
    grab('function pinSkill(name) {'),
    grab('function sendMessage() {'),
    grab('function executeSlashCmd(cmd) {'),
  ].join('\n');

  const buildHarness = new Function('deps', `
    const { promptInput, vscode, modelSelect, hideSlashMenu, hideFileMenu,
            renderAttachChips, renderSkillChips, skillCommands } = deps;
    let pinnedSkills = [];
    let attachedFiles = [];
    let planMode = deps.planMode || false;
    let teamMode = deps.teamMode || false;
    ${sendSource}
    return { sendMessage, executeSlashCmd };
  `);

  const fire = (value: string, act: (api: any) => void) => {
    const sent: any[] = [];
    const box = { value, focus() {}, selectionStart: 0 };
    act(buildHarness({
      promptInput: box,
      vscode: { postMessage: (m: any) => sent.push(m) },
      modelSelect: { value: 'm' },
      hideSlashMenu() {}, hideFileMenu() {}, renderAttachChips() {}, renderSkillChips() {},
      skillCommands: [
        { cmd: '/ponytail-review', desc: 'review', skill: 'ponytail-review', prompt: '' },
        { cmd: '/ponytail', desc: 'lazy', skill: 'ponytail', prompt: '' },
        { cmd: '/declared', desc: 'has one', skill: 'declared', prompt: 'Review the uncommitted diff.' },
      ],
    }));
    return sent;
  };

  // Every semantic setting is meaningless until indexing is enabled, so the
  // group is gated. Without the disabled attribute the controls stay tabbable
  // and would still submit values for a feature that is switched off.
  assert.ok(html.includes('id="semanticOptions"'), 'the semantic settings are grouped');
  assert.ok(inline!.includes('syncSemanticLock'), 'and the group is locked when disabled');
  assert.ok(inline!.includes('el.disabled = !on'), 'the lock disables the controls, not just the pointer');

  // Stopping a run lives only on the send button now, which swaps to a stop
  // control while streaming. If that ever regresses there is no way to cancel.
  assert.ok(inline!.includes('stop-mode'), 'the send button still has a stop state');
  assert.ok(inline!.includes("type: 'stopGeneration'"), 'and still posts stopGeneration');

  // Plan mode has to reach the extension, or the toggle is decorative and the
  // agent quietly edits files while the user thinks it is only planning.
  const planned = ((): any[] => {
    const sentInPlan: any[] = [];
    buildHarness({
      promptInput: { value: 'add dark mode', focus() {}, selectionStart: 0 },
      vscode: { postMessage: (m: any) => sentInPlan.push(m) },
      modelSelect: { value: 'm' },
      hideSlashMenu() {}, hideFileMenu() {}, renderAttachChips() {}, renderSkillChips() {},
      skillCommands: [],
      planMode: true,
    }).sendMessage();
    return sentInPlan;
  })();
  assert.strictEqual(planned[0].planMode, true, 'plan mode is sent with the message');
  assert.ok(html.includes('id="planToggle"'), 'the plan toggle exists in the panel');
  for (const needle of ['renderPlanActions', 'planResponse', 'setPlanMode']) {
    assert.ok(inline!.includes(needle), `plan mode is missing: ${needle}`);
  }

  // ── the thread survives a re-render ──────────────────────────────
  // renderMessages rebuilds the whole thread on every streamed chunk. Two things
  // must outlive that, and both were lost before: a Thinking panel the user
  // expanded, and their scroll position when they had scrolled up to read it.
  const thinking = grab('function renderThinking(key, text) {');
  assert.ok(/details\.open\s*=\s*openThinking\.has\(key\)/.test(thinking),
    'an expanded Thinking panel must reopen after a re-render');
  assert.ok(/addEventListener\('toggle'/.test(thinking),
    'expanding a Thinking panel must be remembered');
  // Set before the listener is attached, or the programmatic open re-fires into
  // its own handler.
  assert.ok(
    thinking.indexOf('details.open =') < thinking.indexOf("addEventListener('toggle'"),
    'open state is applied before the toggle listener is attached'
  );
  assert.ok(!/\bconst details = document\.createElement\('details'\);[\s\S]{0,400}?className = 'thinking'[\s\S]{0,400}?appendChild\(details\)/.test(
    inline!.replace(thinking, '')
  ), 'every Thinking panel goes through renderThinking, so none can lose its state');
  assert.ok(/if \(stickToBottom\) \{\s*mainContent\.scrollTop/.test(inline!),
    'the thread must only auto-scroll when the user was already at the bottom');

  // Team mode, same reasoning: a toggle that never reaches the extension would
  // silently run the single agent while the user believes a whole team ran.
  const teamed = ((): any[] => {
    const sentInTeam: any[] = [];
    buildHarness({
      promptInput: { value: 'build authentication', focus() {}, selectionStart: 0 },
      vscode: { postMessage: (m: any) => sentInTeam.push(m) },
      modelSelect: { value: 'm' },
      hideSlashMenu() {}, hideFileMenu() {}, renderAttachChips() {}, renderSkillChips() {},
      skillCommands: [],
      teamMode: true,
    }).sendMessage();
    return sentInTeam;
  })();
  assert.strictEqual(teamed[0].teamMode, true, 'team mode is sent with the message');
  assert.strictEqual(teamed[0].planMode, false, 'plan and team are independent flags');
  assert.ok(html.includes('id="teamToggle"'), 'the team toggle exists in the panel');
  assert.ok(html.includes('id="pane-brains"'), 'brains are configured in Settings, not a separate panel');
  for (const needle of ['setTeamMode', 'renderBrains', 'setBrainOverride', 'saveOrchestration']) {
    assert.ok(inline!.includes(needle), `team mode is missing: ${needle}`);
  }

  // Team mode is opt-in, so the toggle must start hidden and only appear once
  // the setting turns it on — otherwise "disabled" means nothing.
  assert.ok(html.includes('id="teamEnabledInput"'), 'Settings must carry the team-mode switch');
  assert.ok(inline!.includes('applyTeamAvailability(false)'), 'the team toggle must start hidden');
  const availability = grab('function applyTeamAvailability(on) {');
  assert.ok(/display\s*=\s*on\s*\?/.test(availability), 'the switch drives the toggle visibility');
  assert.ok(/setTeamMode\(false\)/.test(availability), 'disabling team mode must clear the armed flag');

  // Clicking a skill with an empty box sends straight away.
  let sent = fire('', api => api.executeSlashCmd('/ponytail-review'));
  assert.strictEqual(sent.length, 1, 'exactly one message is sent, never zero or two');
  assert.deepStrictEqual(sent[0].skills, ['ponytail-review']);
  assert.ok(sent[0].text.includes('ponytail-review'), 'a stand-in request is supplied');
  // A bare "run this skill" leaves a review skill with nothing to review, so the
  // stand-in has to point at where its input comes from and forbid asking.
  assert.ok(/uncommitted|open|project/i.test(sent[0].text), 'the stand-in names possible targets');
  assert.ok(/do not ask/i.test(sent[0].text), 'and tells it not to ask what to look at');

  // A skill that declares its own prompt uses that instead of the fallback.
  sent = fire('', api => api.executeSlashCmd('/declared'));
  assert.strictEqual(sent[0].text, 'Review the uncommitted diff.', 'a declared prompt wins');
  assert.deepStrictEqual(sent[0].skills, ['declared']);

  // Anything the user typed still beats the declared prompt.
  sent = fire('/declared look at auth.ts', api => api.executeSlashCmd('/declared'));
  assert.strictEqual(sent[0].text, 'look at auth.ts', 'an explicit request wins over both');

  // The half-typed filter must not survive into the message.
  sent = fire('/ponytail-rev', api => api.executeSlashCmd('/ponytail-review'));
  assert.strictEqual(sent.length, 1);
  assert.ok(!sent[0].text.includes('/ponytail-rev'), 'the typed prefix is stripped');

  // Text after the command becomes the request.
  sent = fire('/ponytail-review check auth', api => api.executeSlashCmd('/ponytail-review'));
  assert.deepStrictEqual(sent.map(s => s.text), ['check auth']);
  assert.deepStrictEqual(sent[0].skills, ['ponytail-review']);

  // Typed straight through with the menu closed.
  sent = fire('/ponytail-review check the auth module', api => api.sendMessage());
  assert.deepStrictEqual(sent.map(s => s.text), ['check the auth module']);

  // Several skills stack onto one message.
  sent = fire('/ponytail /ponytail-review tidy this', api => api.sendMessage());
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].skills, ['ponytail', 'ponytail-review']);
  assert.strictEqual(sent[0].text, 'tidy this');

  // Ordinary messages are untouched, and nothing fires on nothing.
  sent = fire('just fix the bug', api => api.sendMessage());
  assert.deepStrictEqual(sent.map(s => s.text), ['just fix the bug']);
  assert.deepStrictEqual(sent[0].skills, []);
  assert.strictEqual(fire('', api => api.sendMessage()).length, 0, 'an empty box sends nothing');
  assert.strictEqual(fire('/nosuchthing', api => api.sendMessage()).length, 0, 'an unknown command sends nothing');

  // ── tool cards read as plain English ─────────────────────────────
  // Every shipped tool needs a verb pair and a sensible subject, or the card
  // falls back to printing the raw function name at the user.
  const labelApi = new Function(
    inline!.slice(inline!.indexOf('const TOOL_VERBS'), inline!.indexOf('};', inline!.indexOf('const TOOL_VERBS')) + 2) + '\n' +
    inline!.slice(inline!.indexOf('const TOOL_SUBJECT'), inline!.indexOf('};', inline!.indexOf('const TOOL_SUBJECT')) + 2) + '\n' +
    "const DEFAULT_SUBJECT = ['path','file','target_file','filepath','target'];\n" +
    grab('function formatToolInfo(name, input, done) {') +
    '; return { formatToolInfo, TOOL_VERBS };'
  )();

  const label = (name: string, input: any, done: boolean) => {
    const i = labelApi.formatToolInfo(name, input, done);
    return (i.verb + (i.fileLabel ? ' ' + i.fileLabel : '')).trim();
  };

  for (const tool of ALL_TOOLS) {
    assert.ok(labelApi.TOOL_VERBS[tool.name], `tool "${tool.name}" has no plain-English label`);
  }
  // The labels themselves (not the keys) must be plain English — no codenames,
  // no raw snake_case function names leaking into the card.
  const verbText = JSON.stringify(Object.values(labelApi.TOOL_VERBS));
  assert.ok(!/_/.test(verbText), 'labels must not contain raw tool names: ' + verbText);
  assert.ok(!/\(|\)/.test(verbText), 'labels must not carry a parenthesised function name');

  // A path shows its last two segments — enough to identify, short enough to fit.
  assert.strictEqual(label('read_file', { path: 'D:/p/app/src/Header.tsx' }, true), 'Read src/Header.tsx');
  assert.strictEqual(label('delete_item', { path: 'app/src/app' }, false), 'Deleting src/app');
  assert.strictEqual(label('run_command', { command: 'npm run build' }, true), 'Ran command npm run build');
  assert.strictEqual(label('list_processes', {}, true), 'Listed processes');
  // A search is about its query, not a folder; a web call about its host.
  assert.strictEqual(label('find_files', { query: 'Header' }, true), 'Found files named Header');
  assert.strictEqual(label('web_search', { query: 'satisfies operator' }, false), 'Searching the web for satisfies operator');
  assert.strictEqual(label('read_page', { url: 'https://developer.mozilla.org/en-US/docs/Web/API/X' }, true),
    'Read page developer.mozilla.org');
  // An unknown tool degrades to something readable rather than throwing.
  assert.strictEqual(label('some_future_tool', {}, true), 'Used some future tool');

  // Only a real path is offered as a clickable jump link.
  assert.strictEqual(labelApi.formatToolInfo('read_file', { path: 'a/b.ts' }, true).isClickable, true);
  assert.strictEqual(labelApi.formatToolInfo('web_search', { query: 'x' }, true).isClickable, false);

  // ── an answered card must settle on the click itself ─────────────
  // Not on the extension's reply. Whatever goes wrong with that round-trip — a
  // lost message, a stale id, a race — the card must never sit there still
  // offering buttons after you have already answered it.
  function domEl(tag: string): any {
    const el: any = {
      tag, className: '', title: '', type: '', placeholder: '', value: '',
      children: [] as any[], style: {}, _text: '', _html: '', parentNode: null, _on: {},
      appendChild(c: any) { c.parentNode = el; el.children.push(c); return c; },
      replaceChild(next: any, old: any) {
        const i = el.children.indexOf(old);
        if (i >= 0) { el.children[i] = next; next.parentNode = el; old.parentNode = null; }
      },
      addEventListener(type: string, fn: any) { el._on[type] = fn; },
      click() { if (el._on.click) { el._on.click(); } },
      querySelector() { return domEl('span'); },
      querySelectorAll() { return [domEl('span'), domEl('span')]; },
    };
    Object.defineProperty(el, 'textContent', { get: () => el._text, set: (v: any) => { el._text = v; } });
    Object.defineProperty(el, 'innerHTML', { get: () => el._html, set: (v: any) => { el._html = v; } });
    return el;
  }

  const cardSent: any[] = [];
  const cardApi = new Function('document', 'SVG_ICONS', 'vscode',
    'const answeredApprovals = {};\n' + grab('function renderApproval(a) {') + '; return { renderApproval };'
  )({ createElement: domEl }, { check: '<ok/>' }, { postMessage: (m: any) => cardSent.push(m) });

  const shape = (card: any) => {
    const classes: string[] = [];
    (function walk(n: any) { classes.push(n.className); n.children.forEach(walk); })(card);
    return {
      buttons: classes.filter(c => c === 'approval-opt').length,
      verdict: classes.find(c => c && c.indexOf('approval-verdict ') === 0) || null,
    };
  };

  const pending = {
    id: 'ap-1', kind: 'edit', path: 'p', relPath: 'app/globals.css',
    added: 0, removed: 4, status: 'pending',
  };
  const holder = domEl('div');
  const liveCard = holder.appendChild(cardApi.renderApproval(pending));
  assert.deepStrictEqual(shape(liveCard), { buttons: 3, verdict: null }, 'a pending card offers three choices');

  const yesButton = liveCard.children.find((c: any) => c.className === 'approval-actions').children[0];
  yesButton.click();

  assert.deepStrictEqual(
    shape(holder.children[0]),
    { buttons: 0, verdict: 'approval-verdict applied' },
    'the card settles on the click, with no reply from the extension'
  );
  assert.strictEqual(cardSent.length, 1, 'exactly one response is sent');
  assert.strictEqual(cardSent[0].choice, 'apply');

  cardSent.length = 0;
  yesButton.click();
  assert.strictEqual(cardSent.length, 0, 'a second click on an answered card sends nothing');

  // A later full re-render of the thread must not resurrect the buttons: the
  // extension still reports this block as pending until its own update lands.
  assert.deepStrictEqual(
    shape(cardApi.renderApproval(pending)),
    { buttons: 0, verdict: 'approval-verdict applied' },
    're-rendering a stale pending block keeps the answer'
  );

  // A delete card has no diff and no stat — a different render path, and the
  // one actually reported as stuck.
  const delHolder = domEl('div');
  const delPending = {
    id: 'ap-2', kind: 'delete', path: 'p', relPath: 'app/src/app',
    added: 0, removed: 0, status: 'pending',
  };
  const delCard = delHolder.appendChild(cardApi.renderApproval(delPending));
  assert.deepStrictEqual(shape(delCard), { buttons: 3, verdict: null }, 'a delete card offers three choices');
  delCard.children.find((c: any) => c.className === 'approval-actions').children[0].click();
  assert.deepStrictEqual(
    shape(delHolder.children[0]),
    { buttons: 0, verdict: 'approval-verdict applied' },
    'a delete card settles on the click too'
  );

  // ── resolving must survive a divergent session graph ─────────────
  // The card block and the session being rendered can be different objects: a
  // session reloaded from storage is a fresh graph. Updating only one leaves the
  // card looking unanswered forever while the turn walks on — which is exactly
  // what "clicked Yes and the popup stays" looks like.
  const diverge = new InfinityCoderSidebarProvider(fakeContext());
  const seenPosts: any[] = [];
  (diverge as any)._view = { webview: { postMessage: (m: any) => seenPosts.push(m) } };
  (diverge as any).currentSession.messages.push({
    id: 'a1', role: 'assistant', content: '', createdAt: 0, streaming: true, blocks: [],
  });

  const waiting = (diverge as any).askApproval(
    { kind: 'delete', path: '/p/app', before: null, after: null }, 'a1');

  // Swap in a structurally identical copy, exactly as a reload would.
  (diverge as any).currentSession = JSON.parse(JSON.stringify((diverge as any).currentSession));

  (diverge as any).resolveApproval('ap-1', { approved: true });

  const lastPost = [...seenPosts].reverse().find(m => m.messages);
  const postedBlock = lastPost.messages
    .find((m: any) => m.id === 'a1').blocks.find((b: any) => b.type === 'approval');
  assert.strictEqual(postedBlock.approval.status, 'applied',
    'the status the webview receives is updated even when the session graph changed');
  assert.strictEqual((diverge as any).pendingApprovals.size, 0, 'the pending entry is released');
  // The tool call awaiting this card must be unblocked, or the turn hangs here
  // forever. Racing against a timer so a never-resolving promise fails loudly
  // instead of hanging the suite.
  const outcome = await Promise.race([
    waiting,
    new Promise(r => setTimeout(() => r({ approved: 'TIMED OUT' }), 500)),
  ]);
  assert.strictEqual((outcome as any).approved, true, 'the waiting tool call is unblocked');

  // ── stale live state after a reload ──────────────────────────────
  // The session is persisted mid-turn, so a restarted host reloads a message
  // still marked streaming, tool cards still spinning, and approval cards still
  // pending. The pending card is the damaging one: it renders as clickable but
  // nothing is waiting on it, so every click is silently dropped.
  const provider2 = new InfinityCoderSidebarProvider(fakeContext());
  (provider2 as any)._view = { webview: { postMessage() {} } };
  (provider2 as any).currentSession.messages.push({
    id: 'asst-1', role: 'assistant', content: '', createdAt: 0, streaming: true,
    blocks: [
      { type: 'tool', name: 'write_file', input: {}, done: false },
      { type: 'approval', approval: { id: 'ap-9', kind: 'write', path: 'p', relPath: 'p', added: 1, removed: 0, status: 'pending' } },
    ],
  });

  const revived = (provider2 as any).reviveSession((provider2 as any).currentSession);
  const message = revived.messages.find((m: any) => m.id === 'asst-1');
  assert.strictEqual(message.streaming, false, 'a reloaded turn is not still streaming');
  assert.strictEqual(message.blocks[0].done, true, 'an unfinished tool card stops spinning');
  assert.ok(message.blocks[0].result.includes('interrupted'), 'and says why it has no result');
  assert.strictEqual(message.blocks[1].approval.status, 'expired', 'a pending card cannot survive the turn');

  // Resolved cards must not be rewritten by the sweep.
  (provider2 as any).currentSession.messages.push({
    id: 'asst-2', role: 'assistant', content: '', createdAt: 0,
    blocks: [
      { type: 'approval', approval: { id: 'ap-10', kind: 'write', path: 'p', relPath: 'p', added: 1, removed: 0, status: 'applied' } },
      { type: 'approval', approval: { id: 'ap-11', kind: 'write', path: 'p', relPath: 'p', added: 1, removed: 0, status: 'rejected' } },
    ],
  });
  (provider2 as any).reviveSession((provider2 as any).currentSession);
  const second = (provider2 as any).currentSession.messages.find((m: any) => m.id === 'asst-2');
  assert.strictEqual(second.blocks[0].approval.status, 'applied', 'an applied card stays applied');
  assert.strictEqual(second.blocks[1].approval.status, 'rejected', 'a rejected card stays rejected');

  // Clicking a card nothing is waiting on must visibly deactivate it rather than
  // doing nothing — that silent no-op is what the bug looked like.
  const posted: any[] = [];
  (provider2 as any)._view = { webview: { postMessage: (m: any) => posted.push(m) } };
  (provider2 as any).currentSession.messages.push({
    id: 'asst-3', role: 'assistant', content: '', createdAt: 0,
    blocks: [{ type: 'approval', approval: { id: 'ap-12', kind: 'write', path: 'p', relPath: 'p', added: 1, removed: 0, status: 'pending' } }],
  });
  (provider2 as any).resolveApproval('ap-12', { approved: true });
  assert.ok(posted.length > 0, 'clicking a stale card still updates the UI');
  const third = (provider2 as any).currentSession.messages.find((m: any) => m.id === 'asst-3');
  assert.strictEqual(third.blocks[0].approval.status, 'expired', 'and the card stops looking clickable');

  console.log('webview self-check passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
