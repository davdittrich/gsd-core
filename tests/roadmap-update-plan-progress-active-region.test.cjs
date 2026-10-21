/**
 * #5553: roadmap update-plan-progress must edit only the active milestone,
 * whatever the archive's tag case / attributes / position relative to it.
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const ARCHIVE_BODY = `- [ ] **Phase 1: Old**

### Phase 1: Old
**Goal:** old
**Plans:** 0 plans

Plans:
- [ ] 01-01-PLAN.md
`;
const ACTIVE_BODY = `## v2.0 Active

- [ ] **Phase 1: A**

### Phase 1: A
**Goal:** a
**Plans:** 0 plans

Plans:
- [ ] 01-01-PLAN.md

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. A | 0/1 | In Progress | |
`;

const archive = (open, tag) => `<${tag}${open}>\n<summary>v1.0 ✅ SHIPPED</summary>\n\n${ARCHIVE_BODY}\n</${tag}>\n`;

const SHAPES = {
  'control: lowercase archive first': () => `# Roadmap\n\n${archive('', 'details')}\n${ACTIVE_BODY}`,
  'uppercase <DETAILS> archive': () => `# Roadmap\n\n${archive('', 'DETAILS')}\n${ACTIVE_BODY}`,
  '<details open> archive': () => `# Roadmap\n\n${archive(' open', 'details')}\n${ACTIVE_BODY}`,
  'archive after the active section (newest-first)': () => `# Roadmap\n\n${ACTIVE_BODY}\n${archive('', 'details')}`,
  'nested <details> inside the archive': () =>
    `# Roadmap\n\n<details>\n<summary>v1.0 ✅ SHIPPED</summary>\n\n<details>\n<summary>inner</summary>\n\nx\n</details>\n\n${ARCHIVE_BODY}\n</details>\n\n${ACTIVE_BODY}`,
  '<details open> wraps the active milestone': () =>
    `# Roadmap\n\n${archive('', 'details')}\n<details open>\n<summary>v2.0 🚧 Active</summary>\n\n${ACTIVE_BODY}\n</details>\n`,
};

describe('roadmap update-plan-progress active-region scoping (#5553)', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = createTempProject();
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-a');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# summary\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nmilestone: v2.0\n---\n# State\n');
  });
  afterEach(() => cleanup(tmpDir));

  for (const [name, build] of Object.entries(SHAPES)) {
    test(name, () => {
      const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
      fs.writeFileSync(roadmapPath, build());
      const result = runGsdTools(['roadmap', 'update-plan-progress', '1'], tmpDir);
      assert.ok(result.success, result.error);
      const out = fs.readFileSync(roadmapPath, 'utf-8');
      assert.ok(out.includes(ARCHIVE_BODY), `archive must be byte-identical:\n${out}`);
      assert.match(out, /- \[x\] 01-01-PLAN\.md/, 'active plan line ticked');
      assert.match(out, /\*\*Plans:\*\* 1\/1/, 'active Plans line updated');
    });
  }
});
