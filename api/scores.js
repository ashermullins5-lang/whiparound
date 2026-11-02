// GET /api/scores?league=nfl: today's games from the configured scores provider, cached at the CDN.
import { handleScores } from './_lib/handlers.js';
import { getDeps } from './_lib/deps.js';

export const GET = (request) => handleScores(request, getDeps());
