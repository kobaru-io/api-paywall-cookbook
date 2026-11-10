/**
 * ============================================================================
 * 007 TEST AGENT - UNIVERSAL X402 API TESTING TOOL
 * ============================================================================
 *
 * MISSION BRIEF:
 * This agent demonstrates the x402 protocol (HTTP 402 "Payment Required") by
 * acting as a sophisticated client that can automatically negotiate payments
 * with paywalled APIs. It's designed to be educational - every step of the
 * payment flow is logged and explained.
 *
 * THE X402 PROTOCOL:
 * x402 extends HTTP with a standardized way for APIs to require payment before
 * serving content. Think of it like a digital paywall:
 *
 * 1. CLIENT makes request without payment
 * 2. SERVER responds with "402 Payment Required" + payment instructions
 * 3. CLIENT creates cryptographic payment proof
 * 4. CLIENT retries request with Authorization header containing proof
 * 5. SERVER verifies payment (via facilitator) and serves content
 *
 * This tool automates steps 3-5, making it easy to test x402-enabled APIs.
 *
 * ARCHITECTURE:
 * - CLI module (cli.ts): Handles argument parsing, validation, configuration
 * - Main module (this file): Orchestrates the payment flow with educational logging
 * - x402 libraries: Handle the cryptographic details of payment creation
 *
 * @see https://github.com/coinbase/x402 - x402 Protocol Specification
 * @see https://kobaru.io - Kobaru Facilitator Gateway
 */

import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { createPaymentClient } from './payment-client.js';
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/signers";
import { privateKeyToAccount } from "viem/accounts";
import { base58 } from "@scure/base";
import dotenv from "dotenv";
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';

// Import our modular, testable CLI functions
import {
    parseArgs,
    validateUrl,
    validateJson,
    getNetworkConfig,
    type NetworkOption,
    type NetworkConfig,
} from './cli.js';

// ============================================================================
// ENVIRONMENT CONFIGURATION
// ============================================================================

/**
 * Load environment variables from .env file
 *
 * SECURITY NOTE:
 * - .env file is gitignored (never commit it!)
 * - Contains private keys for Solana (SVM_PRIVATE_KEY) and Base (EVM_PRIVATE_KEY)
 * - Use BURNER wallets only - never use wallets with significant funds
 * - Private keys are used ONLY for signing payment proofs, not stored anywhere
 */
dotenv.config();

// ============================================================================
// LOGGING UTILITIES (Spy-Themed Educational Output)
// ============================================================================

/**
 * Log a major section header in the mission flow
 *
 * Educational design: We break the payment flow into numbered PHASES so users
 * can follow the progression from reconnaissance to mission completion.
 *
 * @param title - Section title (e.g., "PHASE 1: RECONNAISSANCE")
 * @param icon - Emoji icon for visual distinction
 */
