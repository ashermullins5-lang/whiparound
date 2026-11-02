// GET /api/config: the paid backend's public settings (or { paywall: false } when it isn't set up).
import { handleConfig } from './_lib/handlers.js';
import { getDeps } from './_lib/deps.js';

export const GET = (request) => handleConfig(request, getDeps());
