import { describe, expect, it } from 'vitest';
import { retrievableSources } from '../src/lib/retrieval-scope.js';

/** PRD §6/§9/§17 — the one filter Phase 4 must build every retrieval query from. */
describe('retrievableSources', () => {
  it('restricts retrieval to ready, non-archived sources in the space', () => {
    expect(retrievableSources('space-1')).toEqual({
      spaceId: 'space-1',
      state: 'ready',
      archivedAt: null,
    });
  });

  it('must not drop the archived filter — a withdrawal is silent otherwise', () => {
    const filter = retrievableSources('space-1');
    // Guarding the invariant the mutation check targets: forgetting `archivedAt`
    // returns plausible answers from evidence the user withdrew.
    expect(filter).toHaveProperty('archivedAt', null);
  });
});