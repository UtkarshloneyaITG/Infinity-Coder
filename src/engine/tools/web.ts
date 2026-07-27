import * as dns from 'dns';
import { ToolSpec } from './common';

/**
 * Web tools: search the web, read a page, list a page's links.
 *
 * The SSRF guard matters here: http/https only, and every host — on the
 * initial request AND on each redirect hop — is resolved and rejected if it lands
 * on a loopback, private, link-local or reserved address. Without the per-hop
 * check a 302 could bounce a request onto localhost or a cloud metadata endpoint.
 *
 * ponytail: HTML is parsed with regex, not a DOM library, to keep the extension
 * dependency-free. Good enough to pull article text and links; if a real site
 * defeats it, the upgrade path is to add cheerio and swap out stripToText /
 * extractLinks — nothing else needs to change.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_BYTES = 5_000_000;
const MAX_REDIRECTS = 5;
const MAX_PAGE_CHARS = 12_000;
const MAX_LINKS = 80;

class WebError extends Error {}

function ipIsInternal(ip: string): boolean {
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const addr = v4Mapped ? v4Mapped[1] : ip;

  if (addr.includes('.')) {
    const parts = addr.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true; // unparseable — refuse rather than guess
    }
    const [a, b] = parts;
    return (
      a === 0 ||                          // unspecified
      a === 10 ||                         // private
      a === 127 ||                        // loopback
      (a === 169 && b === 254) ||         // link-local (incl. 169.254.169.254)
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) ||         // private
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      a >= 224                            // multicast + reserved
    );
  }

  const low = addr.toLowerCase();
  return (
    low === '::' || low === '::1' ||
    /^f[cd]/.test(low) ||                 // fc00::/7 unique-local
    /^fe[89ab]/.test(low) ||              // fe80::/10 link-local
    /^ff/.test(low)                       // ff00::/8 multicast
  );
}

async function assertPublicHost(host: string): Promise<void> {
  const low = host.toLowerCase();
  if (low === 'localhost' || low.endsWith('.local') || low.endsWith('.internal')) {
    throw new WebError("I won't fetch internal or private addresses.");
  }
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    return; // unresolvable — let the real request fail with its own error
  }
  if (addrs.some(a => ipIsInternal(a.address))) {
    throw new WebError("I won't fetch internal or private addresses.");
  }
}

async function validateUrl(url: string): Promise<URL> {
  const raw = (url || '').trim();
  if (!raw) {
    throw new WebError('No URL given.');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new WebError(`That doesn't look like a valid web address: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebError(`I can only open http/https links, not '${parsed.protocol}'.`);
  }
  await assertPublicHost(parsed.hostname);
  return parsed;
}

/**
 * Fetch a URL safely, returning [finalUrl, html]. Redirects are followed MANUALLY
 * so every hop is re-validated before we connect to it, and the body is capped.
 */
async function fetchHtml(url: string, timeoutSec = 15): Promise<[string, string]> {
  const timeout = Math.max(1, Math.min(timeoutSec || 15, 60));
  let current = await validateUrl(url);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    let res: Response;
    try {
      res = await fetch(current.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
    } catch (e: any) {
      clearTimeout(timer);
      const why = e?.name === 'AbortError' ? `timed out after ${timeout}s` : e?.message || 'unreachable';
      throw new WebError(`Couldn't reach ${current}: ${why}`);
    }
    clearTimeout(timer);

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) {
        throw new WebError(`${current} redirected without a target.`);
      }
      current = await validateUrl(new URL(loc, current).toString()); // re-check each hop
      continue;
    }
    if (res.status >= 400) {
      throw new WebError(`${current} returned HTTP ${res.status}.`);
    }

    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (ctype && !ctype.includes('html') && !ctype.includes('xml')) {
      throw new WebError(`That isn't a web page (content-type: ${ctype.split(';')[0].trim()}).`);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      throw new WebError(`${current} returned an empty response.`);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_BYTES) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      total += value.length;
    }
    await reader.cancel().catch(() => undefined);
    return [current.toString(), Buffer.concat(chunks).toString('utf8')];
  }

  throw new WebError(`Too many redirects starting from ${url}.`);
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", mdash: '—', ndash: '–',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    const lower = code.toLowerCase();
    if (ENTITIES[lower]) {
      return ENTITIES[lower];
    }
    if (lower.startsWith('#x')) {
      return String.fromCodePoint(parseInt(lower.slice(2), 16) || 0) || whole;
    }
    if (lower.startsWith('#')) {
      return String.fromCodePoint(parseInt(lower.slice(1), 10) || 0) || whole;
    }
    return whole;
  });
}

