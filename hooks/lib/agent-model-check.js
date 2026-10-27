'use strict';
// hooks/lib/agent-model-check.js — #5328: does the model a model-authored
// Agent()/Task() call passes match the one GSD resolved for that agent?
// Baseline is resolveModelInternal over the workstream-aware config
// (what `init` reports and the workflow tells the model to pass). A fresh,
// session-matching `resolve-execution --attempt N` record
// (gsd-core/bin/lib/model-escalation.cjs) legitimises the escalated model.
// Never fails closed: any inability to verify is an allow.

const path = require('path');
const { resolveSentinelRoot } = require('./isolation-sentinel.js');
const { REASON_INTERPOLATION_MAX_LEN } = require('./isolation-deny-reason.js');

const ALLOW = { action: 'allow' };

// Literal copy of model-escalation's GUARDED_AGENT_TYPES so every other subagent dispatch is
// allowed before the runtime build seam and the built artifact load; a test pins the two equal.
const GUARDED_TYPES = new Set(['gsd-executor', 'gsd-verifier', 'gsd-plan-checker', 'gsd-planner']);

// `hooks.agent_model_guard`, from the root config only, like the other hooks.* keys. Strict JSON on
// purpose: a config this cannot parse (comments, trailing commas) fails open, as does one over maxBytes.
function readGuardMode(root, maxBytes) {
  const text = require('../../gsd-core/bin/lib/capability-ledger.cjs').readSmallRegularFile(path.join(root, '.planning', 'config.json'), maxBytes);
  return text === null ? { skip: true } : { mode: (JSON.parse(text).hooks || {}).agent_model_guard };
}

// tool_input.model is model-authored and the expected model comes from repo config:
// cap both and keep only id-shaped characters before they reach additionalContext.
// `@` keeps Vertex ids (`claude-opus-4-1@20250805`) intact; anything past the cap is cut.
const sanitiseModelId = (s) => s.replace(/[^\w.:@/[\]-]/g, '?').slice(0, REASON_INTERPOLATION_MAX_LEN);

// Only a passed, wrong model is denied: the hook cannot see the orchestrator's model, so an
// omitted one (the subagent inherits it) may well match and stays a warning even under deny.
function verdict(mode, type, rawPassed, rawExpected) {
  const passed = sanitiseModelId(rawPassed);
  const expected = sanitiseModelId(rawExpected);
  return {
    action: mode === 'deny' && passed ? 'block' : 'warn',
    passed,
    expected,
    reason: `Agent model guard: subagent_type="${type}" ${passed ? `was passed model="${passed}"` : 'was passed no model'}, ` +
      `but GSD resolved model="${expected}" for it. Pass model="${expected}" (or run ` +
      `\`resolve-execution ${type} --attempt N\` first to escalate deliberately).`,
  };
}

/**
 * @returns {{action:'allow'}|{action:'warn'|'block', passed:string, expected:string, reason:string}}
 * `passed` and `expected` are the sanitised values `reason` renders ('' = no model passed).
 */
function checkAgentModel(data, { clock } = {}) {
  try {
    if (!data || (data.tool_name !== 'Agent' && data.tool_name !== 'Task')) return ALLOW;
    const toolInput = data.tool_input;
    const type = toolInput && toolInput.subagent_type;
    if (typeof type !== 'string' || !GUARDED_TYPES.has(type)) return ALLOW;

    // #3582 seam (lint-hooks-runtime-build-seam), but never compile here: on a cold tree
    // tscScript null throws (caught below: allow) instead of running tsc inside the hook.
    require('../../gsd-core/bin/ensure-runtime-build.cjs').ensureRuntimeBuild({ tscScript: null });
    const esc = require('../../gsd-core/bin/lib/model-escalation.cjs');

    const root = resolveSentinelRoot(data.cwd || process.cwd());
    const { mode, skip } = readGuardMode(root, esc.MAX_READ_BYTES);
    if (skip || mode === false) return ALLOW;

    // The workstream `init` resolves (GSD_WORKSTREAM > stored pointer, read-only peek, as the
    // gsd-tools dispatcher and gsd-statusline do), carried in GSD_WORKSTREAM into loadConfig and
    // planningDir; the caller's environment is restored in `finally`.
    const store = require('../../gsd-core/bin/lib/active-workstream-store.cjs');
    const priorWorkstream = process.env.GSD_WORKSTREAM;
    try {
      store.applyResolvedWorkstreamEnv(store.resolveActiveWorkstream(root, [], process.env, { getStored: store.peekActiveWorkstream }), process.env);
      const resolver = require('../../gsd-core/bin/lib/model-resolver.cjs');
      const config = require('../../gsd-core/bin/lib/config-loader.cjs').loadConfig(root, { persist: false });
      // Only where the host resolves the tier aliases GSD resolves to, over the one runtime chain
      // (GSD_RUNTIME > config.runtime > marker), from the config the expected model resolves through.
      if (!resolver.hasNativeModelAliases(require('../../gsd-core/bin/lib/runtime-slash.cjs').resolveActiveRuntime(config))) return ALLOW;
      const expected = resolver.resolveModelInternal(root, type, { persist: false });
      if (!expected || expected === 'inherit') return ALLOW;

      const passed = typeof toolInput.model === 'string' ? toolInput.model : '';
      if (passed && esc.modelFamily(passed) === esc.modelFamily(expected)) return ALLOW;
      if (passed) {
        const session = typeof data.session_id === 'string' && data.session_id ? data.session_id : undefined;
        // realClock honours the GSD_TEST_MODE + GSD_NOW_MS pin in a hook subprocess (RULESET.TESTS.clock-seam).
        const now = (clock || require('../../gsd-core/bin/lib/clock.cjs').realClock).now();
        if (esc.escalationAllows(esc.readEscalation(root, type), passed, { now, session })) return ALLOW;
      }
      return verdict(mode, type, passed, expected);
    } finally {
      if (priorWorkstream === undefined) delete process.env.GSD_WORKSTREAM;
      else process.env.GSD_WORKSTREAM = priorWorkstream;
    }
  } catch {
    return ALLOW;
  }
}

module.exports = { checkAgentModel, GUARDED_TYPES };
