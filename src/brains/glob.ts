/**
 * A minimal glob matcher for context and path-scope rules.
 *
 * ponytail: no dependency. It supports the three things the rules actually use —
 * `**`, `*`, `?` — plus `{a,b}` alternation, and nothing else. Reach for
 * minimatch only if a brain pack in the wild needs extglob or negation, which
 * would be a real dependency for a feature nobody has asked for yet.
 */

const cache = new Map<string, RegExp>();

function compile(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) {
    return cached;
  }

  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` also has to match zero directories, so `src/**/*.ts` matches
        // `src/a.ts` — otherwise every rule would need a second pattern.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0) {
        out += '\\{';
      } else {
        const parts = pattern.slice(i + 1, end).split(',');
        out += '(?:' + parts.map(p => p.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = end;
      }
    } else if ('.+^$()|[]\\'.includes(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }

  // Case-insensitive: Windows paths are, and a rule that works on macOS but not
  // on the user's Windows box is the worst kind of bug to diagnose.
  const re = new RegExp(`^${out}$`, 'i');
  cache.set(pattern, re);
  return re;
}

/** `relPath` must be workspace-relative and slash-separated. */
export function matchGlob(relPath: string, pattern: string): boolean {
  return compile(pattern).test(relPath.replace(/\\/g, '/'));
}

export function matchAny(relPath: string, patterns: string[]): boolean {
  return patterns.some(p => matchGlob(relPath, p));
}

/** Slash-separated, root-relative, no leading `./`. The form every rule expects. */
export function toRelative(root: string, absolute: string): string {
  const a = absolute.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (r && a.toLowerCase().startsWith(r.toLowerCase() + '/')) {
    return a.slice(r.length + 1);
  }
  return a;
}
