/**
 * Helium IoT Hotspot Onboarding Service
 *
 * Based on heliumtools.org multi-gateway by Joey Hiller.
 * Handles issuing data-only entities and onboarding hotspots via Solana.
 *
 * Endpoints:
 *   POST /onchain              — batch check on-chain status for pubkeys
 *   POST /gateways/:mac/issue  — generate issue-entity transaction (ECC-verified)
 *   POST /gateways/:mac/onboard — generate onboard transaction
 *   GET  /health               — health check
 */

import express from "express";
import {
  Connection,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { sign } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { sha256 as sha256Hash } from "js-sha256";
import bs58 from "bs58";

// noble/ed25519 v2 needs sha512 configured
import * as ed from "@noble/ed25519";
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.ONBOARD_PORT || 3001;
const SOLANA_RPC =
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const DAS_RPC =
  process.env.DAS_RPC_URL || process.env.SOLANA_RPC_URL || SOLANA_RPC;
const MULTI_GW_API = process.env.MULTI_GW_API || "http://127.0.0.1:4468";
const MULTI_GW_READ_KEY = process.env.MULTI_GW_READ_KEY || "";
const KEYS_DIR =
  process.env.GATEWAY_KEYS_DIR || "/var/lib/helium-multi-gateway/keys";

const ECC_VERIFIER = new PublicKey(
  "eccSAJM3tq7nQSpQTm8roxv4FPoipCkMsGizW2KBhqZ"
);
const ECC_VERIFIER_URL = "https://ecc-verifier.web.helium.io";

const connection = new Connection(SOLANA_RPC, "confirmed");

// ---------------------------------------------------------------------------
// Program IDs & constants
// ---------------------------------------------------------------------------
const ENTITY_MANAGER = new PublicKey(
  "hemjuPXBpNvggtaUnN1MwT3wrdhttKEfosTcc2P9Pg8"
);
const SUB_DAOS = new PublicKey(
  "hdaoVTCqhfHHo75XdAMxBKdUqvq1i5bF23sisBqVgGR"
);
const BUBBLEGUM = new PublicKey(
  "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY"
);
const COMPRESSION = new PublicKey(
  "cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK"
);
const DATA_CREDITS = new PublicKey(
  "credMBJhYFzfn7NxBMdU4aUqFggAjgztaCcv2Fo6fPT"
);
const TOKEN_METADATA = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);
const SPL_NOOP = new PublicKey(
  "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV"
);
const SPL_TOKEN = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const SPL_ATA = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);
const HNT_MINT = new PublicKey(
  "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux"
);
const IOT_MINT = new PublicKey(
  "iotEVVZLEywoTn1QdwNPddxPWszn3zFhEot3MfL9fns"
);
const DC_MINT = new PublicKey(
  "dcuc8Amr83Wz27ZkQ2K9NS6r8zRpf1J6cvArEBDZDmm"
);

// ---------------------------------------------------------------------------
// PDA helpers
// ---------------------------------------------------------------------------
function findPDA(seeds, programId) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

// Static PDAs (computed once at module load)
const DAO_KEY = findPDA(
  [Buffer.from("dao"), HNT_MINT.toBuffer()],
  SUB_DAOS
);
const IOT_SUB_DAO_KEY = findPDA(
  [Buffer.from("sub_dao"), IOT_MINT.toBuffer()],
  SUB_DAOS
);
const DATA_ONLY_CONFIG_KEY = findPDA(
  [Buffer.from("data_only_config"), DAO_KEY.toBuffer()],
  ENTITY_MANAGER
);
const DATA_ONLY_ESCROW_KEY = findPDA(
  [Buffer.from("data_only_escrow"), DATA_ONLY_CONFIG_KEY.toBuffer()],
  ENTITY_MANAGER
);
const ENTITY_CREATOR_KEY = findPDA(
  [Buffer.from("entity_creator"), DAO_KEY.toBuffer()],
  ENTITY_MANAGER
);
const REWARDABLE_ENTITY_CONFIG_KEY = findPDA(
  [
    Buffer.from("rewardable_entity_config"),
    IOT_SUB_DAO_KEY.toBuffer(),
    Buffer.from("IOT"),
  ],
  ENTITY_MANAGER
);
const DC_KEY = findPDA(
  [Buffer.from("dc"), DC_MINT.toBuffer()],
  DATA_CREDITS
);
const BUBBLEGUM_SIGNER_KEY = findPDA(
  [Buffer.from("collection_cpi")],
  BUBBLEGUM
);

