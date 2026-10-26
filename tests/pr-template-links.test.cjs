// Regression for #5427: PR bodies render relative hrefs verbatim, so they
// resolve against /pull/N and 404. Every link must be absolute, except `?template=` links, which GitHub
// resolves against the compare page and which the issue's brief keeps out of scope.
// Scope: inline `[t](url "title")`, `href="url"` and reference-definition `[t]: url` links;
// autolinks are absolute by construction, and a URL containing `)` is not supported.
const { describe, test } = require('node:test');
const fc = require('./helpers/fast-check-setup.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { slugify } = require('../scripts/gen-features.cjs');

const ROOT = path.join(__dirname, '..');
const GH = path.join(ROOT, '.github');
const DIR = path.join(GH, 'PULL_REQUEST_TEMPLATE');
const LINKS = [
  // angle-enclosed destinations (group 1) may contain spaces; bare ones are group 2
  /\]\(\s*(?:<([^>\n]*)>|([^)\s>]+))(?:\s+"[^"]*")?\s*\)/g,
  /href=["']([^"']+)["']/gi,
  /^[ \t]*\[[^\]]+\]:[ \t]*(?:<([^>\n]*)>|(\S+?))(?:[ \t]+["(].*)?$/gm,
];
const REPO = 'https://github.com/open-gsd/gsd-core/';
const DOCS_ANCHOR = 'CONTRIBUTING.md#documentation-updates--update-the-relevant-docs';
const ANCHOR = /CONTRIBUTING\.md#(.+)$/;
const hrefsIn = (text) => LINKS.flatMap((re) => [...text.matchAll(re)].map((m) => m[1] ?? m[2]));
const hrefsOf = (f) => hrefsIn(fs.readFileSync(path.join(GH, f), 'utf8'));
const isRelativeLink = (h) => !/^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith('?template=');

// Only the one CONTRIBUTING.md anchor is checked, so ATX headings suffice (no setext, fences or
// repeated-slug suffixes); markdown-sectionizer/gen-adr-index would drop cases this guard covers.
const headingSet = (lines) => new Set(lines.flatMap((l) => {
  const m = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(l);
  return m ? [slugify(m[1])] : [];
}));

describe('heading anchors (#5427)', () => {
  test('reads ATX headings, including indented', () => {
    assert.deepEqual([...headingSet(['# Title', 'Sub', '---', '  ## Indented'])], ['title', 'indented']);
  });
  test('four leading spaces is a code block, not a heading', () => {
    assert.equal(headingSet(['    ## Code']).size, 0);
  });
  test('keeps underscores like GitHub', () => {
    assert.ok(headingSet(['## Set `commit_docs` true']).has('set-commit_docs-true'));
  });
});

describe('link classification (#5427)', () => {
  test('relative hrefs are bad; absolute URLs and ?template= links are not', () => {
    assert.deepEqual(['guide/x.md', '../CONTRIBUTING.md', '#a'].filter(isRelativeLink), ['guide/x.md', '../CONTRIBUTING.md', '#a']);
    assert.deepEqual(['https://docs.github.com/x', `${REPO}blob/next/a.md`, '?template=fix.md'].filter(isRelativeLink), []);
  });
  test('property: a destination is bad iff it has no scheme and is not a ?template= link', () => {
    const dest = fc.stringMatching(/^[A-Za-z0-9._/#=?-]{1,20}$/);
    fc.assert(fc.property(dest, (d) => {
      assert.deepEqual(hrefsIn(`[t](${d})`), [d]);
      assert.equal(isRelativeLink(d), !/^[a-z][a-z0-9+.-]*:/i.test(d) && !d.startsWith('?template='));
      assert.equal(isRelativeLink(`https://x/${d}`), false);
    }));
  });
});

describe('angle-enclosed destinations (#5427)', () => {
  const ABS = `${REPO}blob/next/guide/my%20guide.md`;
  test('inline: relative with spaces is extracted and rejected', () => {
    const hs = hrefsIn('[guide](<guide/my guide.md>)');
    assert.deepEqual(hs, ['guide/my guide.md']);
    assert.deepEqual(hs.filter(isRelativeLink), hs);
  });
  test('reference definition: relative with spaces is extracted and rejected', () => {
    const hs = hrefsIn('[guide]: <guide/my guide.md>');
    assert.deepEqual(hs, ['guide/my guide.md']);
    assert.deepEqual(hs.filter(isRelativeLink), hs);
  });
  test('angle-enclosed absolute destination is returned once', () => {
    assert.deepEqual(hrefsIn('[t](<https://x/a>)'), ['https://x/a']);
    assert.deepEqual(hrefsIn('[t]: <https://x/a>'), ['https://x/a']);
  });
  test('absolute encoded form is accepted in both', () => {
    for (const t of [`[guide](<${ABS}>)`, `[guide]: <${ABS}>`]) assert.deepEqual(hrefsIn(t).filter(isRelativeLink), []);
  });
});

describe('PR template links (#5427)', () => {
  const headings = headingSet(fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8').split(/\r?\n/));
  const files = ['pull_request_template.md', ...fs.readdirSync(DIR).filter((n) => n.endsWith('.md')).map((n) => `PULL_REQUEST_TEMPLATE/${n}`)];
  for (const f of files) {
    test(`${f}: no relative links`, () => {
      const bad = hrefsOf(f).filter(isRelativeLink);
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
  test('"Using the wrong template?" links keep ?template= (out of scope for #5427)', () => {
    for (const f of ['pull_request_template.md', 'PULL_REQUEST_TEMPLATE/fix.md', 'PULL_REQUEST_TEMPLATE/feature.md',
      'PULL_REQUEST_TEMPLATE/enhancement.md', 'PULL_REQUEST_TEMPLATE/registry-entry.md']) {
      assert.ok(hrefsOf(f).some((h) => h.startsWith('?template=')), f);
    }
  });
  for (const f of ['PULL_REQUEST_TEMPLATE/feature.md', 'PULL_REQUEST_TEMPLATE/enhancement.md']) {
    test(`${f}: links the Documentation Updates anchor`, () => {
      assert.ok(hrefsOf(f).some((h) => h.endsWith(DOCS_ANCHOR)), DOCS_ANCHOR);
    });
  }
});
