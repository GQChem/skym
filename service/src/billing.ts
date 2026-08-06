import Stripe from "stripe";
import type { Pool } from "./db.js";
import { tx } from "./db.js";
import { recordAudit } from "./audit.js";

const stripeClient = (): Stripe => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return new Stripe(key);
};

const proPrice = (): string => {
  const price = process.env.STRIPE_PRO_PRICE_ID;
  if (!price) throw new Error("STRIPE_PRO_PRICE_ID is not set");
  return price;
};

export const billingConfigured = (): boolean =>
  Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRO_PRICE_ID && process.env.STRIPE_WEBHOOK_SECRET);

export async function createCheckout(pool: Pool, userId: string, origin: string): Promise<string> {
  const r = await pool.query<{ email: string; stripe_customer_id: string | null }>(
    "SELECT email, stripe_customer_id FROM users WHERE id = $1", [userId],
  );
  const user = r.rows[0];
  if (!user) throw new Error("account not found");
  const session = await stripeClient().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: proPrice(), quantity: 1 }],
    success_url: `${origin}/settings?billing=success`,
    cancel_url: `${origin}/settings?billing=cancelled`,
    client_reference_id: userId,
    customer: user.stripe_customer_id ?? undefined,
    customer_email: user.stripe_customer_id ? undefined : user.email,
    subscription_data: { metadata: { skym_user_id: userId } },
    allow_promotion_codes: true,
  });
  if (!session.url) throw new Error("Stripe returned no checkout URL");
  return session.url;
}

export async function createPortal(pool: Pool, userId: string, origin: string): Promise<string> {
  const r = await pool.query<{ stripe_customer_id: string | null }>(
    "SELECT stripe_customer_id FROM users WHERE id = $1", [userId],
  );
  const customer = r.rows[0]?.stripe_customer_id;
  if (!customer) throw new Error("no billing customer for this account");
  const session = await stripeClient().billingPortal.sessions.create({ customer, return_url: `${origin}/settings` });
  return session.url;
}

export function constructStripeEvent(raw: Buffer, signature: string): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  return stripeClient().webhooks.constructEvent(raw, signature, secret);
}

const subscriptionPlan = (status: Stripe.Subscription.Status): "free" | "pro" =>
  status === "active" || status === "trialing" ? "pro" : "free";

/** Idempotently project Stripe's subscription state into local entitlements. */
export async function applyStripeEvent(pool: Pool, event: Stripe.Event): Promise<boolean> {
  return tx(pool, async (client) => {
    const seen = await client.query(
      "INSERT INTO stripe_events (id, event_type) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [event.id, event.type],
    );
    if ((seen.rowCount ?? 0) === 0) return false;

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id;
      const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
      const subscription = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      if (userId && customer) {
        await client.query(
          `UPDATE users SET stripe_customer_id = $1,
             stripe_subscription_id = COALESCE($2, stripe_subscription_id)
           WHERE id = $3`,
          [customer, subscription ?? null, userId],
        );
        await recordAudit(client, { actorId: userId, event: "billing.checkout_completed", targetType: "user", targetId: userId });
      }
    }

    if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
      const subscription = event.data.object as Stripe.Subscription;
      const customer = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
      const userId = subscription.metadata.skym_user_id;
      const plan = subscriptionPlan(subscription.status);
      const updated = await client.query<{ id: string }>(
        `UPDATE users SET plan = $1, stripe_customer_id = $2, stripe_subscription_id = $3,
                          subscription_status = $4
          WHERE id = $5 OR stripe_customer_id = $2 RETURNING id`,
        [plan, customer, subscription.id, subscription.status, userId || null],
      );
      const accountId = updated.rows[0]?.id;
      if (accountId) await recordAudit(client, {
        actorId: accountId, event: "billing.subscription_changed", targetType: "subscription",
        targetId: subscription.id, metadata: { status: subscription.status, plan },
      });
    }
    return true;
  });
}