const logSection = (title: string, icon: string = "📝") => {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`   ${icon} ${title.toUpperCase()}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
};

/**
 * Log general information (ℹ️ prefix)
 * Used for describing what the agent is doing at each step
 */
const logInfo = (message: string) => console.log(`   ℹ️  ${message}`);

/**
 * Log specific details (▪️ prefix with label)
 * Used for showing concrete values like URLs, headers, prices
 */
const logDetail = (label: string, value: any) => {
    console.log(`      ▪️ ${label}: ${typeof value === 'object' ? JSON.stringify(value, null, 2) : value}`);
};

/**
 * Log educational explanations (💡 EDUCATIONAL INTEL prefix)
 *
 * These comments explain the "WHY" behind each action, helping users understand
 * the x402 protocol conceptually rather than just seeing technical operations.
 */
const logExplanation = (text: string) => {
    console.log(`      💡 EDUCATIONAL INTEL: ${text}`);
};

/**
 * Prompt user for interactive confirmation (used for mainnet safety)
 *
 * SAFETY MECHANISM:
 * When operating on mainnet (real money), we require explicit user confirmation
 * to prevent accidental spending. This is a critical safety feature.
 *
 * @param query - Question to ask the user
 * @returns User's input (typically 'y' or 'n')
 */
const askQuestion = (query: string): Promise<string> => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
};

// ============================================================================
// MAIN MISSION LOGIC
// ============================================================================

async function main() {
    // ========================================================================
    // PHASE 0: INITIALIZATION & ARGUMENT PARSING
    // ========================================================================

    logSection("AGENT 007 INITIALIZED - CODENAME: PAYWALL AUDITOR", "🕵️");

    /**
     * STEP 1: Parse command-line arguments
     *
     * The CLI module handles all argument parsing and validation:
     * - targetUrl: Which API endpoint to test (defaults to localhost:3000/answer)
     * - requestBody: Optional JSON payload for POST requests
     * - network: Which blockchain network to use (solana, base, etc.)
     * - timeout: Optional request timeout in milliseconds
     *
     * Educational note: We parse args FIRST because network selection determines
     * which payment scheme to register with the x402 client.
     */
    let parsedArgs;
    try {
        parsedArgs = parseArgs({ defaultUrl: "http://localhost:3000/answer" });
    } catch (error) {
        // parseArgs throws descriptive errors - display them with our spy theme
        console.error(`❌ CRITICAL FAILURE: ${error instanceof Error ? error.message : String(error)}`);
        console.error("   Abort mission. Check command syntax and try again.");
        process.exit(1);
    }

    const { targetUrl, requestBody, network: selectedNetwork, timeout, filePath } = parsedArgs;

    /**
     * STEP 2: Validate the target URL for security
     *
     * SECURITY CHECK:
     * We only allow http:// and https:// protocols to prevent dangerous attacks:
     * - file:// could read local files
     * - javascript: could execute code
     * - data: could inject malicious content
     *
     * This is a critical security boundary.
     */
    try {
        validateUrl(targetUrl);
        logInfo(`Target acquired: ${targetUrl}`);
    } catch (error) {
        console.error(`❌ CRITICAL FAILURE: ${error instanceof Error ? error.message : String(error)}`);
        console.error("   Only http:// and https:// protocols are permitted.");
        console.error("   Example: npm start http://localhost:3000/answer --network solana");
        process.exit(1);
    }

    /**
     * STEP 3: Validate JSON request body (if provided)
     *
     * POST REQUESTS:
     * If a JSON body is provided, we validate it before sending to ensure proper
     * formatting. Malformed JSON would cause cryptic server errors.
     *
     * COMMON MISTAKE:
     * Users sometimes pass network names (like "solana") as positional arguments
     * instead of using --network flag. This causes the parser to treat them as
     * request bodies, leading to JSON validation errors.
     */
    let finalRequestBody = requestBody;
    if (requestBody) {
        try {
            validateJson(requestBody);
            logInfo(`Request body validated: ${requestBody.substring(0, 50)}${requestBody.length > 50 ? '...' : ''}`);
        } catch (error) {
            console.error(`❌ CRITICAL FAILURE: ${error instanceof Error ? error.message : String(error)}`);
            if (!(error instanceof Error && error.message.includes("Did you mean to use --network"))) {
                // Only show generic JSON help if it's not a network name mistake
                console.error("   Request body must be valid JSON.");
                console.error(`   Example: '{"key":"value"}'`);
            }
            process.exit(1);
        }
    }

    /**
     * STEP 3.5: Handle file input (if provided)
     *
     * FILE UPLOADS:
     * If a file path is provided via --file flag, we:
     * 1. Read the file from disk
     * 2. Encode it to base64
     * 3. Create a JSON body with the format: {"image": "base64-data", "filename": "original-name.ext"}
     *
     * This simplifies testing image APIs by avoiding the "Argument list too long" error
     * that occurs when passing large base64 strings on the command line.
     */
    if (filePath) {
        try {
            logInfo(`Reading file from disk: ${filePath}`);

            // Check if file exists
            if (!fs.existsSync(filePath)) {
                throw new Error(`File not found: ${filePath}`);
            }

            // Read file and encode to base64
            const fileBuffer = fs.readFileSync(filePath);
            const base64Data = fileBuffer.toString('base64');
            const fileName = path.basename(filePath);

            logDetail("File Name", fileName);
            logDetail("File Size", `${fileBuffer.length} bytes`);
            logDetail("Base64 Size", `${base64Data.length} characters`);

            // Create JSON body with image and filename
            const filePayload = {
                image: base64Data,
                filename: fileName
            };
            finalRequestBody = JSON.stringify(filePayload);

            logInfo(`✅ File successfully encoded to base64 and packaged as JSON`);
            logExplanation("The file has been read from disk and encoded. We're now ready to send it to the API.");
        } catch (error) {
            console.error(`❌ CRITICAL FAILURE: ${error instanceof Error ? error.message : String(error)}`);
            console.error("   Failed to read or encode the file.");
            console.error(`   Make sure the file path is correct and the file is readable.`);
            process.exit(1);
        }
    }

    /**
     * STEP 4: Enforce network requirement
     *
     * SAFETY MECHANISM:
     * We REQUIRE explicit network selection (via --network flag) to prevent
     * accidental mainnet transactions. The user must consciously choose their
     * network, reducing the risk of spending real money by mistake.
     */
    if (!selectedNetwork) {
        console.error("❌ CRITICAL FAILURE: --network flag is REQUIRED.");
        console.error("   Specify which blockchain network to use: solana-mainnet, solana, base-mainnet, base");
        console.error("   Example: npm start http://localhost:3000/answer --network solana");
        process.exit(1);
    }

    /**
     * STEP 5: Load network configuration
     *
     * NETWORK CONFIGURATION:
     * Each network has specific parameters:
     * - type: 'svm' (Solana) or 'evm' (Ethereum Virtual Machine)
     * - chainId: Blockchain identifier in CAIP-2 format
     * - asset: USDC contract address for that network
     * - isMainnet: Whether this uses real money (true) or testnet (false)
     *
     * These configurations ensure we connect to the correct blockchain and use
     * the right token addresses.
     */
    const userNetworkConfig = getNetworkConfig(selectedNetwork);
    logInfo(`Network selected: ${selectedNetwork}`);
    logDetail("Network Type", userNetworkConfig.type.toUpperCase());
    logDetail("Chain ID", userNetworkConfig.chainId);
    logDetail("Asset (USDC)", userNetworkConfig.asset);
    logDetail("Environment", userNetworkConfig.isMainnet ? "🚨 MAINNET (REAL MONEY)" : "🧪 TESTNET (PLAY MONEY)");

    /**
     * STEP 6: Load wallet credentials from environment
     *
     * CREDENTIAL MANAGEMENT:
     * - SVM_PRIVATE_KEY: Base58-encoded Solana private key (for Solana networks)
     * - EVM_PRIVATE_KEY: Hex-encoded Ethereum private key (for Base networks)
     *
     * At least ONE must be present. We'll use the appropriate key based on the
     * network type selected.
     *
     * SECURITY:
     * - Private keys are loaded from environment variables (never hardcoded)
     * - Keys are used ONLY for signing payment proofs (not stored)
     * - Use BURNER wallets with minimal funds for testing
     */
    const svmPrivateKey = process.env.SVM_PRIVATE_KEY;
    const evmPrivateKey = process.env.EVM_PRIVATE_KEY;

    if (!svmPrivateKey && !evmPrivateKey) {
        console.error("❌ CRITICAL FAILURE: MISSING CREDENTIALS (SVM_PRIVATE_KEY or EVM_PRIVATE_KEY).");
        console.error("   At least one private key must be set in your .env file.");
        console.error("   Decode instructions are located in .env.example.");
        console.error("   ⚠️  IMPORTANT: Use BURNER wallets only - never use wallets with significant funds!");
        process.exit(1);
    }

    // Verify we have the RIGHT type of key for the selected network
    if (userNetworkConfig.type === 'svm' && !svmPrivateKey) {
        console.error(`❌ CRITICAL FAILURE: Network '${selectedNetwork}' requires SVM_PRIVATE_KEY.`);
        console.error("   Solana networks use SVM (Solana Virtual Machine) which requires a Solana private key.");
        console.error("   Set SVM_PRIVATE_KEY in your .env file.");
        process.exit(1);
    }
    if (userNetworkConfig.type === 'evm' && !evmPrivateKey) {
        console.error(`❌ CRITICAL FAILURE: Network '${selectedNetwork}' requires EVM_PRIVATE_KEY.`);
        console.error("   Base networks use EVM (Ethereum Virtual Machine) which requires an EVM private key.");
        console.error("   Set EVM_PRIVATE_KEY in your .env file.");
        process.exit(1);
    }

    // ========================================================================
    // PHASE 1: X402 CLIENT INITIALIZATION
    // ========================================================================

    logSection("PHASE 1: RECONNAISSANCE", "📡");

    /**
     * Initialize the x402 client
     *
     * X402 CLIENT:
     * This object manages the entire payment flow:
     * - Detects 402 responses from servers
     * - Parses payment requirements from WWW-Authenticate headers
     * - Coordinates with registered payment schemes to create proofs
     * - Retries requests with Authorization headers
     *
     * Think of it as the "payment negotiation protocol handler".
     */
    const client = createPaymentClient(userNetworkConfig);
    logInfo("x402 Protocol client initialized.");
    logExplanation("The x402 client handles the cryptographic payment protocol automatically.");

    /**
     * Configure educational logging hooks
     *
     * HOOKS:
     * The x402 client provides lifecycle hooks that let us observe the payment
     * flow at key moments. We use these to log educational explanations of each
     * step, transforming technical operations into teachable moments.
     *
     * Available hooks:
     * - onBeforePaymentCreation: Server sent 402, about to create payment
     * - onAfterPaymentCreation: Payment proof created, about to retry request
     */
    client
        .onBeforePaymentCreation(async (context) => {
            // ================================================================
            // PHASE 2: ANALYZING THE SERVER'S PAYMENT CHALLENGE
            // ================================================================

            logSection("PHASE 2: ANALYZING SECURITY PROTOCOL", "🛑");
            logInfo("The target server stopped us with a '402 Payment Required' status.");
            logExplanation("Think of this as a digital bouncer. It says 'You can't come in unless you pay'.");

            /**
             * Parse payment requirements from context
             *
             * PAYMENT CONTEXT:
             * When a server responds with 402, it includes payment requirements in
             * the WWW-Authenticate header. The x402 client parses this and provides
             * it to us via the context object.
             *
             * Key fields:
             * - paymentRequired: Full server requirements (may offer multiple options)
             * - selectedRequirements: The specific option the client chose
             *
             * We cast to 'any' here because the structure is dynamic and depends on
             * which payment schemes the server supports.
             */
            const serverReqs = context.paymentRequired as any;
            const selected = context.selectedRequirements as any;

            logInfo("Extracting payment requirements from the 'WWW-Authenticate' header...");
            logDetail("Raw Server Requirements", serverReqs);
            logExplanation("The server sent us instructions on how to pay. Let's verify they match our setup.");

            // ============================================================
            // NETWORK & ASSET COMPATIBILITY VERIFICATION
            // ============================================================

            /**
             * Verify the server's requirements match our network selection
             *
             * COMPATIBILITY CHECK:
             * Before attempting payment, we verify:
             * 1. Server's network matches our selected network (Solana mainnet, Base Sepolia, etc.)
             * 2. Server's asset (USDC address) matches what we expect for that network
             *
             * WHY THIS MATTERS:
             * - Prevents sending payment on wrong network (wasted money)
             * - Prevents using wrong token address (payment lost)
             * - Gives clear error if server configuration differs from client
             *
             * This is a critical safety check unique to blockchain payments.
             */
            logInfo("Validating server requirements against user's network preference...");

            const serverNetwork = selected.network || "";
            const serverAsset = selected.asset || "";

            // Compare server's network with our configuration
            const networkMatches = serverNetwork === userNetworkConfig.chainId;
            const assetMatches = serverAsset.toLowerCase() === userNetworkConfig.asset.toLowerCase();

            logDetail("User Selected Network", `${selectedNetwork} (${userNetworkConfig.chainId})`);
            logDetail("User Expected Asset", userNetworkConfig.asset);
            logDetail("Server Network", serverNetwork);
            logDetail("Server Asset", serverAsset);
            logDetail("Network Match", networkMatches ? "✅ YES" : "❌ NO");
            logDetail("Asset Match", assetMatches ? "✅ YES" : "❌ NO");

            if (!networkMatches) {
                throw new Error(
                    `❌ NETWORK MISMATCH: You requested '${selectedNetwork}' (${userNetworkConfig.chainId}) ` +
                    `but server only supports '${serverNetwork}'. ` +
                    `Available options: ${JSON.stringify(serverReqs.accepts || serverReqs)}`
                );
            }

            if (!assetMatches) {
                throw new Error(
                    `❌ ASSET MISMATCH: Expected asset '${userNetworkConfig.asset}' for ${selectedNetwork}, ` +
                    `but server requires '${serverAsset}'. ` +
                    `This may indicate the server uses a different token.`
                );
            }

            logInfo("✅ Network and asset compatibility VERIFIED.");
            logExplanation("Perfect match! The server accepts payment on the network we're configured for.");

            // ============================================================
            // DISPLAY PAYMENT DETAILS
            // ============================================================

            /**
             * Show the user what they're about to pay
             *
             * TRANSPARENCY:
             * Before creating a payment proof, we show:
             * - Scheme: Payment method (exact-svm, exact-evm)
             * - Price: How much in atomic units (1 USDC = 1,000,000 atomic units)
             * - Asset: Which token (USDC contract address)
             * - Network: Which blockchain (Solana mainnet, Base Sepolia, etc.)
             * - Recipient: Who will receive payment (payTo address)
             *
             * This transparency is crucial for user trust.
             */
            logExplanation("The server sent a 'Challenge'. It tells us:");
            logDetail("Payment Scheme", selected.scheme);

            // Convert atomic units to human-readable USDC amount
            // Atomic units: 1 USDC = 1,000,000 units (6 decimals)
            // x402 v2 uses "amount" field instead of "price"
            const amount = selected.amount || selected.price || 0;
            const priceInUSDC = amount / 1_000_000;
            logDetail("Price", `${amount} atomic units (${priceInUSDC.toFixed(6)} USDC)`);
            logExplanation(`Atomic units are like cents to dollars. 1 USDC = 1,000,000 atomic units.`);

            logDetail("Asset (Token)", selected.asset);
            logDetail("Network", selected.network);
            logDetail("Pay To (Recipient)", selected.payTo);

            // ============================================================
            // MAINNET SAFETY CONFIRMATION
            // ============================================================

            /**
             * Interactive mainnet confirmation
             *
             * SAFETY MECHANISM:
             * If we're on mainnet (real money), we pause and ask the user to confirm
             * they want to proceed. This prevents accidental spending.
             *
             * On testnet (play money), we skip this and proceed automatically.
             *
             * This is a critical safety feature - never remove this check!
             */
            if (userNetworkConfig.isMainnet) {
                logInfo("🚨 LIVE FIRE EXERCISE DETECTED: This transaction uses REAL MONEY on MAINNET.");
                logInfo("Double-checking before proceeding...");

                const answer = await askQuestion(`   🛑 CONFIRM REAL MONEY TRANSACTION? (Y/n): `);

                if (answer.toLowerCase() === 'n') {
                    logInfo("🛑 Mission Aborted by Agent");
                    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
                    process.exit(0);
                }

                logInfo("✅ User confirmed. Proceeding with mainnet transaction.");
            } else {
                logInfo("🧪 Operating in TESTNET mode (play money). Proceeding automatically.");
                logExplanation("Testnet uses fake USDC for testing. No real money is spent.");
            }
        })
        .onAfterPaymentCreation(async (context) => {
            // ================================================================
            // PHASE 3: PAYMENT PROOF CREATED
            // ================================================================

            logSection("PHASE 3: CREDENTIALS APPROVED", "🔑");

            /**
             * Payment proof created successfully
             *
             * WHAT JUST HAPPENED:
             * The x402 client used our private key to create a cryptographic proof
             * that we're authorized to make this payment. This proof is NOT the
             * payment itself - it's like a signed check.
             *
             * The proof contains:
             * - Amount to pay
             * - Recipient address
             * - Token address
             * - Our signature (proving we authorize this payment)
             *
             * This proof will be sent to the server in an Authorization header.
             * The server will verify it with the facilitator (Kobaru gateway).
             *
             * SECURITY NOTE:
             * The proof is cryptographically signed but doesn't move funds yet.
             * Actual settlement happens asynchronously via the facilitator after
             * the server verifies our proof.
             */
            logInfo("Payment proof successfully created.");
            logExplanation("We didn't just send money; we created a cryptographic proof that we AUTHORIZE payment.");
            logExplanation("Think of it like signing a check - the money moves later when the check is cashed.");

            /**
             * Display authorization information
             *
             * AUTHORIZATION HEADER:
             * The proof is base64-encoded and sent in the HTTP Authorization header:
             *
             *   Authorization: 402 <base64-encoded-proof>
             *
             * The "402" prefix tells the server "this is an x402 payment proof".
             * The server then verifies it with the facilitator before serving content.
             */
            logExplanation("This data will be encoded into base64 and put into the 'Authorization' header.");
            logExplanation("The server will verify this proof with the payment facilitator (gateway).");

            logInfo("Retrying request with payment credentials attached...");
            logExplanation("Now we make the SAME request again, but this time with our payment proof included.");
        });

    // ========================================================================
    // PHASE 2: REGISTER PAYMENT SCHEMES (Wallet Initialization)
    // ========================================================================

    /**
     * Register the appropriate payment scheme based on network type
     *
     * PAYMENT SCHEMES:
     * A "scheme" is a payment method that knows how to create proofs for a
     * specific blockchain. We support two types:
     *
     * 1. SVM (Solana Virtual Machine):
     *    - Uses Solana blockchain
     *    - Requires Base58-encoded private key
     *    - Uses @solana/signers for transaction signing
     *
     * 2. EVM (Ethereum Virtual Machine):
     *    - Uses Base blockchain (EVM-compatible)
     *    - Requires hex-encoded private key (0x prefix optional)
     *    - Uses viem for transaction signing
     *
     * We only register the scheme needed for the user's selected network,
     * which is more efficient than registering all schemes.
     */
    if (userNetworkConfig.type === 'svm') {
        // ================================================================
        // SOLANA (SVM) WALLET INITIALIZATION
        // ================================================================

        logInfo("Initializing Solana (SVM) payment scheme...");
        logExplanation("Solana uses the SVM (Solana Virtual Machine) for smart contracts and payments.");

        try {
            /**
             * Decode Base58 private key and create signer
             *
             * SOLANA KEY FORMAT:
             * Solana private keys are typically Base58-encoded strings (like Bitcoin).
             * We must:
             * 1. Decode from Base58 to raw bytes
             * 2. Create a KeyPairSigner from those bytes
             * 3. Register the signer with the exact-svm scheme
             *
             * The signer is used to sign payment proofs cryptographically.
             */
            const privateKeyBytes = base58.decode(svmPrivateKey!);
            const signer = await createKeyPairSignerFromBytes(privateKeyBytes);

            /**
             * Register the exact-svm payment scheme
             *
             * EXACT-SVM SCHEME:
             * "Exact" means the price is exact - no overpayment or underpayment
             * accepted. This is the simplest payment scheme.
             *
             * The scheme configuration includes:
             * - signer: Wallet that signs payment proofs (Solana keypair)
             * - networks: (Optional) Array of chain IDs in CAIP-2 format
             *
             * NOTE: The asset (USDC address) is NOT specified in the client config.
             * It's determined by the server's payment requirements (402 response).
             *
             * Once registered, the x402 client can use this scheme automatically
             * when it encounters a compatible Solana payment requirement.
             */
            registerExactSvmScheme(client, {
                signer,
                networks: [userNetworkConfig.chainId],
            });

            logInfo(`🔑 SVM Wallet Loaded: ${signer.address}`);
            logExplanation("This is your PUBLIC wallet address (safe to share). Your PRIVATE key stays secret.");
            logDetail("Registered Scheme", "exact-svm");
            logDetail("Chain ID", userNetworkConfig.chainId);
            logDetail("Asset (USDC)", userNetworkConfig.asset);
        } catch (e) {
            console.error("💥 GADGET MALFUNCTION: Failed to register SVM scheme:", e);
            console.error("   Check that your SVM_PRIVATE_KEY is valid Base58 format.");
            console.error("   Generate a new wallet: solana-keygen new");
            process.exit(1);
        }
    } else {
        // ================================================================
        // BASE (EVM) WALLET INITIALIZATION
        // ================================================================

        logInfo("Initializing Base (EVM) payment scheme...");
        logExplanation("Base uses the EVM (Ethereum Virtual Machine), same as Ethereum and many other chains.");

        try {
            /**
             * Parse hex private key and create account
             *
             * EVM KEY FORMAT:
             * EVM private keys are 64 hex characters (32 bytes) with optional 0x prefix.
             * We normalize by:
             * 1. Stripping 0x prefix if present
             * 2. Adding 0x prefix back for viem
             * 3. Creating an account object
             *
             * The account can sign transactions and messages.
             */
            let normalizedKey = evmPrivateKey!;
            if (!normalizedKey.startsWith('0x')) {
                normalizedKey = `0x${normalizedKey}`;
            }
            const account = privateKeyToAccount(normalizedKey as `0x${string}`);

            /**
             * Register the exact-evm payment scheme
             *
             * EXACT-EVM SCHEME:
             * Same concept as exact-svm but for EVM-compatible chains (Base, Ethereum, etc.).
             *
             * The scheme configuration includes:
             * - signer: Wallet that signs payment proofs (viem account)
             * - networks: (Optional) Array of chain IDs in CAIP-2 format
             *
             * NOTE: The asset (USDC address) is NOT specified in the client config.
             * It's determined by the server's payment requirements (402 response).
             */
            registerExactEvmScheme(client, {
                signer: account,
                networks: [userNetworkConfig.chainId],
            });

            logInfo(`🔑 EVM Wallet Loaded: ${account.address}`);
            logExplanation("This is your PUBLIC wallet address (safe to share). Your PRIVATE key stays secret.");
            logDetail("Registered Scheme", "exact-evm");
            logDetail("Chain ID", userNetworkConfig.chainId);
            logDetail("Asset (USDC)", userNetworkConfig.asset);
        } catch (e) {
            console.error("💥 GADGET MALFUNCTION: Failed to register EVM scheme:", e);
            console.error("   Check that your EVM_PRIVATE_KEY is valid hex format (64 hex chars, optional 0x prefix).");
            console.error("   Generate a new wallet: Use MetaMask or similar wallet to export private key.");
            process.exit(1);
        }
    }

    // ========================================================================
    // PHASE 3: CREATE VERBOSE FETCH WRAPPER (The "Wiretap")
    // ========================================================================

    /**
     * Create a custom fetch wrapper that logs all HTTP traffic
     *
     * EDUCATIONAL LOGGING:
     * To help users understand the HTTP flow, we wrap the standard fetch function
     * with logging. This "wiretap" shows:
     *
     * OUTGOING:
     * - HTTP method (GET, POST)
     * - Target URL
     * - All request headers (with Authorization tokens truncated for security)
     * - Request body (for POST requests)
     *
     * INCOMING:
     * - Status code (200 OK, 402 Payment Required, etc.)
     * - Response latency
     * - WWW-Authenticate header (contains payment requirements)
     *
     * This turns invisible network operations into visible, educational moments.
     */
    const verboseFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const method = init?.method || "GET";
        const url = input.toString();

        // ================================================================
        // LOG OUTGOING REQUEST
        // ================================================================

        console.log(`\n📨 OUTGOING HTTP REQUEST`);
        console.log(`   ➡️  ${method} ${url}`);

        if (timeout) {
            logDetail("Timeout", `${timeout}ms`);
            logExplanation("Request will abort if server doesn't respond within this time.");
        }

        if (init?.headers) {
            /**
             * Log request headers (with sensitive data truncated)
             *
             * SECURITY:
             * Authorization headers contain payment proofs which are sensitive.
             * We truncate them to first 50 characters to show they exist without
             * exposing full tokens in logs.
             *
             * Headers object can be in multiple formats:
             * - Headers instance (Web API)
             * - Array of [key, value] tuples
             * - Plain object Record<string, string>
             *
             * We handle all three formats.
             */
            let authHeader: string | null = null;
            const h = init.headers;

            // Extract authorization header (case-insensitive)
            if (h instanceof Headers) {
                authHeader = h.get('authorization') || h.get('Authorization');
            } else if (Array.isArray(h)) {
                const found = h.find(([key]) => key.toLowerCase() === 'authorization');
                if (found) authHeader = found[1];
            } else {
                authHeader = (h as Record<string, string>)['authorization'] ||
                    (h as Record<string, string>)['Authorization'];
            }

            if (authHeader) {
                console.log(`   🔑 Header [Authorization]: ${authHeader.substring(0, 50)}... (truncated)`);
                logExplanation("Notice the Authorization header is now attached! We are flashing our badge.");
            }

            // Log all headers for transparency
            console.log(`   📋 All Request Headers:`);
            if (h instanceof Headers) {
                h.forEach((value, key) =>
                    console.log(`      • ${key}: ${value.substring(0, 80)}${value.length > 80 ? '...' : ''}`)
                );
            } else if (Array.isArray(h)) {
                h.forEach(([key, value]) =>
                    console.log(`      • ${key}: ${value.substring(0, 80)}${value.length > 80 ? '...' : ''}`)
                );
            } else {
                Object.entries(h as Record<string, string>).forEach(([key, value]) =>
                    console.log(`      • ${key}: ${value.substring(0, 80)}${value.length > 80 ? '...' : ''}`)
                );
            }
        } else {
            console.log(`   📋 No headers present in request`);
        }

        // ================================================================
        // EXECUTE REQUEST (with optional timeout)
        // ================================================================

        const start = performance.now();

        let response: Response;
        if (timeout) {
            /**
             * Apply timeout using Promise.race
             *
             * TIMEOUT MECHANISM:
             * We race two promises:
             * 1. The actual fetch request
             * 2. A timeout promise that rejects after N milliseconds
             *
             * Whichever completes first wins. If timeout wins, we throw an error.
             * If fetch wins, we return the response normally.
             *
             * This prevents the tool from hanging forever on unresponsive servers.
             */
            const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Request timeout after ${timeout}ms`)), timeout)
            );
            response = await Promise.race([fetch(input, init), timeoutPromise]);
        } else {
            // No timeout - wait indefinitely (useful for debugging slow APIs)
            response = await fetch(input, init);
        }

        const duration = (performance.now() - start).toFixed(2);

        // ================================================================
        // LOG INCOMING RESPONSE
        // ================================================================

        console.log(`\n📥 INCOMING HTTP RESPONSE`);
        console.log(`   ⬅️  Status: ${response.status} ${response.statusText}`);
        console.log(`   ⏱️  Remote Server Latency: ${duration}ms`);

        /**
         * Special handling for WWW-Authenticate header
         *
         * WWW-AUTHENTICATE:
         * When a server responds with 402 Payment Required, it includes this
         * header to tell us HOW to pay. It contains:
         * - Payment scheme (exact-svm, exact-evm)
         * - Price (in atomic units)
         * - Network (chain ID)
         * - Asset (token address)
         * - Recipient (payTo address)
         *
         * This is the critical header that starts the payment negotiation.
         */
        const wwwAuth = response.headers.get('www-authenticate');
        if (wwwAuth) {
            console.log(`   🔐 Header [WWW-Authenticate]: ${wwwAuth}`);
            logExplanation("This header contains the ingredients the agent needs to build the payment.");
        }

        return response;
    };

    // ========================================================================
    // PHASE 4: WRAP FETCH WITH PAYMENT LOGIC
    // ========================================================================

    /**
     * Wrap our verbose fetch with x402 payment handling
     *
     * THE MAGIC HAPPENS HERE:
     * This wraps our logging fetch with the x402 protocol handler. The result
     * is a fetch function that:
     *
     * 1. Makes initial request (using our verbose logger)
     * 2. If 402 response → triggers onBeforePaymentCreation hook
     * 3. Creates payment proof (using registered scheme)
     * 4. Triggers onAfterPaymentCreation hook
     * 5. Retries request with Authorization header (using our verbose logger)
     * 6. Returns final response
     *
     * All of this happens automatically! The caller just uses it like normal fetch.
     *
     * This is the core innovation of the x402 protocol - making payments as
     * simple as adding a header.
     */
    const fetchWithPayment = wrapFetchWithPayment(verboseFetch, client);
    logInfo("Payment protocol handler initialized.");
    logExplanation("The agent is now ready to automatically handle 402 Payment Required responses.");

    // ========================================================================
    // PHASE 5: EXECUTE THE MISSION (Make Request)
    // ========================================================================

    logSection("PHASE 1: RECONNAISSANCE", "📡");
    logInfo(`Target: ${targetUrl}`);
    logInfo(`Method: ${finalRequestBody ? 'POST' : 'GET'}`);
    if (finalRequestBody && !filePath) {
        // Only show request body if it wasn't a file (to avoid flooding console with base64)
        logDetail("Request Body", finalRequestBody);
    } else if (finalRequestBody && filePath) {
        logInfo(`Request Body: JSON payload with base64-encoded image`);
    }
    logExplanation("We are about to make the first request without any credentials to see if it's protected.");

    try {
        /**
         * Execute the mission: Make the HTTP request
         *
         * PAYMENT FLOW:
         * This single fetch call may actually make TWO HTTP requests:
         *
         * REQUEST 1 (Reconnaissance):
         * - No Authorization header
         * - Server responds with 402 Payment Required
         * - Server includes WWW-Authenticate header with payment requirements
         *
         * (x402 client creates payment proof automatically)
         *
         * REQUEST 2 (With Credentials):
         * - Authorization header included with payment proof
         * - Server verifies proof with facilitator
         * - Server responds with 200 OK and content
         *
         * All of this happens transparently - we just await the promise!
         */
        logInfo("Mission timer started...");
        const startTime = performance.now();

        const fetchOptions: RequestInit = {};
        if (finalRequestBody) {
            fetchOptions.method = "POST";
            fetchOptions.body = finalRequestBody;
            fetchOptions.headers = {
                "Content-Type": "application/json"
            };
        }

        const response = await fetchWithPayment(targetUrl, fetchOptions);
        const duration = (performance.now() - startTime).toFixed(2);
        logDetail("Total mission duration", `${duration}ms`);

        // ================================================================
        // PHASE 4: MISSION SUCCESS
        // ================================================================

        logSection("PHASE 4: ACCESS GRANTED", "🍸");
        logInfo(`Final Status: ${response.status} ${response.statusText}`);

        /**
         * Parse and display response content
         *
         * CONTENT HANDLING:
         * We automatically detect content type and parse accordingly:
         * - application/json → Parse as JSON
         * - text/* → Display as text
         * - Other → Display as text with warning
         *
         * This makes the tool work with various API response formats.
         */
        let data;
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
            data = await response.json();
            // Don't log full response if it contains large base64 image data
            if (data && data.result && data.result.data && typeof data.result.data === 'string' && data.result.data.length > 1000) {
                logInfo("Received JSON response with large base64 image data");
                logDetail("Response Structure", {
                    success: data.success,
                    message: data.message,
                    result: {
                        format: data.result?.format,
                        encoding: data.result?.encoding,
                        size_bytes: data.result?.size_bytes,
                        data: `<base64 data: ${data.result.data.length} characters>`
                    }
                });
            } else {
                logDetail("Decoded JSON Body", data);
            }
        } else {
            data = await response.text();
            logDetail("Decoded Text Body", data);
        }

        if (response.ok) {
            /**
             * IMAGE RESPONSE HANDLING:
             * If we sent a file and received an image response, save it to disk
             *
             * AUTOMATIC SAVE:
             * We detect image responses by checking for:
             * - JSON response with result.data field containing base64
             * - result.format field indicating image format (JPEG, PNG, etc.)
             *
             * The saved file will be named: original-name-response.ext
             * For example: photo.jpg → photo-response.jpg
             */
            if (filePath && data && typeof data === 'object' && data.result && data.result.data) {
                try {
                    logSection("PHASE 4.5: SAVING IMAGE RESPONSE", "💾");

                    const imageBase64 = data.result.data;
                    const imageFormat = (data.result.format || 'jpg').toLowerCase();

                    // Decode base64 to buffer
                    const imageBuffer = Buffer.from(imageBase64, 'base64');

                    // Generate output filename: original-name-response.ext
                    const inputFileDir = path.dirname(filePath);
                    const inputFileName = path.basename(filePath, path.extname(filePath));
                    const outputFileName = `${inputFileName}-response.${imageFormat}`;
                    const outputFilePath = path.join(inputFileDir, outputFileName);

                    // Write to disk
                    fs.writeFileSync(outputFilePath, imageBuffer);

                    logInfo(`✅ Image saved successfully!`);
                    logDetail("Output File", outputFilePath);
                    logDetail("Image Format", imageFormat.toUpperCase());
                    logDetail("File Size", `${imageBuffer.length} bytes`);
                    logExplanation("The restored image has been decoded from base64 and saved to disk in the same directory as the original.");
                } catch (saveError) {
                    console.error(`⚠️  Failed to save image: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
                    console.error("   The API response was successful, but we couldn't save the image to disk.");
                }
            }
            // ============================================================
            // PHASE 5: PAYMENT CONFIRMATION
            // ============================================================

            logSection("PHASE 5: PAYMENT CONFIRMATION", "💸");

            /**
             * Extract payment settlement information
             *
             * PAYMENT SETTLEMENT:
             * After successful verification, the server may include settlement
             * details in response headers. This confirms that:
             * - Payment was received
             * - Transaction was recorded
             * - Funds will be transferred (asynchronously via facilitator)
             *
             * Settlement happens AFTER we receive content, not before. This is
             * a key difference from traditional payment flows.
             */
            try {
                const httpClient = new x402HTTPClient(client);
                const paymentResponse = httpClient.getPaymentSettleResponse(name => response.headers.get(name));
                if (paymentResponse) {
                    logInfo("Payment settlement confirmed by server:");
                    logDetail("Settlement Response", paymentResponse);
                    logExplanation("The server has acknowledged receipt of payment and settled the transaction.");
                } else {
                    logInfo("No payment settlement header found (payment may not have been required).");
                }
            } catch (e) {
                logInfo("Could not parse payment settlement response.");
            }

            logExplanation("Success! The server accepted our payment proof and returned the hidden data.");
            console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
            process.exit(0);
        } else {
            /**
             * Non-2xx response (failure)
             *
             * FAILURE SCENARIOS:
             * - 403 Forbidden: Payment proof was rejected (insufficient funds, wrong network, etc.)
             * - 404 Not Found: Endpoint doesn't exist
             * - 500 Server Error: Server crashed or misconfigured
             *
             * We could distinguish these better with specific error messages
             * per status code (future improvement).
             */
            console.error("\n💀 MISSION FAILED. Target remains secure.");
            console.error(`   Status: ${response.status} ${response.statusText}`);
            console.error("   The server rejected our payment or the endpoint is not accessible.");
            console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
            process.exit(1);
        }


    } catch (error: unknown) {
        /**
         * Unexpected error handling
         *
         * ERROR SCENARIOS:
         * - Network timeout (if --timeout flag was used)
         * - DNS resolution failure
         * - SSL certificate errors
         * - Connection refused
         * - Network mismatch (caught in onBeforePaymentCreation hook)
         * - Payment creation failure (no matching network/scheme registered)
         *
         * We display the error message and stack trace for debugging.
         */
        const errorMessage = error instanceof Error ? error.message : String(error);

        /**
         * Special handling for "No network/scheme registered" errors
         * 
         * This happens when the server offers payment options but none match
         * what we registered. We parse the error to show available options.
         */
        if (errorMessage.includes("No network/scheme registered")) {
            console.error("\n💥 NETWORK MISMATCH ERROR");
            console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            console.error("\n❌ The server doesn't support the network you selected.");
            console.error(`   You selected: ${selectedNetwork} (${userNetworkConfig.chainId})`);

            // Try to parse payment requirements from error message
            try {
                const jsonMatch = errorMessage.match(/\{"x402Version".*\}/);
                if (jsonMatch) {
                    const errorData = JSON.parse(jsonMatch[0]);
                    const paymentReqs = errorData.paymentRequirements || [];

                    console.error("\n📋 Server accepts payment on these networks:");
                    paymentReqs.forEach((req: any, idx: number) => {
                        const network = req.network || "unknown";
                        const asset = req.asset || "unknown";
                        const amount = req.amount ? `${Number(req.amount) / 1_000_000} USDC` : "unknown";

                        console.error(`\n   Option ${idx + 1}:`);
                        console.error(`   • Network: ${network}`);
                        console.error(`   • Asset: ${asset}`);
                        console.error(`   • Price: ${amount}`);

                        // Suggest the correct --network flag
                        let suggestedFlag = "";
                        if (network.includes("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")) {
                            suggestedFlag = "--network solana-mainnet";
                        } else if (network.includes("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")) {
                            suggestedFlag = "--network solana";
                        } else if (network === "eip155:8453") {
                            suggestedFlag = "--network base-mainnet";
                        } else if (network === "eip155:84532") {
                            suggestedFlag = "--network base";
                        }

                        if (suggestedFlag) {
                            console.error(`   💡 Use: ${suggestedFlag}`);
                        }
                    });

                    console.error("\n🔧 To fix this, retry with one of the supported networks:");
                    console.error(`   Example: npm start ${targetUrl} --network solana-mainnet`);
                }
            } catch (parseError) {
                // Fallback if we can't parse the error
                console.error("\n💡 Try a different --network flag:");
                console.error("   • --network solana-mainnet (Solana Mainnet)");
                console.error("   • --network solana (Solana Devnet)");
                console.error("   • --network base-mainnet (Base Mainnet)");
                console.error("   • --network base (Base Sepolia)");
            }

            console.error("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
            process.exit(1);
        }

        // Generic error handling for other errors
        console.error("\n💥 CRITICAL ERROR:", errorMessage);
        if (error instanceof Error && error.stack) {
            console.error("   Stack trace:", error.stack);
        }
        console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
        process.exit(1);
    }
}

// ============================================================================
// ENTRY POINT
// ============================================================================

/**
 * Execute the main mission
 *
 * EXECUTION:
 * We immediately invoke main() when the module is run. If main() throws,
 * the error will be caught by the catch handler inside main() and logged
 * appropriately.
 *
 * This is a top-level await - the script will wait for main() to complete
 * before exiting.
 */
main();
