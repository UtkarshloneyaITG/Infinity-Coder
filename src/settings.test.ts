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

  // A settings blob from an older version, missing the groq provider and the
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