// Dynamic PDAs
function entityKeyHash(gatewayPubkeyB58) {
  const bytes = bs58.decode(gatewayPubkeyB58);
  return Buffer.from(sha256Hash.arrayBuffer(bytes));
}

function keyToAssetKey(gatewayPubkeyB58) {
  return findPDA(
    [
      Buffer.from("key_to_asset"),
      DAO_KEY.toBuffer(),
      entityKeyHash(gatewayPubkeyB58),
    ],
    ENTITY_MANAGER
  );
}

function iotInfoKey(gatewayPubkeyB58) {
  return findPDA(
    [
      Buffer.from("iot_info"),
      REWARDABLE_ENTITY_CONFIG_KEY.toBuffer(),
      entityKeyHash(gatewayPubkeyB58),
    ],
    ENTITY_MANAGER
  );
}

function collectionMetadataKey(collection) {
  return findPDA(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA.toBuffer(),
      collection.toBuffer(),
    ],
    TOKEN_METADATA
  );
}

function collectionMasterEditionKey(collection) {
  return findPDA(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA.toBuffer(),
      collection.toBuffer(),
      Buffer.from("edition"),
    ],
    TOKEN_METADATA
  );
}

function treeAuthorityKey(merkleTree) {
  return findPDA([merkleTree.toBuffer()], BUBBLEGUM);
}

function ataAddress(owner, mint) {
  return findPDA(
    [owner.toBuffer(), SPL_TOKEN.toBuffer(), mint.toBuffer()],
    SPL_ATA
  );
}

// ---------------------------------------------------------------------------
// Anchor discriminator helper
// ---------------------------------------------------------------------------
function anchorDiscriminator(name) {
  const hash = sha256Hash(`global:${name}`);
  return Buffer.from(hash.slice(0, 16), "hex");
}

// ---------------------------------------------------------------------------
// Gateway key management
// ---------------------------------------------------------------------------

/**
 * Read a gateway key file.
 * Format: 1 byte type (0x01 = Ed25519) + 32 byte seed + 32 byte public key
 * Returns { seed, publicKey, heliumPubkey } where heliumPubkey includes the type prefix.
 */
function readGatewayKey(mac) {
  const keyPath = `${KEYS_DIR}/${mac.toUpperCase()}.key`;
  const raw = readFileSync(keyPath);

  if (raw.length !== 65) {
    throw new Error(
      `Invalid key file length: expected 65, got ${raw.length}`
    );
  }

  const keyType = raw[0]; // 0x01 = Ed25519
  const seed = raw.slice(1, 33); // 32-byte private seed
  const pubBytes = raw.slice(33, 65); // 32-byte public key

  // Helium public key is type-prefixed: [keyType, ...pubBytes]
  const heliumPubkey = Buffer.concat([Buffer.from([keyType]), pubBytes]);

  return { seed, publicKey: pubBytes, heliumPubkey };
}

/**
 * Create and sign a BlockchainTxnAddGatewayV1 protobuf.
 * Returns { unsigned_msg (hex), gateway_signature (hex) }
 *
 * Protobuf fields:
 *   1: gateway (bytes) — Helium public key with type prefix
 *   2: owner (bytes)   — Solana address bytes
 *   4: payer (bytes)   — Solana address bytes
 *   5: gateway_signature (bytes)
 */
