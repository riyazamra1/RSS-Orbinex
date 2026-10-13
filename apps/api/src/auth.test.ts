import { describe, expect, it } from "vitest";
import { createSessionToken, hashPassword, hashSessionToken, verifyPassword } from "./security.js";

describe("authentication security primitives", () => {
  it("generates high-entropy opaque session tokens and stores only a hash", () => {
    const token = createSessionToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(hashSessionToken(token)).not.toBe(token);
    expect(hashSessionToken(token)).toHaveLength(64);
  });

  it("hashes passwords with a one-way password hash and verifies correctly", async () => {
    const hash = await hashPassword("Correct Horse Battery Staple 93!");
    expect(hash).toContain("$argon2id$");
    expect(await verifyPassword(hash, "Correct Horse Battery Staple 93!")).toBe(true);
    expect(await verifyPassword(hash, "wrong-password")).toBe(false);
  });
});
