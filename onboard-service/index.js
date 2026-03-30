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

import express from "express";
import { Connection, PublicKey, Transaction, Keypair } from "@solana/web3.js";
import { createHash } from "crypto";
import { createRequire } from "module";
import bs58 from "bs58";

// createRequire lets us load CJS packages whose ESM builds are broken
const require = createRequire(import.meta.url);
const { AnchorProvider, Wallet } = require("@coral-xyz/anchor");

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

// Helium program addresses (mainnet)
const ENTITY_MANAGER_PROGRAM_ID = new PublicKey(
  "hemjuPXBpNvggtaUnN1MwT3wrdhttKEfosTcc2P9Pg8"
);
const HELIUM_SUB_DAOS_PROGRAM_ID = new PublicKey(
  "hdaoVTCqhfHHo75XdAMxBKdUqvq1i5bF23sisBqVgGR"
);
const HNT_MINT = new PublicKey(
  "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux"
);
const IOT_MINT = new PublicKey(
  "iotEVVZLEywoTn1QdwNPddxPWszn3zFhEot3MfL9fns"
);

// Derive DAO PDA from HNT mint: seeds = ["dao", hntMint]
const [HELIUM_DAO] = PublicKey.findProgramAddressSync(
  [Buffer.from("dao", "utf-8"), HNT_MINT.toBuffer()],
  HELIUM_SUB_DAOS_PROGRAM_ID
);

// Derive IOT sub_dao PDA from IOT mint: seeds = ["sub_dao", iotMint]
const [IOT_SUB_DAO] = PublicKey.findProgramAddressSync(
  [Buffer.from("sub_dao", "utf-8"), IOT_MINT.toBuffer()],
  HELIUM_SUB_DAOS_PROGRAM_ID
);

// ---------------------------------------------------------------------------
// PDA Derivation helpers (mirrors @helium/helium-entity-manager-sdk/pdas.ts)
// ---------------------------------------------------------------------------

/**
 * SHA-256 hash of the entity key, returned as a Buffer.
 * The Helium SDK decodes base58 entity keys to bytes, then hashes them.
 * This matches keyToAssetKey() in @helium/helium-entity-manager-sdk/pdas.ts
 */
