'use strict';
const { test } = require('node:test');
const fc = require('./helpers/fast-check-setup.cjs');
const { escalationAllows } = require('../gsd-core/bin/lib/model-escalation.cjs');

test('property: a record counts for a dispatch iff the dispatch has no session or the record carries the same one', () => {
  fc.assert(fc.property(fc.constantFrom(undefined, 's1', 's2', ''), fc.constantFrom(undefined, 's1', 's2'), (recSession, session) => {
    const rec = { model: 'opus', written_at: 0, ...(recSession === undefined ? {} : { session: recSession }) };
    return escalationAllows(rec, 'opus', { now: 0, session }) === (session === undefined || recSession === session);
  }));
});
