// GET /api/me: who's signed in and which plan they're on.
import { handleMe } from './_lib/handlers.js';
import { getDeps } from './_lib/deps.js';

export const GET = (request) => handleMe(request, getDeps());
