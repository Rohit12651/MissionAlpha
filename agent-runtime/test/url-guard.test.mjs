// SSRF guard — pure isBlockedIp predicate + assertSafeHttpUrl. Hermetic: no external
// host is contacted. Literal IPs are judged without DNS; the "allowed" path uses a
// literal public IP (lookup of a numeric literal returns it without a DNS query).
import { test } from "node:test";
import assert from "node:assert/strict";

import { isBlockedIp, assertSafeHttpUrl } from "../providers/url-guard.mjs";

test("isBlockedIp: private/loopback/link-local/ULA/mapped → true", () => {
  for (const a of [
    "169.254.169.254", // cloud metadata (the SSRF vector)
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.1",
    "172.16.5.5",
    "0.0.0.0",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
  ]) {
    assert.equal(isBlockedIp(a), true, `${a} should be blocked`);
  }
});

test("isBlockedIp: public addresses + near-miss ranges → false", () => {
  for (const a of [
    "1.1.1.1",
    "8.8.8.8",
    "2606:4700:4700::1111", // public IPv6
    "172.32.0.1", // just outside 172.16/12
    "192.169.0.1", // just outside 192.168/16
    "example.com", // non-IP hostname
  ]) {
    assert.equal(isBlockedIp(a), false, `${a} should NOT be blocked`);
  }
});

test("assertSafeHttpUrl rejects a non-http(s) protocol", async () => {
  await assert.rejects(() => assertSafeHttpUrl("ftp://8.8.8.8/"), /protocol/i);
});

test("assertSafeHttpUrl rejects an unparseable URL", async () => {
  await assert.rejects(() => assertSafeHttpUrl("not a url"), /invalid URL/i);
});

test("assertSafeHttpUrl rejects the literal metadata IP", async () => {
  await assert.rejects(() => assertSafeHttpUrl("http://169.254.169.254/"), /block/i);
});

test("assertSafeHttpUrl allows a literal public IP", async () => {
  const u = await assertSafeHttpUrl("https://1.1.1.1/v1");
  assert.equal(u.protocol, "https:");
  assert.equal(u.hostname, "1.1.1.1");
});
