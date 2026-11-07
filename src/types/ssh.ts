/** 与 Rust 端 DTO 对齐（src-tauri/src/commands/ssh.rs，camelCase 序列化） */

export type AuthMethod = "password" | "public_key" | "agent";
export type IdentityMode = "single" | "device_pool";

export interface DeviceIdentityDto {
  id: string;
  keyAlgorithm: string;
  fingerprint: string;
  displayName: string | null;
  trustStatus: "pending" | "trusted" | "revoked";
  lastSeenAt: number | null;
}

export interface ConnectionProfileDto {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  identityMode: IdentityMode;
  keyPath: string | null;
  identities: DeviceIdentityDto[];
}

export type ConnectOutcome =
  | { status: "connected"; sessionId: string; deviceIdentityId: string; deviceName: string | null }
  | { status: "unknownIdentity"; keyAlgorithm: string; fingerprint: string }
  | { status: "identityChanged"; keyAlgorithm: string; fingerprint: string; expected: string[] }
  | { status: "authFailed"; message: string }
  | { status: "networkError"; message: string };

export interface SessionDto {
  sessionId: string;
  profileId: string;
  deviceIdentityId: string;
  deviceName: string | null;
  endpoint: string;
  connectedAt: number;
}

export interface ProfileInput {
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  /** 编辑时留空表示不修改 */
  password?: string;
  keyPath?: string;
  keyPassphrase?: string;
  identityMode: IdentityMode;
}

/** Rust 端 CmdError：{ code, message } */
export class CmdError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CmdError";
    this.code = code;
  }
}

export function wrapCmdError(err: unknown): CmdError {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const e = err as { code: string; message: string };
    return new CmdError(e.code, e.message);
  }
  return new CmdError("unknown", String(err));
}