function hashEntityKey(entityKey) {
  // Decode base58 string to raw bytes before hashing (matches SDK behaviour)
  const keyBytes = bs58.decode(entityKey);
  return createHash("sha256").update(keyBytes).digest();
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
 * Derive the rewardable_entity_config PDA for IoT:
 *   seeds = ["rewardable_entity_config", subDao, "IOT"]
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

/**
 * Derive the iot_info PDA:
 *   seeds = ["iot_info", rewardableEntityConfig, sha256(entityKey)]
 */
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

/**
 * Lazy-load the Helium Entity Manager SDK via CJS require
 * (their ESM builds have broken internal imports)
 */
async function loadSdk() {
  if (!entityManagerSdk) {
    try {
      entityManagerSdk = require("@helium/helium-entity-manager-sdk");
    } catch (e) {
      console.error("Failed to load entity-manager-sdk via require:", e.message);
      entityManagerSdk = await import("@helium/helium-entity-manager-sdk");
    }
  }
  return entityManagerSdk;
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
// Anchor provider & program instance (lazy-loaded via SDK's init())
// ---------------------------------------------------------------------------
let hemProgram = null;

// Read-only Anchor provider — we only build transactions, user signs in browser
const dummyWallet = new Wallet(Keypair.generate());
const provider = new AnchorProvider(connection, dummyWallet, {
  commitment: "confirmed",
});

async function getProgram() {
  if (!hemProgram) {
    const emSdk = await loadSdk();
    // init() expects an AnchorProvider
    hemProgram = await emSdk.init(provider);
  }
  return hemProgram;
}

// ---------------------------------------------------------------------------
// Cached on-chain data from DataOnlyConfigV0 (fetched on first use)
// ---------------------------------------------------------------------------
let cachedDocData = null;

async function getDataOnlyConfigData() {
  if (!cachedDocData) {
    const program = await getProgram();
    const emSdk = await loadSdk();
    const dataOnlyConfigKey = deriveDataOnlyConfigKey();
    const docAccount = await program.account.dataOnlyConfigV0.fetch(
      dataOnlyConfigKey
    );
    const [entityCreator] = emSdk.entityCreatorKey(dataOnlyConfigKey);

    cachedDocData = {
      dataOnlyConfig: dataOnlyConfigKey,
      collection: docAccount.collection,
      merkleTree: docAccount.merkleTree,
      dao: HELIUM_DAO,
      entityCreator,
    };
    console.log("Cached dataOnlyConfig data:", {
      collection: cachedDocData.collection.toBase58(),
      merkleTree: cachedDocData.merkleTree.toBase58(),
      entityCreator: cachedDocData.entityCreator.toBase58(),
    });
  }
  return cachedDocData;
}

// ---------------------------------------------------------------------------
// POST /gateways/:mac/issue — generate issue-entity transaction
// Uses the Anchor program directly to build issue_data_only_entity_v0 ix
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

    const gw = await getGatewayByMac(mac);
    if (!gw.public_key) {
      return res.status(400).json({ error: "Gateway has no public key" });
    }

    // Check if already issued
    const ktaKey = deriveKeyToAsset(HELIUM_DAO, gw.public_key);
    const existingEntity = await connection.getAccountInfo(ktaKey);
    if (existingEntity) {
      return res.json({
        gateway: gw.public_key,
        already_issued: true,
        message: "Entity already exists on-chain",
      });
    }

    const program = await getProgram();
    const docData = await getDataOnlyConfigData();

    // Encode the entity key as raw bytes (bs58 decode) — matches SDK's encodeEntityKey()
    const entityKeyBytes = Buffer.from(bs58.decode(gw.public_key));

    // Build the issue_data_only_entity_v0 instruction
    // Pass key accounts explicitly; SDK resolvers derive the rest
    // (collectionMetadata, collectionMasterEdition, treeAuthority,
    //  keyToAsset, dataOnlyEscrow, bubblegumSigner, program addresses)
    const ix = await program.methods
      .issueDataOnlyEntityV0({
        entityKey: entityKeyBytes,
      })
      .accounts({
        payer: ownerPubkey,
        eccVerifier: ownerPubkey,
        dataOnlyConfig: docData.dataOnlyConfig,
        collection: docData.collection,
        merkleTree: docData.merkleTree,
        dao: docData.dao,
        entityCreator: docData.entityCreator,
        recipient: ownerPubkey,
      })
      .instruction();

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: ownerPubkey,
      lastValidBlockHeight,
    });
    tx.add(ix);

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
// POST /gateways/:mac/onboard — generate onboard-data-only-iot transaction
//
// After issue, the entity is a compressed NFT in a Bubblegum merkle tree.
// To onboard, we need proof data from a DAS-compatible RPC (e.g. Helius).
// ---------------------------------------------------------------------------
const DAS_RPC =
  process.env.DAS_RPC_URL || process.env.SOLANA_RPC_URL || SOLANA_RPC;

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

    // Check if already IoT-onboarded
    const rewardableEntityConfig = deriveRewardableEntityConfigKey(IOT_SUB_DAO);
    const iotInfoKey = deriveIotInfoKey(rewardableEntityConfig, gw.public_key);
    const existingIotInfo = await connection.getAccountInfo(iotInfoKey);
    if (existingIotInfo) {
      return res.json({
        gateway: gw.public_key,
        already_onboarded: true,
        message: "Hotspot already onboarded to IoT network",
      });
    }

    // Verify entity was issued (key_to_asset must exist)
    const ktaKey = deriveKeyToAsset(HELIUM_DAO, gw.public_key);
    const ktaInfo = await connection.getAccountInfo(ktaKey);
    if (!ktaInfo) {
      return res.status(400).json({
        error: "Entity not yet issued. Call /issue first.",
      });
    }

    // Fetch the compressed NFT asset info from DAS API
    // The key_to_asset account stores the asset_id
    // We need the asset proof for the onboard instruction
    const ktaAccount = await (await getProgram()).account.keyToAssetV0.fetch(
      ktaKey
    );
    const assetId = ktaAccount.asset;

    // Get asset proof from DAS RPC
    const [assetRes, proofRes] = await Promise.all([
      fetch(DAS_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "get-asset",
          method: "getAsset",
          params: { id: assetId.toBase58() },
        }),
      }),
      fetch(DAS_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "get-proof",
          method: "getAssetProof",
          params: { id: assetId.toBase58() },
        }),
      }),
    ]);

    const assetData = await assetRes.json();
    const proofData = await proofRes.json();

    if (assetData.error || proofData.error) {
      const dasErr = assetData.error?.message || proofData.error?.message;
      return res.status(502).json({
        error: `DAS API error: ${dasErr}. You may need a DAS-compatible RPC like Helius.`,
      });
    }

    const asset = assetData.result;
    const proof = proofData.result;

    const program = await getProgram();
    const dataOnlyConfig = deriveDataOnlyConfigKey();

    // Build the remaining accounts (merkle proof nodes)
    const proofNodes = proof.proof.map((p) => ({
      pubkey: new PublicKey(p),
      isSigner: false,
      isWritable: false,
    }));

    // Build onboard_data_only_iot_hotspot_v0 instruction
    const { BN } = require("@coral-xyz/anchor");

    const ix = await program.methods
      .onboardDataOnlyIotHotspotV0({
        dataHash: [...Buffer.from(asset.compression.data_hash.replace("0x", ""), "hex")],
        creatorHash: [...Buffer.from(asset.compression.creator_hash.replace("0x", ""), "hex")],
        root: [...Buffer.from(proof.root.replace("0x", ""), "hex")],
        index: asset.compression.leaf_id,
        location: location ? new BN(location) : null,
        elevation: elevation !== undefined ? elevation : null,
        gain: gain !== undefined ? gain : null,
      })
      .accounts({
        payer: ownerPubkey,
        dcFeePayer: ownerPubkey,
        hotspotOwner: ownerPubkey,
        dataOnlyConfig,
        rewardableEntityConfig,
        merkleTree: new PublicKey(proof.tree_id),
        keyToAsset: ktaKey,
      })
      .remainingAccounts(proofNodes)
      .instruction();

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: ownerPubkey,
      lastValidBlockHeight,
    });
    tx.add(ix);

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
app.get("/health", async (req, res) => {
  // Derive key PDAs and optionally verify on-chain
  let dataOnlyConfig, dataOnlyConfigExists;
  try {
    dataOnlyConfig = deriveDataOnlyConfigKey().toBase58();
    if (req.query.verify) {
      const info = await connection.getAccountInfo(new PublicKey(dataOnlyConfig));
      dataOnlyConfigExists = !!info;
    }
  } catch (e) {
    dataOnlyConfig = `error: ${e.message}`;
  }

  res.json({
    status: "ok",
    solana_rpc: SOLANA_RPC,
    entity_manager: ENTITY_MANAGER_PROGRAM_ID.toBase58(),
    helium_dao: HELIUM_DAO.toBase58(),
    iot_sub_dao: IOT_SUB_DAO.toBase58(),
    data_only_config: dataOnlyConfig,
    ...(req.query.verify && { data_only_config_exists: dataOnlyConfigExists }),
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Helium onboard service listening on 127.0.0.1:${PORT}`);
  console.log(`Solana RPC: ${SOLANA_RPC}`);
  console.log(`Multi-gateway API: ${MULTI_GW_API}`);
  console.log(`Helium DAO: ${HELIUM_DAO.toBase58()}`);
  console.log(`IOT Sub-DAO: ${IOT_SUB_DAO.toBase58()}`);
  console.log(
    `Data-only config PDA: ${deriveDataOnlyConfigKey().toBase58()}`
  );
});