function encodeProtobufBytes(fieldNum, data) {
  // Wire type 2 (length-delimited)
  const tag = (fieldNum << 3) | 2;
  const tagBytes = [];
  let t = tag;
  while (t > 0x7f) {
    tagBytes.push((t & 0x7f) | 0x80);
    t >>>= 7;
  }
  tagBytes.push(t);

  const lenBytes = [];
  let len = data.length;
  while (len > 0x7f) {
    lenBytes.push((len & 0x7f) | 0x80);
    len >>>= 7;
  }
  lenBytes.push(len);

  return Buffer.concat([
    Buffer.from(tagBytes),
    Buffer.from(lenBytes),
    Buffer.from(data),
  ]);
}

async function createAddGatewayTxn(mac, ownerPubkey) {
  const gwKey = readGatewayKey(mac);

  // Encode the unsigned protobuf (gateway + owner + payer, no signatures)
  const ownerBytes = ownerPubkey.toBuffer();
  const unsignedMsg = Buffer.concat([
    encodeProtobufBytes(1, gwKey.heliumPubkey), // gateway
    encodeProtobufBytes(2, ownerBytes), // owner
    encodeProtobufBytes(4, ownerBytes), // payer (same as owner)
  ]);

  // Sign the unsigned message with the gateway's Ed25519 seed
  const signature = await ed.signAsync(unsignedMsg, gwKey.seed);

  return {
    unsigned_msg: Buffer.from(unsignedMsg).toString("hex"),
    gateway_signature: Buffer.from(signature).toString("hex"),
  };
}

// ---------------------------------------------------------------------------
// Fetch gateway info from multi-gateway API
// ---------------------------------------------------------------------------
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
// Build issueDataOnlyEntityV0 instruction
// (based on heliumtools.org by Joey Hiller)
// ---------------------------------------------------------------------------
function buildIssueInstruction(
  owner,
  gatewayPubkeyB58,
  merkleTree,
  collection
) {
  const entityKey = bs58.decode(gatewayPubkeyB58);

  // Anchor format: discriminator(8) + borsh(Vec<u8>) = disc + u32_le(len) + bytes
  const disc = anchorDiscriminator("issue_data_only_entity_v0");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(entityKey.length);
  const data = Buffer.concat([disc, lenBuf, Buffer.from(entityKey)]);

  const accounts = [
    { pubkey: owner, isSigner: true, isWritable: true }, // payer
    { pubkey: ECC_VERIFIER, isSigner: true, isWritable: false }, // ecc_verifier
    { pubkey: collection, isSigner: false, isWritable: false }, // collection
    {
      pubkey: collectionMetadataKey(collection),
      isSigner: false,
      isWritable: true,
    }, // collection_metadata
    {
      pubkey: collectionMasterEditionKey(collection),
      isSigner: false,
      isWritable: false,
    }, // collection_master_edition
    { pubkey: DATA_ONLY_CONFIG_KEY, isSigner: false, isWritable: true }, // data_only_config
    { pubkey: ENTITY_CREATOR_KEY, isSigner: false, isWritable: false }, // entity_creator
    { pubkey: DAO_KEY, isSigner: false, isWritable: false }, // dao
    {
      pubkey: keyToAssetKey(gatewayPubkeyB58),
      isSigner: false,
      isWritable: true,
    }, // key_to_asset
    {
      pubkey: treeAuthorityKey(merkleTree),
      isSigner: false,
      isWritable: true,
    }, // tree_authority
    { pubkey: owner, isSigner: false, isWritable: false }, // recipient
    { pubkey: merkleTree, isSigner: false, isWritable: true }, // merkle_tree
    { pubkey: DATA_ONLY_ESCROW_KEY, isSigner: false, isWritable: true }, // data_only_escrow
    { pubkey: BUBBLEGUM_SIGNER_KEY, isSigner: false, isWritable: false }, // bubblegum_signer
    { pubkey: TOKEN_METADATA, isSigner: false, isWritable: false }, // token_metadata_program
    { pubkey: SPL_NOOP, isSigner: false, isWritable: false }, // log_wrapper
    { pubkey: BUBBLEGUM, isSigner: false, isWritable: false }, // bubblegum_program
    { pubkey: COMPRESSION, isSigner: false, isWritable: false }, // compression_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
  ];

  return new TransactionInstruction({
    keys: accounts,
    programId: ENTITY_MANAGER,
    data,
  });
}

