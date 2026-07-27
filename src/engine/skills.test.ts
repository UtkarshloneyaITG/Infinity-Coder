/**
 * Self-check for skills. Run with:
 *   npm run compile && node out/engine/skills.test.js
 *
 * The scoring is the risky part: nothing else guards it, and both failure modes
 * are bad. Missing a match silently drops guidance the user configured; a false
 * match silently spends thousands of tokens and changes how the agent behaves.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseFrontmatter,
  discoverSkills,
  scoreSkill,
  selectSkills,
  loadSkillBodies,
  expandHome,
  SkillMeta,
  AUTO_SCORE_THRESHOLD,
  MAX_AUTO_SKILLS,
} from './skills';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));

function writeSkill(name: string, frontmatter: string, body: string, dir = tmp) {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`);
  return path.join(folder, 'SKILL.md');
}

const meta = (name: string, description: string, prompt = ''): SkillMeta =>
  ({ name, description, file: '', bytes: 0, tokens: 0, prompt });

function main() {
  // ── frontmatter ──────────────────────────────────────────────────
  const quoted = parseFrontmatter('---\nname: ponytail\ndescription: "Lazy: mode, for code"\n---\nBODY HERE');
  assert.strictEqual(quoted.data.name, 'ponytail');
  assert.strictEqual(quoted.data.description, 'Lazy: mode, for code', 'quotes stripped, colons kept');
  assert.strictEqual(quoted.body, 'BODY HERE');

  const bare = parseFrontmatter('---\nname: x\ndescription: no quotes here\n---\nbody');
  assert.strictEqual(bare.data.description, 'no quotes here');

  // Folded scalars appear in real skill files and must not yield an empty
  // description — that would make the skill unmatchable forever.
  const folded = parseFrontmatter('---\nname: x\ndescription: >-\n  first part\n  second part\nlicense: MIT\n---\nbody');
  assert.strictEqual(folded.data.description, 'first part second part', 'folded scalar is joined');
  assert.strictEqual(folded.data.license, 'MIT', 'parsing resumes after a folded block');

  const none = parseFrontmatter('just a plain file\nwith no frontmatter');
  assert.deepStrictEqual(none.data, {}, 'no frontmatter is not an error');
  assert.ok(none.body.startsWith('just a plain'), 'the whole file is the body');

  assert.ok(expandHome('~/x').startsWith(os.homedir()), '~ expands');
  assert.strictEqual(expandHome('/abs/x'), '/abs/x', 'absolute paths are untouched');

  // ── discovery ────────────────────────────────────────────────────
  writeSkill('ponytail', 'name: ponytail\ndescription: "Lazy senior dev mode for any coding task: YAGNI, stdlib first."', 'BE LAZY');
  writeSkill('threejs-shaders', 'name: threejs-shaders\ndescription: Three.js shaders - GLSL, ShaderMaterial, uniforms. Use when writing fragment shaders.', 'SHADER DOCS');
  writeSkill('threejs-lighting', 'name: threejs-lighting\ndescription: Three.js lighting - light types, shadows, environment lighting.', 'LIGHT DOCS');
  // No name in frontmatter: the folder name is the convention.
  writeSkill('folder-named', 'description: Something useful', 'BODY');
  // Nested, the way plugin caches store them.
  writeSkill('deep', 'name: deep\ndescription: nested skill', 'DEEP', path.join(tmp, 'plugins', 'a', '1.0', 'skills'));

  // A skill can declare what /<skill> means when invoked with nothing after it.
  writeSkill('with-prompt', 'name: with-prompt\ndescription: has a default request\nprompt: Review the uncommitted diff.', 'BODY');

  const found = discoverSkills([tmp, path.join(tmp, 'does-not-exist')]);
  const declared = found.find(s => s.name === 'with-prompt');
  assert.strictEqual(declared!.prompt, 'Review the uncommitted diff.', 'the declared prompt is read');
  assert.strictEqual(found.find(s => s.name === 'ponytail')!.prompt, '', 'absent prompt is empty, never undefined');
  const names = found.map(s => s.name);
  assert.ok(names.includes('ponytail'), 'finds a top-level skill');
  assert.ok(names.includes('deep'), 'finds a deeply nested skill');
  assert.ok(names.includes('folder-named'), 'falls back to the folder name');
  assert.ok(found.every(s => s.tokens > 0), 'every skill has a token estimate');
  assert.deepStrictEqual(names, [...names].sort(), 'listing is stable/sorted');

  // A missing root must not throw — users edit these paths by hand.
  assert.deepStrictEqual(discoverSkills(['/definitely/not/here']), []);

  // ── scoring ──────────────────────────────────────────────────────
  const shaders = meta('threejs-shaders', 'Three.js shaders - GLSL, ShaderMaterial, uniforms, custom effects.');
  const lighting = meta('threejs-lighting', 'Three.js lighting - light types, shadows, environment lighting.');
  const pony = meta('ponytail', 'Lazy senior dev mode for any coding task: YAGNI, stdlib first, no unrequested abstractions.');

  // "three.js" tokenizes to three + js and would never match the name
  // "threejs" without the compact-form comparison.
  assert.ok(
    scoreSkill('write a fragment shader for my three.js scene', shaders) >= AUTO_SCORE_THRESHOLD,
    'a dotted product name still matches the squashed skill name'
  );
  assert.ok(
    scoreSkill('add a fragment shader', shaders) >= AUTO_SCORE_THRESHOLD,
    'a name term alone is enough'
  );
  assert.ok(
    scoreSkill('write a fragment shader for my three.js scene', shaders) >
    scoreSkill('write a fragment shader for my three.js scene', lighting),
    'the more specific sibling scores higher'
  );

  // False positives are the expensive failure: each one silently spends
  // thousands of tokens and changes behaviour.
  assert.ok(scoreSkill('fix the CSS on my login page', shaders) < AUTO_SCORE_THRESHOLD, 'unrelated work does not match');
  assert.ok(scoreSkill('rename this variable', pony) < AUTO_SCORE_THRESHOLD, 'a generic request does not pull in ponytail');
  assert.ok(scoreSkill('', shaders) < AUTO_SCORE_THRESHOLD, 'an empty message matches nothing');

  // Descriptions are phrased "Use when the user asks to…", so that boilerplate
  // must not make every skill match every message.
  const boiler = meta('some-skill', 'Use this when the user asks you to do the thing they want.');
  assert.ok(scoreSkill('can you do the thing I want you to do', boiler) < AUTO_SCORE_THRESHOLD,
    'stopword-only overlap is not a match');

  // Explicit triggers, for skills whose name says nothing useful.
  const vague = meta('house-rules', 'Internal conventions.');
  assert.ok(scoreSkill('update the invoice component', vague) < AUTO_SCORE_THRESHOLD, 'no match without triggers');
  assert.ok(scoreSkill('update the invoice component', vague, 'invoice, billing') >= AUTO_SCORE_THRESHOLD,
    'declared triggers match');

  // ── selection ────────────────────────────────────────────────────
  const all = [shaders, lighting, pony];

  const always = selectSkills('anything at all', all, { ponytail: 'always' });
  assert.strictEqual(always.length, 1, 'an always skill applies regardless of the message');
  assert.strictEqual(always[0].meta.name, 'ponytail');
  assert.strictEqual(always[0].reason, 'always');

  const off = selectSkills('write a fragment shader in three.js', all, { 'threejs-shaders': 'off' });
  assert.ok(!off.some(s => s.meta.name === 'threejs-shaders'), 'an off skill never loads, however well it matches');

  const auto = selectSkills('write a fragment shader in three.js', all, {});
  assert.ok(auto.some(s => s.meta.name === 'threejs-shaders'), 'the matching skill loads');
  assert.ok(auto.length <= MAX_AUTO_SKILLS, `at most ${MAX_AUTO_SKILLS} auto skills`);
  assert.ok(auto.every(s => s.reason === 'auto'));

  // A clear winner must not drag its weaker siblings in — that is how a single
  // question ends up costing four reference skills.
  assert.ok(
    !auto.some(s => s.meta.name === 'threejs-lighting'),
    'a runner-up well below the best score is dropped'
  );

  // Removing the best match from the running — by switching it off, or by
  // pinning it with a command — must NOT promote its weaker siblings. The cutoff
  // is measured against what the message is about, not against who is eligible.
  const bestOff = selectSkills('write a fragment shader in three.js', all, { 'threejs-shaders': 'off' });
  assert.deepStrictEqual(
    bestOff.map(s => s.meta.name), [],
    'switching off the best match loads nothing rather than the runner-up'
  );

  const bestForced = selectSkills('write a fragment shader in three.js', all, {}, { forced: ['threejs-shaders'] });
  assert.deepStrictEqual(
    bestForced.map(s => s.meta.name), ['threejs-shaders'],
    'pinning the best match does not free a slot for the runner-up'
  );

  const both = selectSkills('write a fragment shader in three.js', all, { ponytail: 'always' });
  assert.ok(both.some(s => s.reason === 'always') && both.some(s => s.reason === 'auto'),
    'always and auto combine');

  assert.deepStrictEqual(selectSkills('fix a typo in the readme', all, {}), [],
    'an ordinary message loads nothing at all');

  // Default mode is auto: an unconfigured skill is available but not forced.
  const unconfigured = selectSkills('write a fragment shader in three.js', all, {});
  assert.ok(unconfigured.length > 0, 'skills work before anything is configured');

  // ── /<skill> commands override the configured mode ───────────────
  // Typing the name is an explicit request; silently ignoring it because the
  // skill happens to be switched off would be baffling.
  const commanded = selectSkills('fix a typo', all, { ponytail: 'off' }, { forced: ['ponytail'] });
  assert.strictEqual(commanded.length, 1, 'a command beats mode=off');
  assert.strictEqual(commanded[0].reason, 'command');

  const commandedNoMatch = selectSkills('fix a typo', all, {}, { forced: ['threejs-shaders'] });
  assert.strictEqual(commandedNoMatch.length, 1, 'a command beats a zero score');
  assert.strictEqual(commandedNoMatch[0].meta.name, 'threejs-shaders');

  // A commanded skill must not also be counted as always/auto.
  const noDupes = selectSkills('write a fragment shader in three.js', all,
    { ponytail: 'always', 'threejs-shaders': 'auto' },
    { forced: ['ponytail', 'threejs-shaders'] });
  assert.strictEqual(noDupes.length, 2, 'no duplicates when a skill qualifies twice');
  assert.ok(noDupes.every(s => s.reason === 'command'), 'the command reason wins');
  assert.strictEqual(new Set(noDupes.map(s => s.meta.name)).size, 2);

  // An unknown name is ignored rather than throwing.
  assert.deepStrictEqual(selectSkills('hi', all, {}, { forced: ['nope'] }), []);

  // Commands do not consume the auto budget: a forced skill plus its own auto
  // matches should still cap the auto side.
  const mixed = selectSkills('write a fragment shader in three.js', all, {}, { forced: ['ponytail'] });
  assert.ok(mixed.some(s => s.reason === 'command' && s.meta.name === 'ponytail'));
  assert.ok(mixed.filter(s => s.reason === 'auto').length <= MAX_AUTO_SKILLS);

  // ── loading bodies ───────────────────────────────────────────────
  const ponyFile = path.join(tmp, 'ponytail', 'SKILL.md');
  const loaded = loadSkillBodies([{ meta: { ...pony, file: ponyFile }, reason: 'always' }]);
  assert.strictEqual(loaded.length, 1);
  assert.strictEqual(loaded[0].body, 'BE LAZY', 'the body excludes the frontmatter');
  assert.strictEqual(loaded[0].reason, 'always');

  // An unreadable skill is skipped, never fatal to the turn.
  const broken = loadSkillBodies([{ meta: { ...pony, file: path.join(tmp, 'gone', 'SKILL.md') }, reason: 'auto' }]);
  assert.deepStrictEqual(broken, [], 'a missing file is skipped silently');

  // Oversized skills are capped so one file cannot own the context window.
  writeSkill('huge', 'name: huge\ndescription: big', 'x'.repeat(60_000));
  const hugeLoaded = loadSkillBodies([
    { meta: { ...meta('huge', 'big'), file: path.join(tmp, 'huge', 'SKILL.md') }, reason: 'always' },
  ]);
  assert.ok(hugeLoaded[0].body.length < 21_000, 'an oversized skill is truncated');
  assert.ok(hugeLoaded[0].body.includes('truncated'), 'and says so');

  console.log('skills self-check passed');
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
