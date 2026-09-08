import { env } from '../src/config.js';
import { embed } from '../src/lib/embeddings.js';

const [vector] = await embed(['WikiBookLM embedding smoke test.'], 'query');

if (!vector) {
  console.error('No vector returned.');
  process.exit(1);
}

console.log(`endpoint:   ${env.HF_BASE_URL}`);
console.log(`model:      ${env.EMBEDDING_MODEL}`);
console.log(`dimensions: ${vector.length} (expected ${env.EMBEDDING_DIM})`);
console.log(`first 5:    ${vector.slice(0, 5).map((n) => n.toFixed(6)).join(', ')}`);

if (vector.length !== env.EMBEDDING_DIM) process.exit(1);