/**
 * Strip tags, decode entities, collapse whitespace. Inline tags become a space so
 * `a<br>b` doesn't fuse into `ab`, then the space is pulled back off punctuation
 * so `Second <b>para</b>.` reads `Second para.` and not `Second para .`.
 */
function tagsToText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?)\]}])/g, '$1')
    .replace(/([(\[{])\s+/g, '$1')
    .trim();
}

/**
 * Drop chrome elements, then pull out the readable blocks in document order.
 *
 * `pre` is deliberately included and fenced: the main reason to read a page is
 * to look up how an API is used, and the examples live in code blocks. Dropping
 * them returns the prose *about* the code with none of the code.
 */
function stripToText(html: string): string {
  const body = html.replace(
    /<(script|style|nav|header|footer|aside|form|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,
    ' '
  );
  const blocks: string[] = [];
  const seen = new Set<string>();
  const re = /<(pre|p|h1|h2|h3|h4|h5|h6|li|dt|dd|th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(body)) !== null) {
    let text: string;
    if (m[1].toLowerCase() === 'pre') {
      // Two competing needs. Syntax highlighting wraps every token in a span,
      // so inline tags must strip to NOTHING or the code comes back with gaps
      // between every identifier. But many docs sites put each source line in
      // its own div, so those have to become newlines — otherwise the whole
      // sample collapses onto one unreadable line.
      text = decodeEntities(
        m[2]
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(div|p|li|tr|h\d)>/gi, '\n')
          .replace(/<[^>]+>/g, '')
      )
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (text) {
        text = '```\n' + text + '\n```';
      }
    } else {
      text = tagsToText(m[2]);
    }
    // Nested blocks (a <p> inside a <dd>) match twice; keep the first only.
    if (text && !seen.has(text)) {
      seen.add(text);
      blocks.push(text);
    }
  }
  return blocks.join('\n\n');
}

function pageTitle(html: string): string {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return m ? tagsToText(m[1]) : '';
}

function parseLinks(html: string, baseUrl: string, sameDomain: boolean): Array<{ text: string; href: string }> {
  const baseHost = new URL(baseUrl).hostname.toLowerCase();
  const out: Array<{ text: string; href: string }> = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(html)) !== null) {
    const href = decodeEntities(m[1]).trim();
    const low = href.toLowerCase();
    if (!href || href.startsWith('#') || /^(mailto:|javascript:|tel:)/.test(low)) {
      continue;
    }
    let absolute: URL;
    try {
      absolute = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') {
      continue;
    }
    if (sameDomain && absolute.hostname.toLowerCase() !== baseHost) {
      continue;
    }
    const key = absolute.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const text = tagsToText(m[2]);
    out.push({ text, href: key });
  }
  return out;
}

