import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import { randomUUID } from "node:crypto";

process.env.STRIPE_SECRET_KEY = "sk_test_fake_for_unit_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit_test_secret";
process.env.STRIPE_PRO_PRICE_ID = "price_unit_test";

const { applyStripeEvent, billingConfigured, constructStripeEvent } = await import("../dist/service/src/billing.js");
const { makePool, migrate } = await import("../dist/service/src/db.js");

test("billing is configured only when all required values exist", () => {
  assert.equal(billingConfigured(), true);
});

test("Stripe webhooks require a valid signature over the raw body", () => {
  const payload = JSON.stringify({ id: "evt_test", object: "event", type: "test.event", data: { object: {} } });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  assert.equal(constructStripeEvent(Buffer.from(payload), signature).id, "evt_test");
  assert.throws(() => constructStripeEvent(Buffer.from(payload + " "), signature));
});

const dbUrl = process.env.TEST_DATABASE_URL;
test("subscription events idempotently grant and remove storage entitlement", { skip: dbUrl ? false : "TEST_DATABASE_URL not set — skipping billing integration test" }, async () => {
  const pool = makePool(dbUrl);
  await migrate(pool);
  const userId = (await pool.query("INSERT INTO users (email) VALUES ($1) RETURNING id", [`billing-${randomUUID()}@test.local`])).rows[0].id;
  const subscription = {
    id: `sub_${randomUUID()}`,
    object: "subscription",
    customer: `cus_${randomUUID()}`,
    status: "active",
    metadata: { skym_user_id: userId },
  };
  const event = { id: `evt_${randomUUID()}`, type: "customer.subscription.created", data: { object: subscription } };
  assert.equal(await applyStripeEvent(pool, event), true);
  assert.equal(await applyStripeEvent(pool, event), false, "redelivery is idempotent");
  assert.equal((await pool.query("SELECT plan FROM users WHERE id = $1", [userId])).rows[0].plan, "pro");
  await applyStripeEvent(pool, {
    id: `evt_${randomUUID()}`,
    type: "customer.subscription.deleted",
    data: { object: { ...subscription, status: "canceled" } },
  });
  assert.equal((await pool.query("SELECT plan FROM users WHERE id = $1", [userId])).rows[0].plan, "free");
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.end();
});
