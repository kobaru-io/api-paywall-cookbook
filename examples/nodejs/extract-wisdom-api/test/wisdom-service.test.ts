import { describe, expect, it, vi } from "vitest";
import { WisdomService } from "../src/core/usecases/WisdomService.js";
import { InMemoryStorage } from "../src/infra/adapters/InMemoryStorage.js";

function setup(text = "a".repeat(80001)) {
    const fetch = vi.fn().mockResolvedValue({ text, language: "pt" });
    const wisdom = { summary: "fixture", ideas: [], quotes: [], references: [] };
    const extractWisdom = vi.fn().mockResolvedValue(wisdom);
    const service = new WisdomService({ fetch }, { extractWisdom }, new InMemoryStorage());
    return { service, fetch, extractWisdom, wisdom };
}

describe("WisdomService characterization", () => {
    it.each([[0, "0.01"], [9999, "0.01"], [10000, "0.01"], [10001, "0.010001"], [20000, "0.02"]])("prices %i tokens in major units", (tokens, amount) => {
        expect(setup().service.calculatePrice(tokens)).toEqual({ amount, currency: "USDC" });
    });

    it("rounds token estimates up, caches the quote and never calls AI during pricing", async () => {
        const { service, fetch, extractWisdom } = setup();
        expect(await service.getQuotedPrice("url")).toBeNull();
        const quote = await service.prepareForWisdom("url");
        expect(quote).toMatchObject({ transcript: { tokenCount: 20001, language: "pt", quotedPrice: "0.020001" }, price: { amount: "0.020001" } });
        expect(await service.prepareForWisdom("url")).toEqual(quote);
        expect(await service.getQuotedPrice("url")).toBe("0.020001");
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(extractWisdom).not.toHaveBeenCalled();
    });

    it("rejects extraction without a cached quote and does not fetch or generate", async () => {
        const { service, fetch, extractWisdom } = setup();
        await expect(service.getWisdom("unquoted")).rejects.toThrow("No cached quote found");
        expect(fetch).not.toHaveBeenCalled();
        expect(extractWisdom).not.toHaveBeenCalled();
    });

    it.each([[undefined, "pt"], ["", "pt"], ["es", "es"]])("preserves requested/default output language %s", async (requested, output) => {
        const { service, extractWisdom, wisdom } = setup("transcript");
        await service.prepareForWisdom("url");
        expect(await service.getWisdom("url", requested)).toEqual(wisdom);
        expect(extractWisdom).toHaveBeenCalledWith("transcript", output, "pt");
    });

    it("propagates fetch and provider failures without inventing a cached quote", async () => {
        const { service, fetch, extractWisdom } = setup();
        fetch.mockRejectedValueOnce(new Error("fetch failed"));
        await expect(service.prepareForWisdom("url")).rejects.toThrow("fetch failed");
        expect(await service.getQuotedPrice("url")).toBeNull();
        await service.prepareForWisdom("url");
        extractWisdom.mockRejectedValueOnce(new Error("provider failed"));
        await expect(service.getWisdom("url")).rejects.toThrow("provider failed");
    });
});
