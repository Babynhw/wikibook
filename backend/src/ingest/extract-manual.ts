import type { ExtractionResult } from './extracted.js';
import type { LocatedBlock } from './chunk.js';

/**
 * Manual sources: the entered content is the original (PRD §5.3), so this is a
 * normalization, never a rewrite. Each non-empty line becomes a located block
 * with a sequential paragraph index; `text` is the joined, trimmed original.
 */
export function extractManual(content: string): ExtractionResult {
  const blocks: LocatedBlock[] = [];
  for (const line of content.split(/\r?\n/)) {
    const text = line.trim();
    if (text.length === 0) continue;
    blocks.push({ text, paragraphIndex: blocks.length + 1 });
  }

  return { text: blocks.map((block) => block.text).join('\n'), blocks };
}