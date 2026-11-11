import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createStateManager } from "./lib/state.js";
import { createGeneralRoutes } from "./routes/general.js";
import { createAskRoute } from "./routes/ask.js";
import { startPruningService } from "./services/cleanup.js";
import { requestIdMiddleware } from "./middleware/request-id.js";

export interface AppConfig {
    skaleWalletAddress?: string;
    skaleNetworkId?: string;
    skaleAssetAddress?: string;
    facilitatorUrl: string;
    kobaruApiKey?: string;
    dbPath?: string;
    googleApiKey?: string;
    port?: number;
    pruneInterval?: number; // Milliseconds, default 1 hour
    sessionMaxAge?: number; // Seconds, default 90 days
}

export async function createApp(config: AppConfig) {
    console.log("Creating App...");
    // Initialize the Hono app. Hono is used here because it is lightweight,
    // uses standard Web APIs (Request/Response), and works identically across
    // runtimes (Bun, Node.js, Cloudflare Workers).
    const app = new Hono();

    // 1. Initialize Middleware
    // -------------------------------------------------------------------------
    // Request ID Middleware:
    // Adds a unique ID to every request. This is CRITICAL for distributed tracing,
    // especially in payment systems where you need to correlate logs across
    // multiple services (Client -> API -> Facilitator -> Blockchain).
    app.use("*", requestIdMiddleware());

    // Security Headers:
    // Sets strict security headers (HSTS, No-Sniff, CSP) to prevent common
    // web attacks. Even though this is an API, these headers help protect
    // any browser-based clients or dashboards interacting with it.
    app.use("*", secureHeaders({
        strictTransportSecurity: "max-age=31536000; includeSubDomains",
        xContentTypeOptions: "nosniff",
        xFrameOptions: "DENY",
        contentSecurityPolicy: {
            defaultSrc: ["'self'"]
        }
    }));

    // CORS (Cross-Origin Resource Sharing):
    // We allow ALL origins (*) because this is a PUBLIC PAIIAPI (Payment-Gated API).
    // Access control is enforced via Payments (x402), not by origin.
    // - Most clients are backend agents/servers, which bypass CORS anyway.
    // - We want browser-based agents from any website to be able to pay and use the API.
    // - CSRF is not a risk because we use Header-based authentication (Authorization/Payment-Signature),
    //   not cookies.
    app.use("*", cors());

    // Custom Logger:
    // Wraps standard logging with the Request ID for traceability.
    app.use("*", async (c, next) => {
        const requestId = c.get("requestId") || "unknown";
        console.log(`[${new Date().toISOString()}] [${requestId}] ${c.req.method} ${c.req.path}`);
        await next();
        console.log(`[${new Date().toISOString()}] [${requestId}] Completed ${c.req.method} ${c.req.path} - Status: ${c.res.status}`);
    });

    const stateManager = createStateManager(config.dbPath);

    // 2. Start Background Services
    // -------------------------------------------------------------------------
    // Privacy & Hygiene:
    // We periodically prune old sessions and payment records to respect user privacy
    // (Right to be Forgotten) and keep the database performant.
    // Default: Prune every hour, keep sessions for 90 days.
    const PRUNE_INTERVAL = config.pruneInterval || 1000 * 60 * 60; // 1 Hour
    const MAX_AGE_SECONDS = config.sessionMaxAge || 60 * 60 * 24 * 90; // 90 Days

    startPruningService(stateManager, PRUNE_INTERVAL, MAX_AGE_SECONDS);

    // 3. Setup x402 Support
    // -------------------------------------------------------------------------
    // The Facilitator Client is how we talk to the x402 network to:
    // 1. Fetch supported payment methods (tokens, networks).
    // 2. Verify payment proofs provided by clients.
    const facilitatorClient = new HTTPFacilitatorClient({
        url: config.facilitatorUrl,
        createAuthHeaders: config.kobaruApiKey
            ? async () => {
                const headers = { "x-api-key": config.kobaruApiKey! };
                return {
                    supported: headers,
                    verify: headers,
                    settle: headers,
                };
            }
            : undefined
    });

    // The Resource Server enforces payment policies.
    const resourceServer = new x402ResourceServer(facilitatorClient);

    // CRITICAL: Wallet and network configuration is required for paid API.
    // This defines WHERE we receive the money.
    // networkId: e.g. "eip155:1"
    if (!config.skaleWalletAddress || !config.skaleNetworkId) {
        throw new Error(
            "FATAL: Missing required payment configuration. " +
            "SKALE_WALLET_ADDRESS and SKALE_NETWORK_ID environment variables must be set."
        );
    }
    // Register the "Exact EVM" payment scheme (Pay exactly X amount on EVM chain).
    resourceServer.register(config.skaleNetworkId as any, new ExactEvmScheme());

    // 4. Fetch Asset Decimals
    // -------------------------------------------------------------------------
    // We must query the facilitator to know the "Decimals" of the token we are accepting.
    // e.g. USDC has 6 decimals (1.0 = 1,000,000 atomic units).
    // If we calculate this wrong, we might charge $1,000,000 instead of $1.00!
    let assetMetadata = { decimals: 6, name: "USDC", version: "1" };
    try {
        console.log("Fetching Supported Assets from Facilitator...");
        const supported = await facilitatorClient.getSupported();

        if (!supported.kinds || supported.kinds.length === 0) {
            throw new Error("Facilitator returned no supported payment methods");
        }

        const networkData = supported.kinds.find((k: any) => k.network === config.skaleNetworkId);
        if (!networkData) {
            throw new Error(
                `Facilitator does not support network: ${config.skaleNetworkId}. ` +
                `Available networks: ${supported.kinds.map((k: any) => k.network).join(", ")}`
            );
        }

        if (networkData.extra) {
            assetMetadata = {
                decimals: (networkData.extra.decimals as number) || 6,
                name: (networkData.extra.name as string) || "USDC",
                version: (networkData.extra.version as string) || "1"
            };
        }
        console.log("✅ Asset metadata loaded:", assetMetadata);
    } catch (e) {
        // If we can't configure payments, we should crash early rather than running
        // in a broken state where we might give away service for free or reject valid money.
        throw new Error(
            `FATAL: Cannot reach facilitator at ${config.facilitatorUrl}. ` +
            `Payments will not work. Error: ${e instanceof Error ? e.message : String(e)}`
        );
    }

    // 5. Register Routes
    // -------------------------------------------------------------------------

    // General Routes: Health checks, index page.
    app.route("/", createGeneralRoutes());

    // Ask Route (Protected):
    // This is the core logic. We inject dependencies (state, payments, config)
    // so the route handler remains pure and testable.
    app.route("/ask", createAskRoute(config, stateManager, resourceServer, assetMetadata));

    console.log("App Created!");

    // Return app and cleanup function for graceful shutdown
    return {
        app,
        stateManager,
        shutdown: () => {
            console.log("Shutting down gracefully...");
            stateManager.close();
            console.log("Database connection closed.");
        }
    };
}
