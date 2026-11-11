//! 统一文件系统抽象。
//! 编辑器消费统一的资源 URI；LocalFileSystem 与 SftpFileSystem 分别实现。
//! 远程 URI 按设备身份隔离。

pub mod local;
pub mod provider;
pub mod remote_uri;
pub mod sftp;

pub use provider::{
    system_time_to_ms, FileContent, FileEntry, FileKind, FileSystemProvider, FsError, FsResult,
    WriteResult, READ_LIMIT_BYTES,
};
pub use remote_uri::ResourceUri;
