/**
 * Helium IoT Hotspot Onboarding Service
 *
 * Self-hosted API for issuing data-only entities and onboarding
 * hotspots to the Helium IoT network via Solana.
 *
 * Endpoints:
 *   POST /onchain        — batch check on-chain status for pubkeys
 *   POST /gateways/:mac/issue   — generate issue-entity transaction
 *   POST /gateways/:mac/onboard — generate onboard transaction
 */

const express = require("express");
const {
  Connection,
  PublicKey,
  Transaction,
} = require("@solana/web3.js");
const { AnchorProvider } = require("@coral-xyz/anchor");
const { latLngToCell } = require("h3-js");

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.ONBOARD_PORT || 3001;
const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const MULTI_GW_API = process.env.MULTI_GW_API || "http://127.0.0.1:4468";
const MULTI_GW_READ_KEY = process.env.MULTI_GW_READ_KEY || "";

const connection = new Connection(SOLANA_RPC, "confirmed");

// Helium program addresses (mainnet)
const ENTITY_MANAGER_PROGRAM_ID = new PublicKey(
  "hemjuPXBpNvggtaUnN1MwT3wrdhttKEfosTcc2P9Pg8"
);
const IOT_SUB_DAO = new PublicKey(
  "39Lw1RH6zt8AJvKn3BTxmUDofzduCM2J3kSaGDZ8L7Sk"
);
const DATA_ONLY_CONFIG_KEY = new PublicKey(
  "dataonly1Zzm5StKrKzUNfEBBrcFSgUmDdaYhEbYQd4J"
);

// Cache for SDK lazy-loading
let entityManagerSdk = null;
let splUtils = null;

/**
 * Lazy-load the Helium SDKs (they're heavy, load once on first request)
 */
async function loadSdks() {
  if (!entityManagerSdk) {
    entityManagerSdk = await import("@helium/helium-entity-manager-sdk");
  }
  if (!splUtils) {
    splUtils = await import("@helium/spl-utils");
  }
  return { entityManagerSdk, splUtils };
}

/**
 * Fetch gateway info from the local multi-gateway API
 */
async function getGatewayByMac(mac) {
  const headers = {};
  if (MULTI_GW_READ_KEY) headers["X-API-Key"] = MULTI_GW_READ_KEY;

  const res = await fetch(`${MULTI_GW_API}/gateways`, { headers });
  if (!res.ok) throw new Error(`Multi-gateway API error: ${res.status}`);

  const data = await res.json();
  const gateways = data.gateways || data;
  const gw = (Array.isArray(gateways) ? gateways : []).find(
    (g) => g.mac?.toUpperCase() === mac.toUpperCase()
  );
  if (!gw) throw new Error(`Gateway ${mac} not found`);
  return gw;
}

