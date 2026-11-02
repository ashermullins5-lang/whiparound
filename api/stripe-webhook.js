// POST /api/stripe-webhook: Stripe tells us when a subscription starts, renews, changes or ends.
// Point a Stripe webhook endpoint at https://<your-domain>/api/stripe-webhook.
import { handleWebhook } from './_lib/handlers.js';
import { getDeps } from './_lib/deps.js';

export const POST = (request) => handleWebhook(request, getDeps());