const webSearch: ToolSpec = {
  name: 'web_search',
  group: 'web',
  description:
    'Search the live web and return the top results (title + snippet). Use this for ' +
    'current information, library documentation, error messages, or anything outside ' +
    'the project. To read one specific page in full, use read_page with its URL.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
      limit: { type: 'integer', description: 'Maximum results to return (default 5, max 10).' },
    },
    required: ['query'],
  },
  async run(args) {
    const query = String(args.query || '').trim();
    if (!query) {
      return 'What should I search for?';
    }
    let limit = parseInt(args.limit, 10);
    limit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 10)) : 5;

    let html: string;
    try {
      [, html] = await fetchHtml(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, 20);
    } catch (e: any) {
      return `Web search failed: ${e.message}`;
    }

    const results: string[] = [];
    const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null && results.length < limit) {
      const title = tagsToText(m[2]);
      // DDG wraps hits as /l/?uddg=<encoded target>; unwrap to the real URL.
      let href = decodeEntities(m[1]);
      const wrapped = href.match(/[?&]uddg=([^&]+)/);
      if (wrapped) {
        href = decodeURIComponent(wrapped[1]);
      } else if (href.startsWith('//')) {
        href = 'https:' + href;
      }
      if (title) {
        results.push(`- ${title}\n  ${href}`);
      }
    }

    if (results.length === 0) {
      return `No results found for '${query}'.`;
    }
    return [`Top ${results.length} result(s) for '${query}':`, ...results].join('\n');
  },
};

const readPage: ToolSpec = {
  name: 'read_page',
  group: 'web',
  description:
    'Read a web page and return its main text with the title. Use this to summarize, ' +
    'quote, or answer questions about a specific page when you have its URL — for ' +
    'example a documentation page found via web_search. To read a LOCAL file use ' +
    'read_file instead.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The full http/https URL of the page to read.' },
      timeout: { type: 'integer', description: 'Seconds to wait for the page (default 15, max 60).' },
    },
    required: ['url'],
  },
  async run(args) {
    if (!String(args.url || '').trim()) {
      return 'Which page should I read?';
    }
    let finalUrl: string;
    let html: string;
    try {
      [finalUrl, html] = await fetchHtml(args.url, args.timeout);
    } catch (e: any) {
      return e.message;
    }

    let text = stripToText(html);
    if (!text) {
      return `I fetched ${finalUrl} but couldn't extract readable text from it.`;
    }
    const words = text.split(/\s+/).length;
    const truncated = text.length > MAX_PAGE_CHARS;
    if (truncated) {
      text = text.slice(0, MAX_PAGE_CHARS);
    }

    const head = [pageTitle(html), finalUrl, `(${words} words)`].filter(Boolean).join('\n');
    return head + '\n\n' + text + (truncated ? '\n…(truncated — page is longer)' : '');
  },
};

const extractLinksTool: ToolSpec = {
  name: 'extract_links',
  group: 'web',
  description:
    'Fetch a web page and list its links — each link text and its full URL. Use this ' +
    'to see where a page can take you, or to pick the next page to read_page. Set ' +
    'same_domain=true to keep only links on the same website.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The full http/https URL of the page.' },
      same_domain: { type: 'boolean', description: 'Keep only links on the same website (default false).' },
    },
    required: ['url'],
  },
  async run(args) {
    if (!String(args.url || '').trim()) {
      return "Which page's links should I get?";
    }
    let finalUrl: string;
    let html: string;
    try {
      [finalUrl, html] = await fetchHtml(args.url);
    } catch (e: any) {
      return e.message;
    }

    const links = parseLinks(html, finalUrl, !!args.same_domain);
    if (links.length === 0) {
      return `No links found on ${finalUrl}.`;
    }
    const scope = args.same_domain ? ' (same-site)' : '';
    const lines = [`${links.length} link(s) on ${finalUrl}${scope}:`];
    for (const link of links.slice(0, MAX_LINKS)) {
      lines.push(`- ${link.text || '(no text)'} — ${link.href}`);
    }
    if (links.length > MAX_LINKS) {
      lines.push(`…(+${links.length - MAX_LINKS} more)`);
    }
    return lines.join('\n');
  },
};

export const WEB_TOOLS: ToolSpec[] = [webSearch, readPage, extractLinksTool];

// Exported for the self-check.
export const _internal = { ipIsInternal, decodeEntities, stripToText, parseLinks, validateUrl };
