/**
 * PrivateLend — Arcium MXE Client
 * Handles encryption of sensitive lending values and
 * fetching ZK proofs from the Arcium MXE cluster.
 */

import { PublicKey } from "@solana/web3.js";

const MXE_CLUSTER_URL = "https://mxe.arcium.network/devnet";

export interface EncryptedPosition {
  collateralCiphertext: Uint8Array;
  borrowCiphertext: Uint8Array;
  mxeComputationId: bigint;
}

export interface MxeProof {
  computationId: bigint;
  poolKey: PublicKey;
  proofType: ProofType;
  signature: Uint8Array;
  publicInputs: Uint8Array;
}

export enum ProofType {
  LtvWithinBounds = 0,
  HealthBelowOne = 1,
  RepaymentSufficient = 2,
}

export async function encryptAndProvePosition(params: {
  collateralAmount: bigint;
  borrowAmount: bigint;
  collateralPriceUsd: number;
  maxLtv: number;
  poolKey: PublicKey;
}): Promise<{ encrypted: EncryptedPosition; proof: MxeProof }> {
  const { collateralAmount, borrowAmount, collateralPriceUsd, maxLtv, poolKey } = params;

  const encKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );

  const colBytes = bigintToBytes(collateralAmount, 8);
  const borBytes = bigintToBytes(borrowAmount, 8);
  const colIv = crypto.getRandomValues(new Uint8Array(12));
  const borIv = crypto.getRandomValues(new Uint8Array(12));

  const colEnc = await crypto.subtle.encrypt({ name: "AES-GCM", iv: colIv }, encKey, colBytes);
  const borEnc = await crypto.subtle.encrypt({ name: "AES-GCM", iv: borIv }, encKey, borBytes);

  const collateralCiphertext = packCiphertext(colIv, new Uint8Array(colEnc));
  const borrowCiphertext = packCiphertext(borIv, new Uint8Array(borEnc));

  const mxeResponse = await submitToMxe({
    collateralCiphertext,
    borrowCiphertext,
    collateralPriceUsd,
    maxLtv,
    poolKey,
  });

  return {
    encrypted: {
      collateralCiphertext,
      borrowCiphertext,
      mxeComputationId: mxeResponse.computationId,
    },
    proof: mxeResponse.proof,
  };
}

export async function requestLiquidationProof(params: {
  positionAddress: PublicKey;
  poolKey: PublicKey;
  currentPriceUsd: number;
}): Promise<MxeProof | null> {
  const { positionAddress, poolKey, currentPriceUsd } = params;

  const response = await fetch(`${MXE_CLUSTER_URL}/liquidation-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      position: positionAddress.toBase58(),
      pool: poolKey.toBase58(),
      currentPriceUsd,
    }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  if (!data.liquidatable) return null;

  return {
    computationId: BigInt(data.computationId),
    poolKey,
    proofType: ProofType.HealthBelowOne,
    signature: hexToBytes(data.signature),
    publicInputs: hexToBytes(data.publicInputs),
  };
}

async function submitToMxe(params: {
  collateralCiphertext: Uint8Array;
  borrowCiphertext: Uint8Array;
  collateralPriceUsd: number;
  maxLtv: number;
  poolKey: PublicKey;
}): Promise<{ computationId: bigint; proof: MxeProof }> {
  const response = await fetch(`${MXE_CLUSTER_URL}/prove-ltv`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      collateralCiphertext: bytesToHex(params.collateralCiphertext),
      borrowCiphertext: bytesToHex(params.borrowCiphertext),
      collateralPriceUsd: params.collateralPriceUsd,
      maxLtv: params.maxLtv,
      pool: params.poolKey.toBase58(),
    }),
  });

  if (!response.ok) throw new Error(`MXE proof request failed: ${response.statusText}`);

  const data = await response.json();
  return {
    computationId: BigInt(data.computationId),
    proof: {
      computationId: BigInt(data.computationId),
      poolKey: params.poolKey,
      proofType: ProofType.LtvWithinBounds,
      signature: hexToBytes(data.signature),
      publicInputs: hexToBytes(data.publicInputs),
    },
  };
}

function packCiphertext(iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const out = new Uint8Array(64);
  out.set(iv.slice(0, 12), 0);
  out.set(ciphertext.slice(0, 52), 12);
  return out;
}

function bigintToBytes(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
