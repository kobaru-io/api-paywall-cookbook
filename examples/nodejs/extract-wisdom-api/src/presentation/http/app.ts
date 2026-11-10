import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import type { HTTPRequestContext } from "@x402/core/http";
import { Network } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { enrichDiscoveryExtension } from "./discovery-helper.js";
import { config } from "../../infra/config/index.js";
import { WisdomService } from "../../core/usecases/WisdomService.js";
import { TranscriptNotFoundError, TranscriptEmptyError, InvalidUrlError } from "../../core/entities/Errors.js";
import { validateAndNormalizeYouTubeUrl } from "../../core/validation/UrlValidator.js";
import { YouTubeAdapter } from "../../infra/adapters/YouTubeAdapter.js";
import { GeminiAdapter } from "../../infra/adapters/GeminiAdapter.js";
import { InMemoryStorage } from "../../infra/adapters/InMemoryStorage.js";

// ==========================================
// 1. DEPENDENCY INJECTION (Composition Root)
// ==========================================
// In Clean Architecture, we "inject" the dependencies (adapters) into our core services.
// This makes the code modular and easy to test. For example, we could easily swap 
// VertexAI for OpenAI or YouTubeAdapter for a text file reader without changing the core logic.

// Initialize Adapters (Infrastructure Layer)
// - YouTubeAdapter: Knows how to talk to YouTube.
// - GeminiAdapter: Knows how to talk to Google Gemini (via API Key).
// - InMemoryStorage: A simple cache to store transcripts (avoids fetching the same video twice).
const memoryStorage = new InMemoryStorage();
const youtubeAdapter = new YouTubeAdapter();
const vertexAIAdapter = new GeminiAdapter(config.GOOGLE_API_KEY);

// Initialize Core Service (Application Layer)
// The Service gets the adapters it needs to do its job (Business Logic).
const wisdomService = new WisdomService(youtubeAdapter, vertexAIAdapter, memoryStorage);

// ==========================================
// 2. SETUP X402 FACILITATOR & SERVER
// ==========================================
// This is the magic that enables the paywall. 
// We use the @x402/hono library to integrate with the Hono web framework.

// The Facilitator is the trusted third-party that verifies payments.
// We connect to the public Kobaru facilitator or a self-hosted one to check proofs.
const facilitatorClient = new HTTPFacilitatorClient({
    url: config.FACILITATOR_URL,
    createAuthHeaders: async () => {
        const headers: Record<string, string> = {};
        if (config.KOBARU_API_KEY) {
            headers["Authorization"] = `Bearer ${config.KOBARU_API_KEY}`;
        }
        return {
            verify: headers,
            settle: headers,
            supported: headers
        };
    }
});

// Log API Key usage status
if (config.KOBARU_API_KEY) {
    console.log("[INFO] 🟢 Kobaru API Key configured. Using authenticated facilitator requests.");
} else {
    console.log("[WARN] 🟡 No Kobaru API Key found. Facilitator requests will be unauthenticated.");
}

// The ResourceServer is our gatekeeper. It holds the rules for checking payments.
// We register the "ExactSvmScheme", which means we expect exact payments on the Solana Virtual Machine (SVM).
const resourceServer = new x402ResourceServer(facilitatorClient);
resourceServer.register(config.SOLANA_NETWORK_ID as Network, new ExactSvmScheme());
resourceServer.registerExtension(bazaarResourceServerExtension);

// Log Facilitator Responses
resourceServer
    .onAfterVerify(async ({ result }) => {
        console.log(`[INFO] ✅ Payment Verified used facilitator:`, JSON.stringify(result, null, 2));
    })
    .onVerifyFailure(async ({ error }) => {
        console.error(`[ERROR] ❌ Payment Verification Failed:`, error);
    })
    .onAfterSettle(async ({ result }) => {
        console.log(`[INFO] 💰 Payment Settled:`, JSON.stringify(result, null, 2));
    })
    .onSettleFailure(async ({ error }) => {
        console.error(`[ERROR] ❌ Settlement Failed:`, error);
    });

// ==========================================
// 3. WEB SERVER SETUP (Hono)
// ==========================================
const app = new Hono();

// Enable CORS so this API can be called from browsers (e.g. our 007 Agent or a frontend app)
// The wildcard "*" allows any domain to access it. In production, you might restrict this.
// Enable CORS so this API can be called from browsers (e.g. our 007 Agent or a frontend app)
// The wildcard "*" allows any domain to access it. In production, you might restrict this.
app.use("/*", cors());

// LOGGING MIDDLEWARE
app.use("*", async (c, next) => {
    const start = Date.now();
    const { method, url } = c.req;
    console.log(`[INFO] Incoming Request: ${method} ${url}`);

    if (method === "POST" || method === "PUT") {
        try {
            // Clone the request to read body without consuming it if necessary, 
            // though Hono's req.json() is cached.
            const body = await c.req.json();
            console.log(`[INFO] Request Body:`, JSON.stringify(body, null, 2));
        } catch (e) {
            // Ignore body parsing errors (might be empty or not JSON)
        }
    }

    await next();

    const duration = Date.now() - start;
    console.log(`[INFO] Completed Request: ${method} ${url} - Status: ${c.res.status} - Duration: ${duration}ms`);
});

/**
 * GET /
 * Simple health check and introduction.
 */
app.get("/", (c) => {
    return c.json({
        name: "Wizard's Wisdom API",
        message: "You shall not pass... without paying the x402 fee!",
        usage: "POST /wisdom { url: 'https://youtube.com/...' }"
    });
});

