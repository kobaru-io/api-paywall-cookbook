import { afterEach, describe, expect, it, vi } from "vitest";
import { YouTubeAdapter } from "../src/infra/adapters/YouTubeAdapter.js";
import { TranscriptEmptyError, TranscriptNotFoundError } from "../src/core/entities/Errors.js";
import { WisdomService } from "../src/core/usecases/WisdomService.js";
import { InMemoryStorage } from "../src/infra/adapters/InMemoryStorage.js";

const videoId = "abcdefghijk";
const xml = '<transcript><text start="0" dur="1">one &amp; two</text><text start="1" dur="2">three</text></transcript>';

function transcriptFixture(transcript = xml, lang = "pt", player: unknown = undefined) {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin === "https://www.youtube.com" && url.pathname === "/watch") {
            expect(url.searchParams.get("v")).toBe(videoId);
            return new Response('"INNERTUBE_API_KEY":"fixture-key"');
        }
        if (url.origin === "https://www.youtube.com" && url.pathname === "/youtubei/v1/player") {
            expect(request.method).toBe("POST");
            expect(await request.json()).toMatchObject({ videoId });
            return Response.json(player ?? {
                playabilityStatus: { status: "OK" },
                captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
                    baseUrl: "https://transcript.fixture.invalid/captions", languageCode: lang
                }] } }
            });
        }
        if (url.origin === "https://transcript.fixture.invalid" && url.pathname === "/captions") {
            return new Response(transcript);
        }
        throw new Error("Unexpected fixture HTTP request");
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("real YouTube transcript library with in-memory HTTP fixtures", () => {
    it("prices decoded entity-heavy text and reuses exactly that cached transcript for extraction", async () => {
        const encoded = "&amp;".repeat(80004);
        const decoded = "&".repeat(80004);
        const fetch = transcriptFixture(`<transcript><text start="0" dur="1">${encoded}</text></transcript>`);
        const wisdom = { summary: "entity fixture", ideas: [], quotes: [], references: [] };
        const extractWisdom = vi.fn().mockResolvedValue(wisdom);
        const service = new WisdomService(new YouTubeAdapter(), { extractWisdom }, new InMemoryStorage());
        const url = `https://youtu.be/${videoId}`;
        const quote = await service.prepareForWisdom(url);
        expect(quote).toMatchObject({
            transcript: { text: decoded, tokenCount: 20001, quotedPrice: "0.020001", language: "pt" },
            price: { amount: "0.020001", currency: "USDC" }
        });
        expect(service.calculatePrice(Math.ceil(encoded.length / 4)).amount).toBe("0.100005");
        expect(await service.prepareForWisdom(url)).toEqual(quote);
        expect(await service.getQuotedPrice(url)).toBe("0.020001");
        expect(extractWisdom).not.toHaveBeenCalled();
        expect(await service.getWisdom(url, "es")).toEqual(wisdom);
        expect(extractWisdom).toHaveBeenCalledWith(decoded, "es", "pt");
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it.each([
        `https://youtu.be/${videoId}`, `https://www.youtube.com/watch?v=${videoId}`,
        `https://www.youtube.com/shorts/${videoId}`, `https://www.youtube.com/embed/${videoId}`
    ])("preserves segment joining, entity decoding and language for %s", async url => {
        const fetch = transcriptFixture();
        expect(await new YouTubeAdapter().fetch(url)).toEqual({ text: "one & two three", language: "pt" });
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("retains the adapter's default language for an empty language code", async () => {
        transcriptFixture(xml, "");
        expect(await new YouTubeAdapter().fetch(`https://youtu.be/${videoId}`)).toEqual({ text: "one & two three", language: "en" });
    });

    it("retains empty-text business errors for whitespace segments", async () => {
        transcriptFixture('<transcript><text start="0" dur="1">  </text></transcript>');
        await expect(new YouTubeAdapter().fetch(videoId)).rejects.toBeInstanceOf(TranscriptEmptyError);
    });

    it("maps the library's empty XML error to transcript not found", async () => {
        transcriptFixture("<transcript></transcript>");
        await expect(new YouTubeAdapter().fetch(videoId)).rejects.toBeInstanceOf(TranscriptNotFoundError);
    });

    it("preserves disabled-transcript error details from the real library", async () => {
        const fetch = transcriptFixture(xml, "pt", { playabilityStatus: { status: "OK" } });
        await expect(new YouTubeAdapter().fetch(videoId)).rejects.toThrow("Transcript not available:");
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("maps unavailable videos from the real library without requesting captions", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("", { status: 404 }));
        vi.stubGlobal("fetch", fetch);
        await expect(new YouTubeAdapter().fetch(videoId)).rejects.toThrow("Transcript not available:");
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("rejects invalid video IDs without HTTP", async () => {
        const fetch = transcriptFixture();
        await expect(new YouTubeAdapter().fetch("invalid")).rejects.toBeInstanceOf(TranscriptNotFoundError);
        expect(fetch).not.toHaveBeenCalled();
    });
});
