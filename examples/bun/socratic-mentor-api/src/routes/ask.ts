import { Hono } from "hono";
import { v7 } from "uuid";
import { z } from "zod";
import { x402ResourceServer, x402HTTPResourceServer } from "@x402/hono";
import { encodePaymentRequiredHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { StateManager } from "../lib/state.js";
import { calculatePrice, priceToAtomicUnits, formatPrice, MAX_HISTORY_MESSAGE_CHARS, MAX_HISTORY_MESSAGES, truncateHistoryMessage } from "../lib/pricing.js";
import { generateSocraticResponse } from "../lib/ai.js";
import { AppConfig } from "../app.js";
import { AskRequestSchema, validateSignatureHash } from "../lib/validation.js";
import { Errors } from "../lib/errors.js";

/**
 * x402-balance extension per x402 v2 spec.
 * Advertises balance management capabilities to machine clients.
 */
/**
 * x402-balance extension per x402 v2 spec.
 * Advertises balance management capabilities to machine clients (Agents).
 * 
 * Machine clients read this to understand:
 * 1. supportsTopup: If I pay more than required, do I get credit? (Yes)
 * 2. supportsBalance: Does this API keep a ledger for me? (Yes)
 * 3. identityMechanism: How do I prove who I am later? (By reusing the payment proof/signature)
 */
const X402_BALANCE_EXTENSION = {
    "x402-balance": {
        info: {
            supportsTopup: true,
            supportsBalance: true,
            identityMechanism: "previous-proof",
            description: "This API manages an internal balance. Overpayments are credited. Reuse your payment proof (signature) in subsequent requests for identity verification."
        },
        schema: {
            type: "object",
            properties: {
                supportsTopup: { type: "boolean", description: "API credits overpayments to user balance" },
                supportsBalance: { type: "boolean", description: "API maintains per-user balance ledger" },
                identityMechanism: { type: "string", enum: ["previous-proof"], description: "How to identify returning users" },
                description: { type: "string", description: "Human-readable explanation" }
            }
        }
    }
};

/**
 * Creates the /ask route with all dependencies injected.
 * Uses "Optimistic Service" pattern:
 * - We verify the PROMISE of payment (valid signature) + Internal Balance
 * - We render service IMMEDIATELY (low latency)
 * - We settle the payment ASYNCHRONOUSLY (background)
 */

/**
 * Helper to decode x402 header safely and extract signature.
 * Validates the signature to prevent injection attacks.
 */
function getSignatureFromHeader(header: string): string | null {
    if (!header || !header.startsWith("x402 ")) return null;
    try {
        const token = header.split(" ")[1];
        const json = JSON.parse(atob(token));
        const proof = json.proof || null;

        // Validate signature format to prevent injection via SQL or logs
        if (proof) {
            validateSignatureHash(proof);
        }

        return proof;
    } catch (e) {
        // Invalid signature format or validation failed
        return null;
    }
}

export function createAskRoute(
    config: AppConfig,
    stateManager: StateManager,
    resourceServer: x402ResourceServer,
    assetMetadata: { decimals: number; name: string; version: string }
) {
    const app = new Hono();

    // Define payment-protected route config
    // We use the "Exact EVM" scheme, meaning the client must pay an exact amount of tokens
    // on the specified EVM network.
    // 
    // This generator function creates the 402 Accepted Parameters dynamically based on the deficit.
    const getPaymentOptions = (deficitAtomic: string, deficitFormatted: string) => [{
        scheme: "exact" as const,
        price: {
            amount: deficitAtomic,
            asset: config.skaleAssetAddress || "0xUSDC",
            extra: {
                name: assetMetadata.name,
                version: assetMetadata.version
            }
        },
        network: config.skaleNetworkId as any,
        asset: config.skaleAssetAddress || "0xUSDC",
        payTo: config.skaleWalletAddress as string,
        maxTimeoutSeconds: 300, // Payment valid for 5 minutes
        description: `Socratic Consultation (${deficitFormatted})`
    }];

    app.post("/", async (c) => {
        const requestId = c.get("requestId") || "unknown";
        console.log(`[${new Date().toISOString()}] [${requestId}] [Ask] Received request`);

        // ---------------------------------------------------------
        // 1. Parse Body, Validate & Sanitize Input (Security Protection)
        // ---------------------------------------------------------
        let body;
        try {
            body = await c.req.json();
        } catch (e) {
            return Errors.invalidJson(c);
        }

        // Validate and sanitize all user inputs using Zod schema
        // This prevents SQL injection, prompt injection, XSS, and other attacks
        const parsed = AskRequestSchema.safeParse(body);
        if (!parsed.success) {
            console.log(`[${new Date().toISOString()}] [Ask] Validation failed:`, parsed.error.issues);
            return Errors.invalidInput(c, parsed.error.issues.map(e => ({ path: e.path.join('.'), message: e.message })));
        }

        // All inputs are now validated and sanitized
        const { message, session_id, main_goal } = parsed.data;

        // Calculate Price on ACTUAL body
        // Unlike typical APIs with fixed prices, we charge based on "Work Done" (Input + Context size).
        // This ensures the service remains profitable even for long conversations.
        const price = calculatePrice(message);
        const priceAtomic = BigInt(priceToAtomicUnits(price, assetMetadata.decimals));

        console.log(`[${new Date().toISOString()}] [Ask] Required Price: ${formatPrice(price)} (${priceAtomic} atomic units)`);


        // ---------------------------------------------------------
        // 2. Identify User & Determine Payment Status
        // ---------------------------------------------------------

        let walletAddress: string | null = null;
        let newPaymentAmount = 0n;
        let paymentPayload: any = null;
        let paymentRequirements: any = null;
        let signatureHash: string | null = null;

        const authHeader = c.req.header("Authorization");
        const paymentSignatureHeader = c.req.header("payment-signature") || c.req.header("PAYMENT-SIGNATURE");
        const signature = authHeader ? getSignatureFromHeader(authHeader) : null;

        // Log raw headers for testing/debugging
        if (authHeader) {
            console.log(`[${new Date().toISOString()}] [Ask] Authorization Header (for curl testing): ${authHeader}`);
        }
        if (paymentSignatureHeader) {
            console.log(`[${new Date().toISOString()}] [Ask] PAYMENT-SIGNATURE Header (extracted or direct): ${paymentSignatureHeader}`);
        }

        // A. Check Ledger (Identity Path)
        if (signature) {
            // Use signature as hash/key directly
            signatureHash = signature;
            const existingPayment = stateManager.getPayment(signatureHash);

            if (existingPayment) {
                console.log(`[${new Date().toISOString()}] [Ask] Known signature. Wallet: ${existingPayment.wallet_address}`);
                walletAddress = existingPayment.wallet_address;
                // It's an old payment, so it contributes 0 to "New Payment Amount"
                // But it identifies the user, allowing access to their Balance.
            }
        }

        // B. Check Facilitator (New Payment Path)
        // If we haven't identified via ledger, verify the payment with the facilitator.
        // We decode the payment upfront and verify directly using the payment's `accepted` requirements.
        //
        // NOTE: We trust `accepted` (what the user *claims* they paid) during verification,
        // but we verify the cryptographic proof of that claim with the Facilitator.
        // This allows "Overpayments" (User claims to pay 100, Service required 50) to be processed correctly.
        // We will "Settle" this payment later to actually collect the funds and credit the surplus.

        if (!walletAddress && paymentSignatureHeader) {
            console.log(`[${new Date().toISOString()}] [Ask] Signature not in ledger. Verifying with Facilitator...`);

            try {
                // Decode the payment payload from the PAYMENT-SIGNATURE header
                const decodedPayload = decodePaymentSignatureHeader(paymentSignatureHeader);
                const acceptedRaw = (decodedPayload as any).accepted;

                if (acceptedRaw) {
                    // Normalize all numeric fields that facilitator expects as strings
                    const normalizedAccepted = {
                        ...acceptedRaw,
                        amount: String(acceptedRaw.amount)
                    };

                    // Also normalize payload.authorization.value
                    const rawPayload = (decodedPayload as any).payload || {};
                    const rawAuth = rawPayload.authorization || {};
                    const normalizedPayload = {
                        ...decodedPayload as any,
                        accepted: normalizedAccepted,
                        payload: {
                            ...rawPayload,
                            authorization: {
                                ...rawAuth,
                                value: String(rawAuth.value || "0")
                            }
                        }
                    };

                    // Verify using normalized payload and requirements.
                    // Facilitator checks: Signature is valid, Payment is for us, Network is correct.
                    const verifyResult = await resourceServer.verifyPayment(normalizedPayload, normalizedAccepted);

                    if (verifyResult.isValid) {
                        console.log(`[${new Date().toISOString()}] [Ask] Payment verified successfully via Facilitator.`);
                        paymentPayload = normalizedPayload;
                        paymentRequirements = normalizedAccepted;

                        // Extract wallet and amount - x402 v2 uses "value" in authorization
                        walletAddress = (decodedPayload as any)?.payload?.authorization?.from;
                        const paidAmountStr = (decodedPayload as any)?.payload?.authorization?.value || "0";
                        newPaymentAmount = BigInt(paidAmountStr);

                        // Get signature hash to save later
                        try {
                            signatureHash = (decodedPayload as any)?.payload?.signature;
                            if (signatureHash) {
                                validateSignatureHash(signatureHash);
                            }
                        } catch (e) {
                            console.error("Invalid signature hash format:", e);
                            signatureHash = null;
                        }

                        console.log(`[${new Date().toISOString()}] [Ask] Payment Verified. Wallet: ${walletAddress}, Amount: ${newPaymentAmount}`);
                    } else {
                        console.log(`[${new Date().toISOString()}] [Ask] Facilitator verification failed: ${verifyResult.invalidReason}`);
                    }
                } else {
                    console.log(`[${new Date().toISOString()}] [Ask] Payment payload missing 'accepted' requirements.`);
                }
            } catch (e) {
                console.error(`[${new Date().toISOString()}] [Ask] Error decoding/verifying payment:`, e);
            }
        } else if (!walletAddress) {
            console.log(`[${new Date().toISOString()}] [Ask] No payment signature provided.`);
        }


        // Initialize HTTP Server for settlement (needed later for async settlement)
        const httpServer = new x402HTTPResourceServer(resourceServer, {
            "POST /ask": {
                accepts: getPaymentOptions(priceAtomic.toString(), formatPrice(price)),
                description: "Socratic Consultation",
                mimeType: "application/json"
            }
        });
        await httpServer.initialize();

        // ---------------------------------------------------------
        // 3. Balance Checks & "Partial" Reservation
        // ---------------------------------------------------------

        // We determine how much of the Cost must come from the EXISTING balance.
        // Logic:
        // 1. Total Cost = priceAtomic
        // 2. Incoming Payment = newPaymentAmount
        // 3. Deficit = max(0, Total Cost - Incoming Payment)
        //
        // If the user sends a new payment that covers the full cost, amountFromBalance is 0.
        // If they send NO payment (Auth only), amountFromBalance is the full price.
        // If they send a partial payment, amountFromBalance is the remainder.

        const amountFromBalance = priceAtomic > newPaymentAmount
            ? priceAtomic - newPaymentAmount
            : 0n;

        // Reserve the required amount from balance
        if (amountFromBalance > 0n) {
            if (!walletAddress || !stateManager.deductBalance(walletAddress, amountFromBalance)) {
                // Insufficient Funds in Balance to cover the difference
                console.log(`[${new Date().toISOString()}] [Ask] Insufficient funds. Balance Cover Needed: ${amountFromBalance}`);

                // For 402, we calculate Total Deficit the user needs to pay.
                // Deficit = Price - (Balance + NewPayment)
                // This tells the user EXACTLY how much MORE they need to send.
                //
                // e.g. Price=100, Balance=30, NewPayment=20.
                // Available=50. Deficit=50.
                // User receives 402 asking for 50.

                const currentBalance = walletAddress ? stateManager.getBalance(walletAddress) : 0n;
                const totalAvailable = currentBalance + newPaymentAmount;
                const deficit = priceAtomic - totalAvailable;

                // Format deficit
                const deficitSafe = deficit > 0n ? deficit : priceAtomic;
                const deficitFloat = Number(deficitSafe) / Math.pow(10, assetMetadata.decimals);
                const options = getPaymentOptions(deficitSafe.toString(), formatPrice(deficitFloat));

                // Build x402 v2 compliant PaymentRequired response
                const paymentRequired = {
                    x402Version: 2 as const,
                    error: "Insufficient Balance",
                    resource: {
                        url: c.req.url,
                        description: "Socratic Consultation",
                        mimeType: "application/json"
                    },
                    accepts: options.map(opt => ({
                        scheme: opt.scheme,
                        network: opt.network,
                        amount: opt.price.amount,
                        asset: opt.asset,
                        payTo: opt.payTo,
                        maxTimeoutSeconds: opt.maxTimeoutSeconds,
                        extra: opt.price.extra
                    })),
                    extensions: X402_BALANCE_EXTENSION
                };

                // console.log(`[${new Date().toISOString()}] [Ask] Returning 402 Response:`, JSON.stringify(paymentRequired, null, 2));

                // Set PAYMENT-REQUIRED header (x402 v2 spec)
                c.header("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));

                return c.json(paymentRequired, 402 as any);
            }
        }

        // At this point:
        // 1. We have reserved `amountFromBalance` (if any) from the internal ledger.
        // 2. We have a "Promise" of `newPaymentAmount` (if any) to cover the rest/add surplus.

        // ---------------------------------------------------------
        // 4. Render Service (Optimistic)
        // ---------------------------------------------------------
        // We have successfully verified that the user HAS funds (Balance reserved OR Valid Payment Signature).
        // We now proceed to generate the AI response IMMEDIATELY.
        //
        // Why not wait for Settlement?
        // - Settlement involves blockchain/facilitator calls that can be slow (seconds).
        // - AI generation is already slow (seconds).
        // - Serializing them (Settlement -> AI) doubles the latency.
        // - By running parallel (AI starts now, Settlement happens in background), we give the best UX.
        //
        // Risk:
        // - If settlement fails LATER, we gave away one AI response for free.
        // - This is an acceptable business risk (micro-transaction value).
        // - We mitigate this by NOT crediting the users balance until settlement succeeds.

        console.log(`[${new Date().toISOString()}] [Ask] Payment Validated (Balance Reserved: ${amountFromBalance}, Pending Settlement: ${newPaymentAmount}). Processing...`);

        // Load Context
        let state = { history: [] as Array<{ role: 'user' | 'model', content: string }>, main_goal: main_goal || "General Socratic Inquiry", context_state: "" };
        let currentSessionId = session_id || v7();

        if (session_id && walletAddress) {
            const contextKey = `${walletAddress}:${session_id}`;
            const loaded = stateManager.get(contextKey);
            if (loaded) {
                state = loaded as any;
                console.log(`[${new Date().toISOString()}] [Ask] Loaded Existing Session Context: ${contextKey}`);
            } else {
                console.log(`[${new Date().toISOString()}] [Ask] Session ID provided but not found for wallet. Starting new context: ${contextKey}`);
            }
        } else {
            console.log(`[${new Date().toISOString()}] [Ask] New Session Created: ${currentSessionId}`);
        }

        try {
            const aiResponse = await generateSocraticResponse(
                message,
                state.history || [],
                state.context_state || "",
                state.main_goal || main_goal || "",
                config.googleApiKey
            );

            // Update History logic...
            const newHistory = [
                ...(state.history || []),
                { role: "user" as const, content: truncateHistoryMessage(message) },
                { role: "model" as const, content: truncateHistoryMessage(aiResponse.reply) }
            ].slice(-MAX_HISTORY_MESSAGES);

            // Save Context
            if (walletAddress) {
                const contextKey = `${walletAddress}:${currentSessionId}`;
                await stateManager.save(contextKey, aiResponse.context_state, newHistory, aiResponse.main_goal || state.main_goal);
            }

            // ---------------------------------------------------------
            // 5. Async Settlement & Surplus Credit
            // ---------------------------------------------------------

            if (walletAddress && newPaymentAmount > 0n && paymentPayload) {
                // We handle settlement in the background to avoid blocking the response.
                //
                // Logic:
                // 1. Process Settlement (Collect the funds).
                // 2. If Successful:
                //    - Record the payment signature (prevents replay, establishes identity).
                //    - Calculate Surplus (NewPayment - Cost_Covered_By_Payment).
                //    - Credit Surplus to User Balance.
                //
                // Note: If we reserved ANY amount from balance (amountFromBalance > 0), 
                // it implies NewPayment < Price, so Surplus is definitely 0.
                // Surplus only exists if NewPayment > Price.

                const surplusToCredit = newPaymentAmount > priceAtomic
                    ? newPaymentAmount - priceAtomic
                    : 0n;

                console.log(`[${new Date().toISOString()}] [Ask] Triggering Async Settlement for ${newPaymentAmount}...`);

                httpServer.processSettlement(paymentPayload, paymentRequirements || {})
                    .then((settlement) => {
                        if (settlement.success) {
                            console.log(`[${new Date().toISOString()}] [Ask] Settlement Successful.`);
                            // Record Payment
                            if (signatureHash) stateManager.recordPayment(signatureHash, walletAddress!);

                            // Credit Surplus ONLY
                            if (surplusToCredit > 0n) {
                                stateManager.adjustBalance(walletAddress!, surplusToCredit);
                                console.log(`[${new Date().toISOString()}] [Ask] Credited Surplus: ${surplusToCredit}`);
                            }
                        } else {
                            console.error(`[${new Date().toISOString()}] [${requestId}] [Ask] Settlement Failed`, {
                                wallet: walletAddress,
                                signatureHash,
                                amount: newPaymentAmount.toString(),
                                timestamp: new Date().toISOString(),
                                reason: "Settlement returned success: false"
                            });
                            // We do NOT credit. 
                            // We accepted the risk of the service cost (implied by "Optimistic").
                            // But we specifically do NOT credit the surplus, preventing fake balance.
                        }
                    })
                    .catch(err => {
                        console.error(`[${new Date().toISOString()}] [${requestId}] [Ask] Settlement Error`, {
                            wallet: walletAddress,
                            signatureHash,
                            amount: newPaymentAmount.toString(),
                            timestamp: new Date().toISOString(),
                            error: err.message || String(err)
                        });
                    });
            }

            // Current Balance for Header
            // We can't include the "Pending Surplus" because it's not settled.
            // We can include the "Remaining Balance" (Current - Deducted).
            // This is accurate to what is available RIGHT NOW.

            const remainingBalance = walletAddress ? stateManager.getBalance(walletAddress) : 0n;
            c.header("X-Balance-Remaining", remainingBalance.toString());

            return c.json({
                reply: aiResponse.reply,
                session_id: currentSessionId
            });

        } catch (e) {
            // Safety Net:
            // If the AI service fails/crashes, we must REFUND the balance we reserved.
            // Since settlement hasn't happened yet, we just add the reserved amount back.
            if (amountFromBalance > 0n && walletAddress) {
                stateManager.adjustBalance(walletAddress, amountFromBalance);
                console.log(`[${new Date().toISOString()}] [Ask] Refunded ${amountFromBalance} to ${walletAddress} due to AI service error.`);
            }
            console.error("AI Service Error:", e);
            return Errors.aiUnavailable(c);
        }
    });

    return app;
}