// ---------------------------------------------------------------------------
// Build onboardDataOnlyIotHotspotV0 instruction
// ---------------------------------------------------------------------------
function encodeOptionU64(hexStr) {
  if (!hexStr) return Buffer.from([0]);
  const buf = Buffer.alloc(9);
  buf[0] = 1;
  buf.writeBigUInt64LE(BigInt("0x" + hexStr), 1);
  return buf;
}

function encodeOptionI32(value) {
  if (value === null || value === undefined) return Buffer.from([0]);
  const buf = Buffer.alloc(5);
  buf[0] = 1;
  buf.writeInt32LE(value, 1);
  return buf;
}

function buildOnboardInstruction(
  owner,
  gatewayPubkeyB58,
  merkleTree,
  asset,
  proof,
  canopyDepth,
  opts = {}
) {
  const disc = anchorDiscriminator("onboard_data_only_iot_hotspot_v0");

  const dataHash = Buffer.from(bs58.decode(asset.compression.data_hash));
  const creatorHash = Buffer.from(bs58.decode(asset.compression.creator_hash));
  const root = Buffer.from(bs58.decode(proof.root));
  const indexBuf = Buffer.alloc(4);
  indexBuf.writeUInt32LE(asset.compression.leaf_id);

  const data = Buffer.concat([
    disc,
    dataHash,
    creatorHash,
    root,
    indexBuf,
    encodeOptionU64(opts.location),
    encodeOptionI32(opts.elevation),
    encodeOptionI32(opts.gain),
  ]);

  const accounts = [
    { pubkey: owner, isSigner: true, isWritable: true }, // payer
    { pubkey: owner, isSigner: true, isWritable: true }, // dc_fee_payer
    {
      pubkey: iotInfoKey(gatewayPubkeyB58),
      isSigner: false,
      isWritable: true,
    }, // iot_info
    { pubkey: owner, isSigner: true, isWritable: true }, // hotspot_owner
    { pubkey: merkleTree, isSigner: false, isWritable: false }, // merkle_tree
    {
      pubkey: ataAddress(owner, DC_MINT),
      isSigner: false,
      isWritable: true,
    }, // dc_burner
    {
      pubkey: REWARDABLE_ENTITY_CONFIG_KEY,
      isSigner: false,
      isWritable: false,
    }, // rewardable_entity_config
    { pubkey: DATA_ONLY_CONFIG_KEY, isSigner: false, isWritable: false }, // data_only_config
    { pubkey: DAO_KEY, isSigner: false, isWritable: false }, // dao
    {
      pubkey: keyToAssetKey(gatewayPubkeyB58),
      isSigner: false,
      isWritable: false,
    }, // key_to_asset
    { pubkey: IOT_SUB_DAO_KEY, isSigner: false, isWritable: true }, // sub_dao
    { pubkey: DC_MINT, isSigner: false, isWritable: true }, // dc_mint
    { pubkey: DC_KEY, isSigner: false, isWritable: false }, // dc
    { pubkey: COMPRESSION, isSigner: false, isWritable: false }, // compression_program
    { pubkey: DATA_CREDITS, isSigner: false, isWritable: false }, // data_credits_program
    { pubkey: SPL_TOKEN, isSigner: false, isWritable: false }, // token_program
    { pubkey: SPL_ATA, isSigner: false, isWritable: false }, // associated_token_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    { pubkey: SUB_DAOS, isSigner: false, isWritable: false }, // helium_sub_daos_program
  ];

  // Proof accounts, trimmed by canopy depth
  const proofPath = proof.proof.slice(
    0,
    proof.proof.length - canopyDepth
  );
  for (const proofKey of proofPath) {
    accounts.push({
      pubkey: new PublicKey(proofKey),
      isSigner: false,
      isWritable: false,
    });
  }

  return new TransactionInstruction({
    keys: accounts,
    programId: ENTITY_MANAGER,
    data,
  });
}

// ---------------------------------------------------------------------------
// DAS API helpers
// ---------------------------------------------------------------------------
async function fetchAsset(rpcUrl, assetId) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAsset",
      params: { id: assetId },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`getAsset: ${data.error.message}`);
  return data.result;
}

