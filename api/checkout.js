// POST /api/checkout: start a Stripe Checkout for Pro and return its URL.
import { handleCheckout } from './_lib/handlers.js';
import { getDeps } from './_lib/deps.js';

export const POST = (request) => handleCheckout(request, getDeps());
