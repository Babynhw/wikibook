/**
 * Retrieval eligibility is a data-layer invariant, not a prompt concern (PRD
 * §6/§9/§17): failed or archived sources must never reach retrieval, and a
 * retrieval query that forgets `archivedAt` returns plausible answers from
 * evidence the user withdrew. This is the one filter retrieval is built from.
 *
 * Phase 4 MUST build every retrieval query from this function — adding the
 * assistant must not add a second, looser definition of "retrievable".
 *
 * Notes need no filter: a note is not a `Source` until the §12 conversion
 * makes one, at which point it re-enters through this same shape.
 */
export function retrievableSources(spaceId: string) {
  return {
    spaceId,
    state: 'ready' as const,
    archivedAt: null,
  };
}