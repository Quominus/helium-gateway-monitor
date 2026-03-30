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
const crypto = require("crypto");

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.ONBOARD_PORT || 3001;
const SOLANA_RPC =
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const MULTI_GW_API = process.env.MULTI_GW_API || "http://127.0.0.1:4468";
const MULTI_GW_READ_KEY = process.env.MULTI_GW_READ_KEY || "";

const connection = new Connection(SOLANA_RPC, "confirmed");

// Helium program addresses (mainnet) — only safe, known-valid base58
const ENTITY_MANAGER_PROGRAM_ID = new PublicKey(
  "hemjuPXBpNvggtaUnN1MwT3wrdhttKEfosTcc2P9Pg8"
);
const IOT_SUB_DAO = new PublicKey(
  "39Lw1RH6zt8AJvKn3BTxmUDofzduCM2J3kSaGDZ8L7Sk"
);
// The Helium DAO (parent of all sub-DAOs)
const HELIUM_DAO = new PublicKey(
  "hdaoVTCqhfHHo75XdAMxBKdUqvq1i5bF23sisBqVgGR"
);

// ---------------------------------------------------------------------------
// PDA Derivation helpers (mirrors @helium/helium-entity-manager-sdk/pdas.ts)
// ---------------------------------------------------------------------------

/**
 * SHA-256 hash of the entity key string, returned as a Buffer.
 * The Helium SDK hashes entity keys before using them as PDA seeds.
 */
function hashEntityKey(entityKey) {
  return crypto.createHash("sha256").update(entityKey).digest();
}

/**
 * Derive the data-only config PDA:
 *   seeds = ["data_only_config", dao]
 */
function deriveDataOnlyConfigKey(
  dao = HELIUM_DAO,
  programId = ENTITY_MANAGER_PROGRAM_ID
) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("data_only_config", "utf-8"), dao.toBuffer()],
    programId
  )[0];
}

/**
 * Derive the key_to_asset PDA:
 *   seeds = ["key_to_asset", dao, sha256(entityKey)]
 */
function deriveKeyToAsset(
  dao,
  entityKey,
  programId = ENTITY_MANAGER_PROGRAM_ID
) {
  const hashed = hashEntityKey(entityKey);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("key_to_asset", "utf-8"), dao.toBuffer(), hashed],
    programId
  )[0];
}

/**
 * Derive the iot_info PDA:
 *   seeds = ["iot_info", rewardableEntityConfig, sha256(entityKey)]
 *
 * rewardableEntityConfig is derived from the IoT sub-DAO.
 */
function deriveRewardableEntityConfigKey(
  subDao,
  programId = ENTITY_MANAGER_PROGRAM_ID
) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("rewardable_entity_config", "utf-8"),
      subDao.toBuffer(),
      Buffer.from("IOT", "utf-8"),
    ],
    programId
  )[0];
}

