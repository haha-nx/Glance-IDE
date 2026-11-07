/** 与 Rust 端 DTO 对齐的类型定义（src-tauri/src/filesystem/provider.rs） */

export type FileKind = "file" | "dir" | "symlink";

export interface FileEntryDto {
  name: string;
  path: string;
  kind: FileKind;
  size: number;
  modifiedMs: number | null;
}

export interface FileContentDto {
  path: string;
  text: string | null;
  binary: boolean;
  size: number;
  modifiedMs: number;
}

export interface WriteResultDto {
  size: number;
  modifiedMs: number;
}

/** Rust 端 FsError 的序列化形式：{ code, message }（conflict 附加 currentMtimeMs） */
export interface FsErrorShape {
  code:
    | "io"
    | "conflict"
    | "too_large"
    | "binary"
    | "invalid_path"
    | "not_found"
    | "already_exists";
  message: string;
  currentMtimeMs?: number;
  size?: number;
  limit?: number;
}

export interface AppInfoDto {
  name: string;
  version: string;
}
