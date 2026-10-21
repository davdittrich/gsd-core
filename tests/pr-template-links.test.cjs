// Regression for #5427: PR bodies render relative hrefs verbatim, so they
// resolve against /pull/N and 404. Only `?template=` links may be relative.
// Scope: inline `[t](url "title")`, `href="url"` and reference-definition `[t]: url` links;
// autolinks are absolute by construction, and a URL containing `)` is not supported.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const GH = path.join(ROOT, '.github');
const DIR = path.join(GH, 'PULL_REQUEST_TEMPLATE');
const LINKS = [
  /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
  /href=["']([^"']+)["']/gi,
  /^[ \t]*\[[^\]]+\]:[ \t]*<?(\S+?)>?(?:[ \t]+["(].*)?$/gm,
];
const REPO = 'https://github.com/open-gsd/gsd-core/';
const DOCS_ANCHOR = 'CONTRIBUTING.md#documentation-updates--update-the-relevant-docs';
const ANCHOR = /CONTRIBUTING\.md#(.+)$/;
const slug = (h) => h.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\s-]/gu, '').replace(/\s/g, '-');
const hrefsOf = (f) => {
  const text = fs.readFileSync(path.join(GH, f), 'utf8');
  return LINKS.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]));
};

// Not reusing markdown-sectionizer tokenizeHeadings (ATX only, no setext) or gen-adr-index extractLinks
// (inline links only, no href=/reference defs): both would drop cases this guard must cover.
// Mirrors github-slugger: repeats take the first free `-N` suffix (collision loop).
const headingSet = (lines) => {
  const headings = new Set();
  const seen = new Map();
  let fence = null; // { ch, len } of the open code fence
  const add = (text) => {
    const s = slug(text);
    let c = s;
    let n = seen.get(s) ?? 0;
    while (headings.has(c)) c = `${s}-${++n}`;
    seen.set(s, n);
    headings.add(c);
  };
  lines.forEach((l, i) => {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (fence) {
      // closes on the same char, at least as long, with no info string
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && !f[2].trim()) fence = null;
      return;
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) { fence = { ch: f[1][0], len: f[1].length }; return; }
    const atx = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(l);
    if (atx) { add(atx[1]); return; }
    // setext: a paragraph line followed by === or ---
    // only a single, non-list paragraph line (blank or start above) counts
    const single = !(lines[i - 1] ?? '').trim();
    if (single && /^ {0,3}(=+|-+)[ \t]*$/.test(lines[i + 1] ?? '') && /^ {0,3}(?![>#`~*+=-]|\d+[.)]\s)\S/.test(l)) add(l.trim());
  });
  return headings;
};

describe('heading anchors (#5427)', () => {
  test('repeats and collisions follow github-slugger', () => {
    assert.deepEqual([...headingSet(['# Foo', '# Foo 1', '# Foo'])], ['foo', 'foo-1', 'foo-2']);
  });
  test('skips fenced code, honouring fence char and length', () => {
    assert.deepEqual([...headingSet(['````', '# A', '```', '# B', '````', '~~~', '# C', '~~~', '# D'])], ['d']);
  });
  test('reads setext headings and indented ATX', () => {
    assert.deepEqual([...headingSet(['Title', '=====', '', 'Sub', '---', '  ## Indented'])], ['title', 'sub', 'indented']);
  });
  test('setext: list items and multi-line paragraphs are not headings', () => {
    assert.deepEqual([...headingSet(['- item', '---', '', 'line one', 'line two', '---', '1. x', '---'])], []);
  });
  test('properties: headingSet has one slug per heading; slug is idempotent', () => {
    fc.assert(fc.property(fc.array(fc.stringMatching(/^[a-z0-9]{1,3}$/), { maxLength: 12 }), (hs) => {
      assert.equal(headingSet(hs.map((h) => `# ${h}`)).size, hs.length);
    }));
    fc.assert(fc.property(fc.string(), (h) => {
      assert.equal(slug(slug(h)), slug(h));
    }));
  });
  test('keeps underscores like GitHub', () => {
    assert.ok(headingSet(['## Set `commit_docs` true']).has('set-commit_docs-true'));
  });
});

describe('PR template links (#5427)', () => {
  const headings = headingSet(fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8').split(/\r?\n/));
  const files = ['pull_request_template.md', ...fs.readdirSync(DIR).filter((n) => n.endsWith('.md')).map((n) => `PULL_REQUEST_TEMPLATE/${n}`)];
  for (const f of files) {
    test(`${f}: only ?template= links are relative`, () => {
      const bad = hrefsOf(f).filter((h) => !h.startsWith('?template=') && !(h.startsWith(`${REPO}blob/next/`) || h === `${REPO}discussions`));
      assert.deepEqual(bad, []);
    });
    test(`${f}: blob/next links point at existing repo paths`, () => {
      const missing = hrefsOf(f)
        .filter((h) => h.startsWith(`${REPO}blob/next/`))
        .map((h) => h.slice(`${REPO}blob/next/`.length).split(/[?#]/)[0]) // drop ?plain=1 / #anchor
        .filter((rel) => rel.split('/').includes('..') || !fs.existsSync(path.join(ROOT, rel)));
      assert.deepEqual(missing, []);
    });
    test(`${f}: CONTRIBUTING.md anchors resolve to a heading`, () => {
      for (const a of hrefsOf(f).map((h) => ANCHOR.exec(h)?.[1]).filter(Boolean)) {
        assert.ok(headings.has(a), a);
      }
    });
  }
  for (const f of ['PULL_REQUEST_TEMPLATE/feature.md', 'PULL_REQUEST_TEMPLATE/enhancement.md']) {
    test(`${f}: links the Documentation Updates anchor`, () => {
      assert.ok(hrefsOf(f).some((h) => h.endsWith(DOCS_ANCHOR)), DOCS_ANCHOR);
    });
  }
});
