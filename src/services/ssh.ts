import { invoke } from "@tauri-apps/api/core";
import {
  wrapCmdError,
  type ConnectOutcome,
  type ConnectionProfileDto,
  type ProfileInput,
  type SessionDto,
} from "../types/ssh";

export const sshApi = {
  async listProfiles(): Promise<ConnectionProfileDto[]> {
    try {
      return await invoke<ConnectionProfileDto[]>("list_profiles");
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  async createProfile(input: ProfileInput): Promise<ConnectionProfileDto> {
    try {
      return await invoke<ConnectionProfileDto>("create_profile", {
        name: input.name,
        host: input.host,
        port: input.port,
        username: input.username,
        authMethod: input.authMethod,
        password: input.password ?? null,
        keyPath: input.keyPath ?? null,
        keyPassphrase: input.keyPassphrase ?? null,
        identityMode: input.identityMode,
      });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  async updateProfile(profileId: string, input: ProfileInput): Promise<ConnectionProfileDto> {
    try {
      return await invoke<ConnectionProfileDto>("update_profile", {
        profileId,
        name: input.name,
        host: input.host,
        port: input.port,
        username: input.username,
        authMethod: input.authMethod,
        password: input.password ?? null,
        keyPath: input.keyPath ?? null,
        keyPassphrase: input.keyPassphrase ?? null,
        identityMode: input.identityMode,
      });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  async deleteProfile(profileId: string): Promise<void> {
    try {
      await invoke("delete_profile", { profileId });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  async connectProfile(profileId: string): Promise<ConnectOutcome> {
    try {
      return await invoke<ConnectOutcome>("connect_profile", { profileId });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  async approveIdentity(
    profileId: string,
    keyAlgorithm: string,
    fingerprint: string,
    displayName: string | null,
  ): Promise<void> {
    try {
      await invoke("approve_identity", {
        profileId,
        keyAlgorithm,
        fingerprint,
        displayName,
      });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  async unbindIdentity(profileId: string, deviceIdentityId: string): Promise<void> {
    try {
      await invoke("unbind_identity", { profileId, deviceIdentityId });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  async listSessions(): Promise<SessionDto[]> {
    try {
      return await invoke<SessionDto[]>("list_sessions");
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  async disconnectSession(sessionId: string): Promise<void> {
    try {
      await invoke("disconnect_session", { sessionId });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  async remoteHome(sessionId: string): Promise<string> {
    try {
      return await invoke<string>("remote_home", { sessionId });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  async setWindowRemoteDevice(deviceIdentityId: string | null): Promise<void> {
    try {
      await invoke("set_window_remote_device", { deviceIdentityId });
    } catch {
      /* 窗口关闭期间忽略 */
    }
  },

  async lspDetect(
    sessionId: string,
  ): Promise<
    {
      language: string;
      server: string;
      path: string | null;
      version: string | null;
      arch: string | null;
      available: boolean;
    }[]
  > {
    try {
      return await invoke("lsp_detect", { sessionId });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },

  async projectDetect(
    sessionId: string,
    workspaceRoot: string,
  ): Promise<{
    workspaceRoot: string;
    kind: string;
    details: string[];
    hasCompileCommands: boolean;
    compileDbFingerprint: string | null;
  }> {
    try {
      return await invoke("project_detect", { sessionId, workspaceRoot });
    } catch (err) {
      throw wrapCmdError(err);
    }
  },
};
