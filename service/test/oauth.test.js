import assert from "node:assert/strict";
import test from "node:test";

process.env.STATE_SECRET = "test-secret-not-used-anywhere-real";
process.env.GOOGLE_CLIENT_ID = "gid";
process.env.GOOGLE_CLIENT_SECRET = "gsecret";

const { authorizeUrl, configuredProviders, isConfigured, signState, verifyState } = await import(
  "../dist/service/src/oauth.js"
);

test("a signed state round-trips", () => {
  const s = signState("/charts/abc");
  const out = verifyState(s);
  assert.equal(out.ok, true);
  assert.equal(out.returnTo, "/charts/abc");
});

test("a tampered state is refused", () => {
  const s = signState("/");
  const [nonce, encoded] = s.split(".");
  // Swap the payload but keep the original signature.
  const forged = `${nonce}.${Buffer.from("/evil").toString("base64url")}.${s.split(".")[2]}`;
  assert.equal(verifyState(forged).ok, false);
  assert.equal(verifyState(`${nonce}.${encoded}.deadbeef`).ok, false);
  assert.equal(verifyState(null).ok, false);
  assert.equal(verifyState("nonsense").ok, false);
});

test("two states are never the same", () => {
  assert.notEqual(signState("/"), signState("/"), "the nonce must vary");
});

// An attacker-supplied return_to is the classic OAuth open redirect: the state
// is validly signed because we signed it, so the check has to be on the value.
test("return_to may not leave the origin", () => {
  for (const bad of ["https://evil.test/x", "//evil.test/x", "http://evil.test"]) {
    const out = verifyState(signState(bad));
    assert.equal(out.ok, true, "signature is still valid");
    assert.equal(out.returnTo, "/", `${bad} should have been rejected`);
  }
});

test("a relative path is preserved", () => {
  assert.equal(verifyState(signState("/a/b?c=d")).returnTo, "/a/b?c=d");
});

test("only configured providers are offered", () => {
  assert.ok(isConfigured("google"));
  assert.ok(!isConfigured("github"), "no GITHUB_CLIENT_ID in this env");
  assert.deepEqual(configuredProviders(), ["google"]);
});

test("the authorize URL carries the state and redirect", () => {
  const state = signState("/");
  const u = new URL(authorizeUrl("google", "https://app.test/auth/google/callback", state));
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("client_id"), "gid");
  assert.equal(u.searchParams.get("redirect_uri"), "https://app.test/auth/google/callback");
  assert.equal(u.searchParams.get("state"), state);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.match(u.searchParams.get("scope") ?? "", /email/);
});