// ==========================================
// 4. DEFINE PAYMENT CONFIGURATION
// ==========================================
// We use a dynamic configuration to calculate price based on video length.
// This object tells the middleware HOW to charge for the endpoint.
async function prepareWisdomPrice(body: { url?: string } | undefined): Promise<string> {
    try {
        if (!body || !body.url) {
            return "0.01";
        }

        const sanitizedUrl = validateAndNormalizeYouTubeUrl(body.url);
        const result = await wisdomService.prepareForWisdom(sanitizedUrl);
        return result.price.amount;
    } catch (error) {
        if (error instanceof InvalidUrlError) {
            throw new HTTPException(400, { message: error.message });
        }
        if (error instanceof TranscriptNotFoundError) {
            throw new HTTPException(404, { message: error.message });
        }
        if (error instanceof TranscriptEmptyError) {
            throw new HTTPException(500, { message: error.message });
        }
        throw error;
    }
}

const wisdomPaymentConfig = {
    accepts: {
        scheme: "exact" as const, // We want the exact amount
        network: config.SOLANA_NETWORK_ID as Network, // Network (e.g., "solana-devnet")
        asset: config.USDC_ASSET_ADDRESS, // Asset (USDC token address)
        payTo: config.RESOURCE_WALLET_ADDRESS, // Who receives the money (You!)
        maxTimeoutSeconds: 300, // 5 minutes for the user to complete payment
        extra: { // Optional but recommended metadata for the client
            name: "USDC",
            version: "2"
        },
        // DYNAMIC PRICING: Calculate price based on the video URL in the body
        // This function is called by the middleware Interceptor BEFORE the 402 is generated.
        price: async (context: HTTPRequestContext) => {
            const body = await context.adapter.getBody?.() as { url?: string } | undefined;
            return prepareWisdomPrice(body);
        }
    },
    description: "Wisdom extracted from YouTube video",
    mimeType: "application/json",
    extensions: enrichDiscoveryExtension({
        title: "Wizard's Wisdom API",
        method: "POST",
        bodyType: "json",
        input: {
            url: "https://www.youtube.com/watch?v=s41p7Fvj1h8",
            language: "en"
        },
        inputSchema: {
            properties: {
                url: {
                    type: "string",
                    description: "YouTube Video URL to extract wisdom from"
                },
                language: {
                    type: "string",
                    description: "Target language for the wisdom (e.g. 'en', 'es', 'pt')"
                }
            },
            required: ["url"]
        },
        output: {
            example: {
                summary: "A 25-word summary of the video content and presenter.",
                ideas: ["Key idea extracted from the content (16 words each)."],
                insights: ["Refined, abstracted insight from the content (16 words each)."],
                quotes: ["Notable quote from the speaker with attribution."],
                habits: ["Practical habit mentioned by the speaker (16 words each)."],
                facts: ["Interesting fact about the world mentioned (16 words each)."],
                references: ["Book, tool, or project mentioned by the speaker."],
                one_sentence_takeaway: "The most important 15-word takeaway from the content.",
                recommendations: ["Actionable recommendation from the content (16 words each)."]
            }
        },
        tags: ['ai', 'content-analysis', 'video-processing'],
        provider: {
            name: "Kobaru.io",
            description: "The team behind x402 protocol and the Wizard's Wisdom example.",
            url: "https://kobaru.io"
        }
    })
};

/**
 * POST /wisdom
 * The main endpoint. It implements the "402 Payment Required" flow using middleware.
 * 
 * FLOW:
 * 1. User sends a request with a YouTube URL.
 * 2. `paymentMiddleware` intercepts the request.
 * 3. `paymentMiddleware` calculates the price dynamically using the `wisdomPaymentConfig.accepts.price` callback above.
 * 4. If NO payment signature is present:
 *    - `paymentMiddleware` rejects the request with HTTP 402.
 *    - It sends back the `WWW-Authenticate` header with pricing and instructions.
 * 5. If YES payment (User paid and sent signature):
 *    - `paymentMiddleware` verifies the token with the Facilitator.
 *    - If valid, it passes control to the handler below.
 * 6. The handler proceeds to generate the wisdom.
 */
app.post(
    "/wisdom",
    async (c, next) => {
        // SDK 2.30 maps pricing exceptions to 500. Preserve input/transcript errors
        // before entering the payment flow; the dynamic callback reuses this quote.
        const body = await c.req.json().catch(() => undefined) as { url?: string } | undefined;
        await prepareWisdomPrice(body);
        await next();
    },
    paymentMiddleware(
        { "POST /wisdom": wisdomPaymentConfig }, // Route config for this specific endpoint
        resourceServer
    ),
    async (c) => {
        try {
            const { url, language } = await c.req.json();

            console.log("[INFO] Payment Approved");

            // Validate and normalize URL (double-check in case of edge cases)
            const sanitizedUrl = validateAndNormalizeYouTubeUrl(url);

            // ==========================================
            // 5. DELIVER RESOURCE (After Payment Verified)
            // ==========================================
            // If code reaches here, payment is CONFIRMED by the middleware!
            // We can now incur the cost of calling the expensive AI model.
            // We reuse the cached transcript (fetched during the pricing step) to extract wisdom.
            const wisdom = await wisdomService.getWisdom(sanitizedUrl, language);
            return c.json(wisdom);

        } catch (e: any) {
            // Error Handling:
            // If something goes wrong logic-wise, we return a 500.
            // (The middleware handles 401/402/403 errors automatically)

            console.error("Application Error:", e);
            const status = e.status || 500;
            return c.json({ error: e.message || "Internal Server Error" }, status);
        }
    }
);

export default app;
