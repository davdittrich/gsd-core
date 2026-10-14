/**
 * #5288 — the reviewer lane must never forward its prompt to a redirect target.
 *
 * Real `gsd-tools review-lane invoke` against two loopback servers: R (the consented host)
 * redirects, T (the redirect target) records every request. `fetch` follows 307 with method and
 * body, so before the fix T received the full prompt.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');

const TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

const listen = (srv) => new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv.address().port)));
const close = (srv) => new Promise((res) => srv.close(res));

/** `redirectOn`: which method R answers with a redirect — 'POST', 'GET' or null (never). */
async function invokeLane(redirectOn, status = 307) {
  const seen = [];
  const target = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'LEAKED' } }] }));
  });
  let tPort;
  const redirector = http.createServer((req, res) => {
    if (req.method === redirectOn) {
      res.writeHead(status, { Location: `http://127.0.0.1:${tPort}${req.url}` });
      return res.end();
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'REAL-REVIEW' } }] }));
  });
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5288-'));
  try {
    tPort = await listen(target);
    const rPort = await listen(redirector);
    fs.mkdirSync(path.join(project, '.planning'));
    fs.writeFileSync(
      path.join(project, '.planning', 'config.json'),
      JSON.stringify({ review: { ollama_host: `http://127.0.0.1:${rPort}` } }),
    );
    const runDir = path.join(project, 'run');
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, 'gsd-review-prompt.md'), 'SECRET-PLAN-BODY\n');

    // Async spawn: both servers live in this process, so spawnSync would deadlock the event loop.
    const out = await new Promise((resolve, reject) => {
      const c = cp.spawn(
        process.execPath,
        [TOOLS, 'review-lane', 'invoke', '--slug', 'ollama', '--run-dir', runDir, '--repo-root', project, '--raw'],
        { cwd: project, env: process.env },
      );
      let text = '';
      c.stdout.on('data', (d) => (text += d));
      c.stderr.on('data', (d) => (text += d));
      c.on('error', reject);
      c.on('close', () => resolve(text));
    });
    // HTTP failures surface as a diagnostic stub review in the run dir (writeReviewOrStub).
    const written = fs.readdirSync(runDir)
      .filter((f) => f !== 'gsd-review-prompt.md')
      .map((f) => fs.readFileSync(path.join(runDir, f), 'utf8'))
      .join('\n');
    return { seen, out, written };
  } finally {
    await close(redirector);
    await close(target);
    cleanup(project);
  }
}

describe('review-lane HTTP seam refuses redirects (#5288)', () => {
  for (const status of [301, 302, 307, 308]) {
    test(`${status} on the chat POST: target gets no request, stub names the redirect`, async () => {
      const { seen, out, written } = await invokeLane('POST', status);
      assert.deepEqual(seen, [], 'redirect target received a request');
      assert.match(out, /"stubbed": true/, out);
      assert.match(written, /redirect refused/i, written);
      assert.doesNotMatch(out + written, /LEAKED/);
    });
  }

  test('302 on the availability probe GET: lane unavailable, target gets no request', async () => {
    const { seen, out } = await invokeLane('GET', 302);
    assert.deepEqual(seen, [], 'redirect target received a request');
    assert.match(out, /"ok": false/, out);
  });

  test('a host that does not redirect still yields a real review', async () => {
    const { seen, out } = await invokeLane(null);
    assert.deepEqual(seen, []);
    assert.match(out, /"stubbed": false/, out);
  });
});
