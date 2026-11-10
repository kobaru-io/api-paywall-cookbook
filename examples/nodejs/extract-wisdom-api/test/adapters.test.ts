import { beforeEach, describe, expect, it, vi } from "vitest";
import { YouTubeAdapter } from "../src/infra/adapters/YouTubeAdapter.js";
import { GeminiAdapter } from "../src/infra/adapters/GeminiAdapter.js";
import { TranscriptEmptyError, TranscriptNotFoundError } from "../src/core/entities/Errors.js";
import { validateAndNormalizeYouTubeUrl } from "../src/core/validation/UrlValidator.js";
import { getSystemInstruction } from "../src/core/prompts/ExtractWisdom.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const client = vi.hoisted(() => ({ fetch: vi.fn(), model: vi.fn(), generate: vi.fn() }));
vi.mock("youtube-transcript-plus", () => ({ fetchTranscript: client.fetch }));
vi.mock("@google/generative-ai", () => ({ GoogleGenerativeAI: class {
    getGenerativeModel(options: unknown) { client.model(options); return { generateContent: client.generate }; }
} }));

beforeEach(() => { vi.clearAllMocks(); client.fetch.mockReset(); client.generate.mockReset(); });

describe("adapter boundaries (no external AI or YouTube requests)", () => {
    it.each([["pt", "pt"], [undefined, "en"]])("joins transcript segments and detects/defaults language %s", async (lang, expected) => {
        client.fetch.mockResolvedValue([{ text: "one", lang }, { text: "two" }]);
        expect(await new YouTubeAdapter().fetch("url")).toEqual({ text: "one two", language: expected });
        expect(client.fetch).toHaveBeenCalledWith("url");
    });

    it.each([{ segments: [] }, { segments: [{ text: "  " }] }])("rejects empty transcript $segments", async ({ segments }) => {
        client.fetch.mockResolvedValue(segments);
        await expect(new YouTubeAdapter().fetch("url")).rejects.toBeInstanceOf(TranscriptEmptyError);
    });

    it.each(["YoutubeTranscriptNotAvailableError", "YoutubeTranscriptDisabledError", "YoutubeTranscriptInvalidVideoIdError", "YoutubeTranscriptVideoUnavailableError", "UnexpectedError"])("maps %s to not found", async name => {
        client.fetch.mockRejectedValue(Object.assign(new Error("fixture failure"), { name }));
        await expect(new YouTubeAdapter().fetch("url")).rejects.toBeInstanceOf(TranscriptNotFoundError);
    });

    it.each([false, true])("parses Gemini JSON, including fenced output=%s, and preserves model/prompt", async fenced => {
        const wisdom = { summary: "fixture", ideas: [], quotes: [], references: [] };
        const json = JSON.stringify(wisdom);
        client.generate.mockResolvedValue({ response: { text: () => fenced ? `\u0060\u0060\u0060json\n${json}\n\u0060\u0060\u0060` : json, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } } });
        const log = vi.spyOn(console, "log");
        expect(await new GeminiAdapter("fixture-key").extractWisdom("transcript", "es", "pt")).toEqual(wisdom);
        expect(client.model).toHaveBeenCalledWith({ model: "gemini-2.5-flash", systemInstruction: getSystemInstruction("es", "pt"), generationConfig: { responseMimeType: "application/json" } });
        expect(client.generate).toHaveBeenCalledWith("transcript");
        expect(log).toHaveBeenCalledWith("[INFO] Gemini Token Usage: Input=10, Output=20, Total=30");
        log.mockRestore();
    });

    it.each(["", "not JSON", "{invalid}"])("preserves external error for invalid model output %s", async text => {
        client.generate.mockResolvedValue({ response: { text: () => text } });
        await expect(new GeminiAdapter("fixture-key").extractWisdom("text", "en", "en")).rejects.toThrow("Failed to extract wisdom");
    });

    it("preserves the provider exception boundary", async () => {
        client.generate.mockRejectedValue(new Error("provider unavailable"));
        await expect(new GeminiAdapter("fixture-key").extractWisdom("text", "en", "en")).rejects.toThrow("Failed to extract wisdom");
    });
});

describe("URL validation", () => {
    it.each(["youtu.be/fixture", "http://youtu.be/fixture", " https://youtu.be/fixture "])("normalizes %s", url => {
        expect(validateAndNormalizeYouTubeUrl(url)).toBe("https://youtu.be/fixture");
    });
    it.each(["", "https://evil.example/video", "https://youtube.com.evil.example/video", "https://evil.example@youtube.com.evil.example/video"])("rejects %s", url => {
        expect(() => validateAndNormalizeYouTubeUrl(url)).toThrow("Invalid URL:");
    });
});

