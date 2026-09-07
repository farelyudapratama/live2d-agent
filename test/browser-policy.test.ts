/** Browser URL policy — murni/lokal, tanpa jaringan eksternal. */
import { describe, it, expect } from "bun:test";
import { BrowserOriginGrants, isPrivateAddress, normalizeBrowserUrl } from "../src/server/browser/policy";

describe("browser URL policy", () => {
  it("hanya mengizinkan http/https dan membuang credential/hash", () => {
    expect(normalizeBrowserUrl("example.com/a#x")).toMatchObject({ ok: true, url: "https://example.com/a", origin: "https://example.com" });
    expect(normalizeBrowserUrl("https://u:p@example.com/a#x").url).toBe("https://example.com/a");
    for (const url of ["file:///x", "javascript:alert(1)", "data:text/html,x", "chrome://settings", "blob:https://x/y"]) {
      expect(normalizeBrowserUrl(url).ok).toBe(false);
    }
  });

  it("mengenali IPv4/IPv6 privat, loopback, link-local, metadata", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.2.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"]) expect(isPrivateAddress(ip)).toBe(false);
  });

  it("localhost ditandai privat dan butuh grant eksplisit", async () => {
    const grants = new BrowserOriginGrants();
    const before = await grants.authorize("http://localhost:3000/app");
    expect(before).toMatchObject({ ok: false, privateNetwork: true, origin: "http://localhost:3000" });
    grants.grant("http://localhost:3000");
    const after = await grants.authorize("http://localhost:3000/app");
    expect(after).toMatchObject({ ok: true, privateNetwork: true });
    grants.revokeAll();
    expect((await grants.authorize("http://localhost:3000")).ok).toBe(false);
  });
});
