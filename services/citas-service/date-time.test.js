const assert = require('node:assert/strict');
const test = require('node:test');
const { citaYaPaso } = require('./date-time');

test('keeps a future Mexico City appointment pending when the server clock is UTC', () => {
  const now = new Date('2026-11-25T18:43:00.000Z');
  assert.equal(citaYaPaso('2026-11-25', '13:42:00', 'America/Mexico_City', now), false);
});

test('marks a Mexico City appointment in the past as completed', () => {
  const now = new Date('2026-11-25T18:43:00.000Z');
  assert.equal(citaYaPaso('2026-11-25', '12:42:00', 'America/Mexico_City', now), true);
});
