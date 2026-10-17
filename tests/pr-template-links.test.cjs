// Regression for #5427: PR bodies render relative hrefs verbatim, so they
// resolve against /pull/N and 404. Only `?template=` links may be relative.
// Scope: inline `[t](url "title")`, `href="url"` and reference-definition `[t]: url` links;
// autolinks are absolute by construction, and a URL containing `)` is not supported.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
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
const slug = (h) => h.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
const hrefsOf = (f) => {
  const text = fs.readFileSync(path.join(GH, f), 'utf8');
  return LINKS.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]));
};

describe('PR template links (#5427)', () => {
  const headings = new Set();
  let fenced = false;
  for (const l of fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    else if (!fenced && /^#{1,6} /.test(l)) headings.add(slug(l.replace(/^#+ /, '')));
  }
  const files = ['pull_request_template.md', ...fs.readdirSync(DIR).filter((n) => n.endsWith('.md')).map((n) => `PULL_REQUEST_TEMPLATE/${n}`)];
  for (const f of files) {
    test(`${f}: only ?template= links are relative`, () => {
      const bad = hrefsOf(f).filter((h) => !h.startsWith('?template=') && !(h.startsWith(`${REPO}blob/next/`) || h === `${REPO}discussions`));
      assert.deepEqual(bad, []);
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
