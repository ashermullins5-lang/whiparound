// POST /api/portal: open Stripe's billing portal (change plan, update card, cancel).
import { handlePortal } from './_lib/handlers.js';
import { getDeps } from './_lib/deps.js';

export const POST = (request) => handlePortal(request, getDeps());