async function fetchAssetProof(rpcUrl, assetId) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAssetProof",
      params: { id: assetId },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`getAssetProof: ${data.error.message}`);
  return data.result;
}

function getCanopyDepth(treeAccountData) {
  const maxBufferSize = treeAccountData.readUInt32LE(2);
  const maxDepth = treeAccountData.readUInt32LE(6);
  const headerSize = 56;
  const changeLogEntrySize = 32 + maxDepth * 32 + 4 + 4;
  const treeDataSize = 24 + maxBufferSize * changeLogEntrySize + maxDepth * 32;
  const canopyBytes = treeAccountData.length - headerSize - treeDataSize;
  if (canopyBytes <= 0) return 0;
  return Math.floor(Math.log2(canopyBytes / 32 + 2)) - 1;
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
        const ktaKey = keyToAssetKey(pk);
        const accountInfo = await connection.getAccountInfo(ktaKey);

        if (accountInfo) {
          const iotKey = iotInfoKey(pk);
          const iotInfo = await connection.getAccountInfo(iotKey);
          const hasLocation = iotInfo && iotInfo.data.length > 41 && iotInfo.data[41] === 1;
          results[pk] = {
            onchain: true,
            iot_onboarded: !!iotInfo,
            has_location: hasLocation,
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
// POST /gateways/:mac/issue — issue entity via ECC verifier
// (based on heliumtools.org by Joey Hiller)
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

    const gatewayPubkey = gw.public_key;

    // Check if already issued
    const ktaKey = keyToAssetKey(gatewayPubkey);
    const existingEntity = await connection.getAccountInfo(ktaKey);
    if (existingEntity) {
      return res.json({
        gateway: gatewayPubkey,
        already_issued: true,
        transactions: [],
      });
    }

    // Step 1: Sign the add-gateway message with the gateway's key
    console.log(`Signing add-gateway for ${mac}...`);
    const addTxnData = await createAddGatewayTxn(mac, ownerPubkey);

    // Step 2: Read on-chain config to get collection + merkle tree
    const [configAccount, { blockhash }] = await Promise.all([
      connection.getAccountInfo(DATA_ONLY_CONFIG_KEY),
      connection.getLatestBlockhash(),
    ]);

    if (!configAccount) {
      return res
        .status(500)
        .json({ error: "DataOnlyConfig account not found on-chain" });
    }

    // DataOnlyConfigV0 layout: discriminator(8) + authority(32) + bumpSeed(1) + collection(32) + merkleTree(32)
    const COLLECTION_OFFSET = 8 + 32 + 1;
    const MERKLE_OFFSET = COLLECTION_OFFSET + 32;
    const configData = configAccount.data;
    const collection = new PublicKey(
      configData.slice(COLLECTION_OFFSET, COLLECTION_OFFSET + 32)
    );
    const merkleTree = new PublicKey(
      configData.slice(MERKLE_OFFSET, MERKLE_OFFSET + 32)
    );

    // Step 3: Build the Solana transaction
    const issueIx = buildIssueInstruction(
      ownerPubkey,
      gatewayPubkey,
      merkleTree,
      collection
    );
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 300_000,
    });
    const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 1,
    });

    const message = new TransactionMessage({
      payerKey: ownerPubkey,
      recentBlockhash: blockhash,
      instructions: [computeBudgetIx, computePriceIx, issueIx],
    }).compileToLegacyMessage();

    const vtx = new VersionedTransaction(message);
    const serializedTx = Buffer.from(vtx.serialize()).toString("hex");

    // Step 4: Call the ECC verifier to co-sign
    console.log(`Calling ECC verifier for ${mac}...`);
    const verifyRes = await fetch(`${ECC_VERIFIER_URL}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transaction: serializedTx,
        msg: addTxnData.unsigned_msg,
        signature: addTxnData.gateway_signature,
      }),
    });

    if (!verifyRes.ok) {
      const errText = await verifyRes.text();
      console.error(`ECC verifier error: ${verifyRes.status} ${errText}`);
      return res
        .status(500)
        .json({ error: `ECC verifier failed: ${errText}` });
    }

    const verifyData = await verifyRes.json();
    const signedWire = Buffer.from(verifyData.transaction, "hex");

    console.log(`Issue transaction ready for ${mac}`);

    // Return the ECC-signed transaction for the frontend wallet to co-sign
    res.json({
      gateway: gatewayPubkey,
      already_issued: false,
      transactions: [
        { type: "issue", transaction: signedWire.toString("base64") },
      ],
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

    const gatewayPubkey = gw.public_key;

    // Check state: must be issued but not yet onboarded
    const ktaKey = keyToAssetKey(gatewayPubkey);
    const [ktaAccount, iotInfoAccount, configAccount] = await Promise.all([
      connection.getAccountInfo(ktaKey),
      connection.getAccountInfo(iotInfoKey(gatewayPubkey)),
      connection.getAccountInfo(DATA_ONLY_CONFIG_KEY),
    ]);

    if (!ktaAccount) {
      return res.status(400).json({
        error: "Gateway not yet issued on-chain. Run issue step first.",
      });
    }
    if (iotInfoAccount) {
      return res.json({
        gateway: gatewayPubkey,
        already_onboarded: true,
      });
    }

    // Get asset ID from key_to_asset account
    // Layout: discriminator(8) + dao(32) + asset(32) + ...
    const assetId = new PublicKey(ktaAccount.data.slice(40, 72)).toBase58();
    const MERKLE_OFFSET = 8 + 32 + 1 + 32;
    const merkleTree = new PublicKey(
      configAccount.data.slice(MERKLE_OFFSET, MERKLE_OFFSET + 32)
    );

    // Fetch DAS data, blockhash, and tree account in parallel
    const [asset, proof, { blockhash }, treeAccount] = await Promise.all([
      fetchAsset(DAS_RPC, assetId),
      fetchAssetProof(DAS_RPC, assetId),
      connection.getLatestBlockhash(),
      connection.getAccountInfo(merkleTree),
    ]);

    if (!treeAccount) {
      return res
        .status(500)
        .json({ error: "Merkle tree account not found" });
    }
    const canopyDepth = getCanopyDepth(treeAccount.data);

    const onboardIx = buildOnboardInstruction(
      ownerPubkey,
      gatewayPubkey,
      merkleTree,
      asset,
      proof,
      canopyDepth,
      {
        location: location || null,
        elevation: elevation ?? null,
        gain: gain ?? null,
      }
    );

    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 300_000,
    });
    const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 1,
    });

    const message = new TransactionMessage({
      payerKey: ownerPubkey,
      recentBlockhash: blockhash,
      instructions: [computeBudgetIx, computePriceIx, onboardIx],
    }).compileToLegacyMessage();

    const vtx = new VersionedTransaction(message);

    res.json({
      gateway: gatewayPubkey,
      already_onboarded: false,
      transactions: [{ transaction: Buffer.from(vtx.serialize()).toString("base64") }],
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
  res.json({
    status: "ok",
    solana_rpc: SOLANA_RPC,
    ecc_verifier: ECC_VERIFIER_URL,
    entity_manager: ENTITY_MANAGER.toBase58(),
    helium_dao: DAO_KEY.toBase58(),
    iot_sub_dao: IOT_SUB_DAO_KEY.toBase58(),
    data_only_config: DATA_ONLY_CONFIG_KEY.toBase58(),
    keys_dir: KEYS_DIR,
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Helium onboard service listening on 127.0.0.1:${PORT}`);
  console.log(`Solana RPC: ${SOLANA_RPC}`);
  console.log(`DAS RPC: ${DAS_RPC}`);
  console.log(`ECC Verifier: ${ECC_VERIFIER_URL}`);
  console.log(`Gateway keys: ${KEYS_DIR}`);
  console.log(`Helium DAO: ${DAO_KEY.toBase58()}`);
  console.log(`Data-only config: ${DATA_ONLY_CONFIG_KEY.toBase58()}`);
});
