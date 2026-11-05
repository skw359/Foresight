/**
 * Map Prisma rows to the wire DTOs defined in @foresight/contract. All
 * timestamps become ISO-8601 strings; JSON columns are passed through with the
 * contract's types.
 */
import type {
  CameraCapabilities,
  CameraDTO,
  EncryptedKeyVault,
  HomeDTO,
  KdfParams,
  MemberRole,
  ThermalState,
  UserDTO,
  WifiInfo,
} from "@foresight/contract";
import type { Camera, Home, User } from "@prisma/client";

export function toUserDTO(u: User): UserDTO {
  return {
    id: u.id,
    identifier: u.identifier,
    firstName: u.firstName,
    createdAt: u.createdAt.toISOString(),
    isAdmin: u.isAdmin,
  };
}

/**
 * Reassemble the user's encrypted key vault from its four columns, or null when
 * the account has no keys yet (publicKey unset ⇒ run first-login key generation
 * client-side). The blobs are passed through verbatim — the server never opens
 * them.
 */
export function toKeyVault(u: User): EncryptedKeyVault | null {
  if (!u.publicKey || !u.wrappedPrivateKey || !u.keyNonce || !u.keyKdf) return null;
  return {
    publicKey: u.publicKey,
    wrappedPrivateKey: u.wrappedPrivateKey,
    nonce: u.keyNonce,
    kdf: u.keyKdf as unknown as KdfParams,
  };
}

/**
 * `recorderConsented` is computed by the caller (a recorder HomeKey row exists
 * at `h.keyEpoch`) and batched where lists are built — see lib/homeKeys.ts.
 */
export function toHomeDTO(h: Home, role: MemberRole, recorderConsented = false): HomeDTO {
  return {
    id: h.id,
    name: h.name,
    role,
    createdAt: h.createdAt.toISOString(),
    keyEpoch: h.keyEpoch,
    recorderConsented,
    keyRotationRequired: h.keyEpoch >= 1 && h.keyRotationRequired,
  };
}

export function toCameraDTO(c: Camera): CameraDTO {
  return {
    id: c.id,
    homeId: c.homeId,
    name: c.name,
    online: c.online,
    recordingEnabled: c.recordingEnabled,
    status: {
      battery: c.battery,
      charging: c.charging,
      wifi: (c.wifi as WifiInfo | null) ?? null,
      thermal: (c.thermal as ThermalState | null) ?? null,
      lastSeen: c.lastSeen ? c.lastSeen.toISOString() : null,
    },
    capabilities: (c.capabilities as CameraCapabilities | null) ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}