// ---------------------------------------------------------------------------
// POST /onchain — batch check on-chain status
// ---------------------------------------------------------------------------
app.post("/onchain", async (req, res) => {
  try {
    const { pubkeys } = req.body;
    if (!Array.isArray(pubkeys) || pubkeys.length === 0) {
      return res.status(400).json({ error: "pubkeys array required" });
    }

    const results = {};

    for (const pk of pubkeys) {
      try {
        // Check if entity exists on-chain by looking for the key info PDA
        const entityKey = PublicKey.findProgramAddressSync(
          [
            Buffer.from("key_to_asset"),
            DATA_ONLY_CONFIG_KEY.toBuffer(),
            Buffer.from(pk),
          ],
          ENTITY_MANAGER_PROGRAM_ID
        )[0];

        const accountInfo = await connection.getAccountInfo(entityKey);

        if (accountInfo) {
          // Entity exists — check if IoT onboarded
          // Try to find the IoT info PDA
          const iotInfoKey = PublicKey.findProgramAddressSync(
            [
              Buffer.from("iot_info"),
              IOT_SUB_DAO.toBuffer(),
              entityKey.toBuffer(),
            ],
            ENTITY_MANAGER_PROGRAM_ID
          )[0];

          const iotInfo = await connection.getAccountInfo(iotInfoKey);

          results[pk] = {
            onchain: true,
            iot_onboarded: !!iotInfo,
            has_location: false, // TODO: decode iotInfo to check location
          };
        } else {
          results[pk] = {
            onchain: false,
            iot_onboarded: false,
            has_location: false,
          };
        }
      } catch (e) {
        console.error(`Error checking ${pk}:`, e.message);
        results[pk] = {
          onchain: false,
          iot_onboarded: false,
          has_location: false,
        };
      }
    }

    res.json({ results });
  } catch (e) {
    console.error("onchain error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /gateways/:mac/issue — generate issue-entity transaction
// ---------------------------------------------------------------------------
app.post("/gateways/:mac/issue", async (req, res) => {
  try {
    const { mac } = req.params;
    const { owner } = req.body;

    if (!owner) {
      return res.status(400).json({ error: "Missing owner address" });
    }

    let ownerPubkey;
    try {
      ownerPubkey = new PublicKey(owner);
    } catch {
      return res.status(400).json({ error: "Invalid owner address" });
    }

    // Get the gateway's public key from the multi-gateway API
    const gw = await getGatewayByMac(mac);
    if (!gw.public_key) {
      return res.status(400).json({ error: "Gateway has no public key" });
    }

    const { entityManagerSdk: emSdk } = await loadSdks();

    // Build the issue data-only entity instruction
    // The transaction is built unsigned — the client wallet signs it
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: ownerPubkey,
      lastValidBlockHeight,
    });

    // Derive the entity key PDA
    const [entityKey] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("key_to_asset"),
        DATA_ONLY_CONFIG_KEY.toBuffer(),
        Buffer.from(gw.public_key),
      ],
      ENTITY_MANAGER_PROGRAM_ID
    );

    // Check if already issued
    const existingEntity = await connection.getAccountInfo(entityKey);
    if (existingEntity) {
      return res.json({
        gateway: gw.public_key,
        already_issued: true,
        message: "Entity already exists on-chain",
      });
    }

    // For data-only hotspots, the issue instruction mints a compressed NFT
    // We return the unsigned transaction for the wallet to sign
    // The actual instruction building uses the entity manager SDK
    if (emSdk.dataOnlyIssueEntityIx) {
      const ix = await emSdk.dataOnlyIssueEntityIx({
        program: ENTITY_MANAGER_PROGRAM_ID,
        entityKey: gw.public_key,
        owner: ownerPubkey,
        payer: ownerPubkey,
        connection,
      });
      tx.add(ix);
    } else if (emSdk.issueDataOnlyEntityV0) {
      // Alternative SDK function name
      const ix = await emSdk.issueDataOnlyEntityV0({
        entityKey: gw.public_key,
        owner: ownerPubkey,
        payer: ownerPubkey,
        connection,
      });
      tx.add(ix);
    } else {
      return res.status(501).json({
        error: "Issue instruction not available in installed SDK version",
        hint: "SDK may need updating",
      });
    }

    const serialized = tx
      .serialize({ requireAllSignatures: false })
      .toString("base64");

    res.json({
      gateway: gw.public_key,
      already_issued: false,
      transaction: serialized,
    });
  } catch (e) {
    console.error("issue error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /gateways/:mac/onboard — generate onboard transaction
// ---------------------------------------------------------------------------
app.post("/gateways/:mac/onboard", async (req, res) => {
  try {
    const { mac } = req.params;
    const { owner, location, elevation, gain } = req.body;

    if (!owner) {
      return res.status(400).json({ error: "Missing owner address" });
    }

    let ownerPubkey;
    try {
      ownerPubkey = new PublicKey(owner);
    } catch {
      return res.status(400).json({ error: "Invalid owner address" });
    }

    const gw = await getGatewayByMac(mac);
    if (!gw.public_key) {
      return res.status(400).json({ error: "Gateway has no public key" });
    }

    const { entityManagerSdk: emSdk } = await loadSdks();

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: ownerPubkey,
      lastValidBlockHeight,
    });

    // Build onboard options
    const onboardOpts = {
      entityKey: gw.public_key,
      owner: ownerPubkey,
      payer: ownerPubkey,
      connection,
      subDao: IOT_SUB_DAO,
    };

    // Add location if provided (H3 cell index)
    if (location) {
      onboardOpts.location = location;
    }
    if (elevation !== undefined) {
      onboardOpts.elevation = elevation;
    }
    if (gain !== undefined) {
      onboardOpts.gain = gain;
    }

    // Build the onboard instruction
    if (emSdk.onboardDataOnlyIotHotspotV0) {
      const ix = await emSdk.onboardDataOnlyIotHotspotV0(onboardOpts);
      tx.add(ix);
    } else if (emSdk.dataOnlyOnboardIotIx) {
      const ix = await emSdk.dataOnlyOnboardIotIx(onboardOpts);
      tx.add(ix);
    } else {
      return res.status(501).json({
        error: "Onboard instruction not available in installed SDK version",
        hint: "SDK may need updating",
      });
    }

    const serialized = tx
      .serialize({ requireAllSignatures: false })
      .toString("base64");

    res.json({
      gateway: gw.public_key,
      already_onboarded: false,
      transaction: serialized,
    });
  } catch (e) {
    console.error("onboard error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", solana_rpc: SOLANA_RPC });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Helium onboard service listening on 127.0.0.1:${PORT}`);
  console.log(`Solana RPC: ${SOLANA_RPC}`);
  console.log(`Multi-gateway API: ${MULTI_GW_API}`);
});
