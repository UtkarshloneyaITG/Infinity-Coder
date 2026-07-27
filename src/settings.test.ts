/**
 * Self-check for the settings store. No framework — run it with:
 *   npm run compile && node out/settings.test.js
 *
 * Covers the bits that are easy to get subtly wrong: reorder bounds, the
 * defaults merge for settings saved by an older version, and the invariant
 * that raw key material never lands in globalState.
 */
import * as assert from 'assert';
import { SettingsStore, move } from './settings';
import { MODELS, NVIDIA_MODELS, get as catalogGet, fallbackChain, availableModels } from './catalog';

/** Minimal stand-in for ExtensionContext: in-memory globalState + secrets. */
function fakeContext() {
  const state = new Map<string, any>();
  const secrets = new Map<string, string>();
  return {
    globalState: {
      get: (k: string, d?: any) => (state.has(k) ? state.get(k) : d),
      update: async (k: string, v: any) => { state.set(k, v); },
    },
    secrets: {
      get: async (k: string) => secrets.get(k),
      store: async (k: string, v: string) => { secrets.set(k, v); },
      delete: async (k: string) => { secrets.delete(k); },
    },
    _state: state,
    _secrets: secrets,
  } as any;
}

async function main() {
  // ── move() bounds ────────────────────────────────────────────────
  const list = ['a', 'b', 'c'];
  move(list, 0, 1);
  assert.deepStrictEqual(list, ['b', 'a', 'c'], 'move down');
  move(list, 2, -1);
  assert.deepStrictEqual(list, ['b', 'c', 'a'], 'move up');
  move(list, 0, -1);
  assert.deepStrictEqual(list, ['b', 'c', 'a'], 'move past the start is a no-op');
  move(list, 2, 1);
  assert.deepStrictEqual(list, ['b', 'c', 'a'], 'move past the end is a no-op');
  move(list, -1, 1);
  assert.deepStrictEqual(list, ['b', 'c', 'a'], 'unknown item (index -1) is a no-op');

  // ── defaults ─────────────────────────────────────────────────────
  const ctx = fakeContext();
  const store = new SettingsStore(ctx);
  const fresh = store.get();
  assert.strictEqual(fresh.providers.length, 2, 'nvidia + groq by default');
  assert.strictEqual(fresh.providers[0].id, 'nvidia');
  assert.strictEqual(fresh.toolGroups.web, true);

  // A settings blob from an older version, missing a default provider and the
  // web tool group, must gain both instead of losing what it does have.
  await store.save({
    ...fresh,
    providers: [{ id: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'http://custom', enabled: false, keys: [] }],
    toolGroups: { files: false } as any,
  });
  const merged = store.get();
  assert.strictEqual(merged.providers.length, 2, 'missing default provider is restored');
  assert.strictEqual(merged.providers[0].baseUrl, 'http://custom', 'saved value wins over default');
  assert.strictEqual(merged.providers[0].enabled, false, 'saved value wins over default');
  assert.strictEqual(merged.toolGroups.files, false, 'saved group wins');
  assert.strictEqual(merged.toolGroups.web, true, 'missing group falls back to default');

  // ── the shipped defaults must be models that exist ───────────────
  // Both defaults were once ids NIM does not serve, so a fresh install failed
  // on its very first message with a provider error.
  assert.ok(catalogGet(fresh.activeModel), `default activeModel ${fresh.activeModel} is not in the catalog`);
  assert.ok(catalogGet(fresh.boostModel), `default boostModel ${fresh.boostModel} is not in the catalog`);
  assert.ok(catalogGet(fresh.activeModel)!.tools, 'the default model must support tool calls');

  // Failover targets too — a chain that retries onto a nonexistent model turns
  // one recoverable failure into a second, more confusing one.
  for (const target of fallbackChain('nvidia/nemotron-3-ultra-550b-a55b')) {
    assert.ok(catalogGet(target), `failover target ${target} is not in the catalog`);
  }
  // NIM namespaces everything as publisher/model. Groq does not — `llama-3.3-70b-
  // versatile` is a real Groq id — so the convention is only asserted where it holds.
  for (const model of NVIDIA_MODELS) {
    assert.ok(/^[\w.-]+\/[\w.-]+$/.test(model.id), `${model.id} is not a publisher/model id`);
    assert.strictEqual(model.providerId, 'nvidia', `${model.id} is tagged for the wrong provider`);
  }
  for (const model of MODELS) {
    assert.ok(model.id.trim() === model.id && !/\s/.test(model.id), `${model.id} has stray whitespace`);
    assert.ok(model.providerId, `${model.id} has no providerId`);
  }
  // Ids served by two providers are the reason providerId exists at all.
  const shared = MODELS.filter(m => m.id === 'openai/gpt-oss-120b');
  assert.strictEqual(shared.length, 2, 'gpt-oss-120b is served by both NVIDIA and Groq');
  assert.deepStrictEqual(shared.map(m => m.providerId).sort(), ['groq', 'nvidia']);

  // ── only reachable models are offered ────────────────────────────
  // A dropdown listing models the user has no key for produces entries that all
  // fail on send with a credentials error, with no way to tell which is which.
  const nvidia = { id: 'nvidia', name: 'NVIDIA NIM', enabled: true, keys: [{ id: 'k1' }] };
  const groq = { id: 'groq', name: 'Groq', enabled: true, keys: [{ id: 'k2' }] };
  const groqModels = { groq: ['llama-3.3-70b-versatile', 'openai/gpt-oss-20b'] };

  const bothKeyed = availableModels([nvidia, groq], groqModels);
  assert.ok(bothKeyed.some(m => m.providerId === 'nvidia'), 'NVIDIA models show with an NVIDIA key');
  assert.ok(bothKeyed.some(m => m.id === 'llama-3.3-70b-versatile'), 'Groq models show with a Groq key');

  // No Groq key: every Groq model disappears, NVIDIA is untouched.
  const noGroqKey = availableModels([nvidia, { ...groq, keys: [] }], groqModels);
  assert.ok(!noGroqKey.some(m => m.providerId === 'groq'), 'no Groq key means no Groq models');
  assert.ok(noGroqKey.some(m => m.providerId === 'nvidia'), 'and NVIDIA is unaffected');

  // No NVIDIA key: the hardcoded catalog goes too. It is NIM-hosted, so without
  // that key none of it is reachable however static the list looks.
  const noNvidiaKey = availableModels([{ ...nvidia, keys: [] }, groq], groqModels);
  assert.ok(!noNvidiaKey.some(m => m.providerId === 'nvidia'), 'no NVIDIA key means no catalog models');
  assert.ok(noNvidiaKey.length > 0, 'the Groq models remain');
  assert.ok(noNvidiaKey.every(m => m.providerId === 'groq'), 'and nothing else does');
  // The overlap is the interesting case: gpt-oss-120b is in both catalogs, so
  // it must still be offered here — via Groq, not as a leaked NVIDIA entry.
  assert.ok(noNvidiaKey.some(m => m.id === 'openai/gpt-oss-120b'), 'a shared id survives via Groq');

  // ── hiding ───────────────────────────────────────────────────────
  // Hidden models stay in the returned list, flagged. Settings is the only place
  // they can be unhidden from, so filtering them out here would strand them.
  const hiddenRun = availableModels([nvidia, groq], groqModels, [], ['meta/llama-3.1-8b-instruct']);
  const hiddenRow = hiddenRun.find(m => m.id === 'meta/llama-3.1-8b-instruct');
  assert.ok(hiddenRow, 'a hidden model is still returned');
  assert.strictEqual(hiddenRow!.hidden, true, 'and is flagged so a picker can drop it');
  assert.ok(
    hiddenRun.filter(m => !m.hidden).every(m => m.id !== 'meta/llama-3.1-8b-instruct'),
    'filtering on the flag removes it from a picker',
  );
  assert.ok(
    availableModels([nvidia, groq], groqModels, [], []).every(m => !m.hidden),
    'nothing is hidden by default',
  );

  assert.deepStrictEqual(availableModels([], {}), [], 'no providers, no models');

  // A hand-added model is offered even with no provider keyed: the user typed it
  // deliberately, and it may be newer than any list shipped here.
  const withCustom = availableModels([], {}, ['some-brand-new-model']);
  assert.strictEqual(withCustom.length, 1, 'an added model survives with no keys');
  assert.strictEqual(withCustom[0].providerId, 'custom', 'and is labelled as added');
  assert.strictEqual(
    availableModels([nvidia], {}, ['meta/llama-3.1-8b-instruct'])
      .filter(m => m.id === 'meta/llama-3.1-8b-instruct').length, 1,
    'adding a model already in the catalog does not duplicate the row',
  );
  assert.deepStrictEqual(
    availableModels([{ ...nvidia, enabled: false }], {}), [],
    'a disabled provider contributes nothing even with a key',
  );

  // ── semantic indexing is off until asked for ─────────────────────
  // It spends the user's embedding quota. Shipping it on by default would make
  // that decision for them the moment they install the extension.
  assert.strictEqual(fresh.semantic.enabled, false, 'indexing is off by default');

  // A settings blob predating the semantic block must gain it, not carry
  // undefined into code that reads .semantic.enabled.
  await store.save({ ...fresh, semantic: undefined as any });
  assert.strictEqual(store.get().semantic.enabled, false, 'a missing block falls back to the default');
  assert.strictEqual(store.get().semantic.model.length > 0, true, 'and to a usable model id');

  // ── keys ─────────────────────────────────────────────────────────
  await store.addKey('nvidia', 'nvapi-secret-PRIMARY1');
  await store.addKey('nvidia', 'nvapi-secret-FALLBACK2');
  const withKeys = store.get();
  assert.strictEqual(withKeys.providers[0].keys.length, 2);
  assert.strictEqual(withKeys.providers[0].keys[0].last4, 'ARY1', 'only last 4 are stored');
  assert.deepStrictEqual(
    await store.keysFor('nvidia'),
    ['nvapi-secret-PRIMARY1', 'nvapi-secret-FALLBACK2'],
    'keys come back in fallback order'
  );

  // The whole point of SecretStorage: no raw key anywhere in globalState.
  const persisted = JSON.stringify([...ctx._state.values()]);
  assert.ok(!persisted.includes('nvapi-secret'), 'raw key must never reach globalState');

  // Reorder promotes the fallback to primary.
  const keyId = store.get().providers[0].keys[1].id;
  await store.moveKey('nvidia', keyId, -1);
  assert.deepStrictEqual(
    await store.keysFor('nvidia'),
    ['nvapi-secret-FALLBACK2', 'nvapi-secret-PRIMARY1'],
    'moveKey reorders the failover chain'
  );

  // Deleting a key must also purge the secret, not just the metadata row.
  await store.removeKey('nvidia', keyId);
  assert.strictEqual(store.get().providers[0].keys.length, 1);
  assert.strictEqual(await store.getKey(keyId), undefined, 'secret is purged on delete');

  // Removing a provider purges every key it owned.
  await store.addProvider('Together', 'https://api.together.xyz/v1');
  const customId = store.get().providers.find(p => p.id.startsWith('custom-'))!.id;
  await store.addKey(customId, 'together-secret-XYZ');
  await store.removeProvider(customId);
  assert.strictEqual(ctx._secrets.size, 1, 'removing a provider purges its secrets');

  console.log('settings self-check passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
