import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createBrowserNetwork } from "../src/browser-network.ts";

describe("Browser network transfers", function suite() {
  test("more than 200 requests complete through the connection queue", async function requests() {
    let active = 0;
    let peak = 0;
    const network = createBrowserNetwork(async function fixture() {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return new Response("ok");
    });
    try {
      const responses = await Promise.all(Array.from({ length: 240 }, (_, index) => network.download("https://example.test/" + index)));
      assert.equal(responses.length, 240);
      assert.ok(responses.every(response => response.body === "ok"));
      assert.equal(peak, 6);
      assert.equal(network.diagnostics().pending, 0);
    } finally { network.close(); }
  });

  test("responses above 4 MiB and cumulative downloads above 24 MiB remain complete", async function bodies() {
    const body = "a".repeat(5 * 1024 * 1024) + "Я😀";
    const network = createBrowserNetwork(async function fixture() {
      return new Response(body, { headers: { "content-length": String(Buffer.byteLength(body)) } });
    });
    try {
      for (let index = 0; index < 6; index++) {
        const response = await network.download("https://example.test/large");
        assert.equal(response.body, body);
      }
      assert.ok(network.diagnostics().downloadedBytes > 24 * 1024 * 1024);
    } finally { network.close(); }
  });

  test("stream decoding preserves characters across response chunk boundaries", async function unicode() {
    const bytes = new TextEncoder().encode("Я😀");
    const network = createBrowserNetwork(async function fixture() {
      return new Response(new ReadableStream({ start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      } }));
    });
    try { assert.equal((await network.download("https://example.test/")).body, "Я😀"); }
    finally { network.close(); }
  });

  test("closing aborts active downloads and drains queued requests", async function abort() {
    const network = createBrowserNetwork(function fixture(_input, init) {
      return new Promise(function pending(_resolve, reject) {
        init!.signal!.addEventListener("abort", function cancelled() { reject(init!.signal!.reason); }, { once: true });
      });
    });
    const responses = Array.from({ length: 30 }, (_, index) => network.download("https://example.test/" + index));
    network.close();
    assert.ok((await Promise.allSettled(responses)).every(response => response.status === "rejected"));
    assert.equal(network.diagnostics().pending, 0);
  });

  test("cookies can be updated after a page sets more than 200", async function cookies() {
    const network = createBrowserNetwork();
    try {
      for (let index = 0; index < 240; index++) network.setCookie("cookie" + index + "=first; Path=/", "https://example.test/");
      network.setCookie("cookie0=updated; Path=/", "https://example.test/");
      assert.match(network.cookies("https://example.test/"), /cookie0=updated/);
      assert.match(network.cookies("https://example.test/"), /cookie239=first/);
    } finally { network.close(); }
  });
});