function deriveIotInfoKey(
  rewardableEntityConfig,
  entityKey,
  programId = ENTITY_MANAGER_PROGRAM_ID
) {
  const hashed = hashEntityKey(entityKey);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("iot_info", "utf-8"),
      rewardableEntityConfig.toBuffer(),
      hashed,
    ],
    programId
  )[0];
}

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

    const rewardableEntityConfig = deriveRewardableEntityConfigKey(IOT_SUB_DAO);
    const results = {};

    for (const pk of pubkeys) {
      try {
        // Derive key_to_asset PDA using SHA-256 hashed entity key
        const entityKey = deriveKeyToAsset(HELIUM_DAO, pk);
        const accountInfo = await connection.getAccountInfo(entityKey);

        if (accountInfo) {
          // Entity exists — check if IoT onboarded
          const iotInfoKey = deriveIotInfoKey(rewardableEntityConfig, pk);
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

    // Check if already issued
    const entityKey = deriveKeyToAsset(HELIUM_DAO, gw.public_key);
    const existingEntity = await connection.getAccountInfo(entityKey);
    if (existingEntity) {
      return res.json({
        gateway: gw.public_key,
        already_issued: true,
        message: "Entity already exists on-chain",
      });
    }

    const { entityManagerSdk: emSdk } = await loadSdks();

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: ownerPubkey,
      lastValidBlockHeight,
    });

    // Try known SDK function names for issuing data-only entities
    const issueOpts = {
      entityKey: gw.public_key,
      owner: ownerPubkey,
      payer: ownerPubkey,
      connection,
      dao: HELIUM_DAO,
      programId: ENTITY_MANAGER_PROGRAM_ID,
    };

    let ix;
    if (typeof emSdk.issueDataOnlyEntityV0 === "function") {
      ix = await emSdk.issueDataOnlyEntityV0(issueOpts);
    } else if (typeof emSdk.dataOnlyIssueEntityIx === "function") {
      ix = await emSdk.dataOnlyIssueEntityIx(issueOpts);
    } else if (typeof emSdk.issue_data_only_entity_v0 === "function") {
      ix = await emSdk.issue_data_only_entity_v0(issueOpts);
    } else {
      // List available exports to help debug
      const exports = Object.keys(emSdk).filter(
        (k) => typeof emSdk[k] === "function"
      );
      return res.status(501).json({
        error: "Issue instruction not available in installed SDK version",
        available_functions: exports.slice(0, 30),
        hint: "SDK may need updating or function name differs",
      });
    }

    if (Array.isArray(ix)) {
      ix.forEach((i) => tx.add(i));
    } else {
      tx.add(ix);
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
      dao: HELIUM_DAO,
      programId: ENTITY_MANAGER_PROGRAM_ID,
    };

    if (location) onboardOpts.location = location;
    if (elevation !== undefined) onboardOpts.elevation = elevation;
    if (gain !== undefined) onboardOpts.gain = gain;

    // Try known SDK function names for onboarding data-only IoT hotspots
    let ix;
    if (typeof emSdk.onboardDataOnlyIotHotspotV0 === "function") {
      ix = await emSdk.onboardDataOnlyIotHotspotV0(onboardOpts);
    } else if (typeof emSdk.dataOnlyOnboardIotIx === "function") {
      ix = await emSdk.dataOnlyOnboardIotIx(onboardOpts);
    } else if (typeof emSdk.onboardIotHotspot === "function") {
      ix = await emSdk.onboardIotHotspot(onboardOpts);
    } else if (typeof emSdk.onboard_data_only_iot_hotspot_v0 === "function") {
      ix = await emSdk.onboard_data_only_iot_hotspot_v0(onboardOpts);
    } else {
      const exports = Object.keys(emSdk).filter(
        (k) => typeof emSdk[k] === "function"
      );
      return res.status(501).json({
        error:
          "Onboard instruction not available in installed SDK version",
        available_functions: exports.slice(0, 30),
        hint: "SDK may need updating or function name differs",
      });
    }

    if (Array.isArray(ix)) {
      ix.forEach((i) => tx.add(i));
    } else {
      tx.add(ix);
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
  // Derive the data-only config to prove PDA derivation works
  let dataOnlyConfig;
  try {
    dataOnlyConfig = deriveDataOnlyConfigKey().toBase58();
  } catch (e) {
    dataOnlyConfig = `error: ${e.message}`;
  }

  res.json({
    status: "ok",
    solana_rpc: SOLANA_RPC,
    entity_manager: ENTITY_MANAGER_PROGRAM_ID.toBase58(),
    data_only_config: dataOnlyConfig,
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Helium onboard service listening on 127.0.0.1:${PORT}`);
  console.log(`Solana RPC: ${SOLANA_RPC}`);
  console.log(`Multi-gateway API: ${MULTI_GW_API}`);
  console.log(
    `Data-only config PDA: ${deriveDataOnlyConfigKey().toBase58()}`
  );
});