describe("environment schema with real Zod and isolated environment", () => {
    // Node 24 strips this config's types without a tsx loader or a prior build.
    // Bound the child first, leaving time for diagnostics under container load.
    const processTimeout = 10_000;
    const caseTimeout = 15_000;

    function loadConfig(env: NodeJS.ProcessEnv = {}, temporaryRoot = tmpdir()) {
        const cwd = mkdtempSync(join(temporaryRoot, "wisdom-config-"));
        const configUrl = new URL("../src/infra/config/index.ts", import.meta.url).href;
        try {
            const started = performance.now();
            const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
                import { readdirSync } from 'node:fs';
                const emptyCwd = readdirSync('.').length === 0;
                const { config } = await import(${JSON.stringify(configUrl)});
                console.log(JSON.stringify({
                    emptyCwd, PORT: config.PORT, SOLANA_NETWORK_ID: config.SOLANA_NETWORK_ID,
                    googleKeyMatches: config.GOOGLE_API_KEY === 'test-key',
                    walletMatches: config.RESOURCE_WALLET_ADDRESS === 'test-wallet',
                    kobaruKeyAbsent: config.KOBARU_API_KEY === undefined
                }));
            `], {
                cwd, encoding: "utf8", env,
                timeout: processTimeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024
            });
            // Neither config values nor child output belong in diagnostics, even on failure.
            const diagnostic = JSON.stringify({
                elapsedMs: Math.round(performance.now() - started),
                status: result.status, signal: result.signal,
                errorCode: result.error && "code" in result.error ? result.error.code : undefined,
                stdoutBytes: Buffer.byteLength(result.stdout ?? ""),
                stderrBytes: Buffer.byteLength(result.stderr ?? "")
            });
            console.info(`[config subprocess] ${diagnostic}`);
            expect(result.error === undefined, diagnostic).toBe(true);
            expect(result.signal, diagnostic).toBeNull();
            expect(result.status, diagnostic).not.toBeNull();
            return { ...result, diagnostic, cwd };
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    }

    it("validates required values and retains defaults", { timeout: caseTimeout }, () => {
        const result = loadConfig({ GOOGLE_API_KEY: "test-key", RESOURCE_WALLET_ADDRESS: "test-wallet" });
        expect(result.status, result.diagnostic).toBe(0);
        expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toEqual({ emptyCwd: true, googleKeyMatches: true, walletMatches: true, kobaruKeyAbsent: true, PORT: "3000", SOLANA_NETWORK_ID: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" });
    });

    it.each([{}, { GOOGLE_API_KEY: "", RESOURCE_WALLET_ADDRESS: "" }])("fails fast for missing/empty credentials %j", { timeout: caseTimeout }, env => {
        const result = loadConfig(env);
        expect(result.status, result.diagnostic).toBe(1);
        expect(result.stderr).toContain("GOOGLE_API_KEY:");
        expect(result.stderr).toContain("RESOURCE_WALLET_ADDRESS:");
        if (env.GOOGLE_API_KEY === "") {
            expect(result.stderr).toContain("GOOGLE_API_KEY is required");
            expect(result.stderr).toContain("RESOURCE_WALLET_ADDRESS is required");
        }
    });

    it("ignores an ambient dotenv file and never emits its dummy credentials", { timeout: caseTimeout }, () => {
        const ambient = mkdtempSync(join(tmpdir(), "wisdom-ambient-"));
        const sentinel = "SEC01_SYNTHETIC_AMBIENT_CREDENTIAL";
        try {
            writeFileSync(join(ambient, ".env"), `GOOGLE_API_KEY=${sentinel}\nKOBARU_API_KEY=${sentinel}\nRESOURCE_WALLET_ADDRESS=${sentinel}\n`);
            const result = loadConfig({ GOOGLE_API_KEY: "test-key", RESOURCE_WALLET_ADDRESS: "test-wallet" }, ambient);
            expect(result.status, result.diagnostic).toBe(0);
            expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toMatchObject({ emptyCwd: true, googleKeyMatches: true, walletMatches: true, kobaruKeyAbsent: true });
            expect(result.cwd).not.toBe(ambient);
            for (const output of [result.stdout, result.stderr, result.diagnostic]) {
                expect(output.includes(sentinel)).toBe(false);
                expect(output.includes("test-key")).toBe(false);
                expect(output.includes("test-wallet")).toBe(false);
            }
        } finally {
            rmSync(ambient, { recursive: true, force: true });
        }
    });
});
