use async_trait::async_trait;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    File,
    Dir,
    Symlink,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: FileKind,
    pub size: u64,
    pub modified_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileContent {
    pub path: String,
    pub text: Option<String>,
    pub binary: bool,
    pub size: u64,
    pub modified_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WriteResult {
    pub size: u64,
    pub modified_ms: i64,
}

/// 文件系统错误。序列化形状：`{ code, message, currentMtimeMs?, size?, limit? }`，
/// 前端按 `code === "conflict"` 等分支处理（保存冲突不静默覆盖，路线图 §5.4）。
#[derive(Debug, thiserror::Error)]
pub enum FsError {
    #[error("IO 错误: {0}")]
    Io(String),
    #[error("文件在打开后被其他程序修改")]
    Conflict { current_mtime_ms: i64 },
    #[error("文件过大（{size} 字节，上限 {limit} 字节）")]
    TooLarge { size: u64, limit: u64 },
    #[error("非法路径: {0}")]
    InvalidPath(String),
    #[error("路径不存在: {0}")]
    NotFound(String),
    #[error("路径已存在: {0}")]
    AlreadyExists(String),
}

impl FsError {
    pub fn code(&self) -> &'static str {
        match self {
            FsError::Io(_) => "io",
            FsError::Conflict { .. } => "conflict",
            FsError::TooLarge { .. } => "too_large",
            FsError::InvalidPath(_) => "invalid_path",
            FsError::NotFound(_) => "not_found",
            FsError::AlreadyExists(_) => "already_exists",
        }
    }
}

impl Serialize for FsError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("FsError", 5)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        match self {
            FsError::Conflict { current_mtime_ms } => {
                s.serialize_field("currentMtimeMs", current_mtime_ms)?;
            }
            FsError::TooLarge { size, limit } => {
                s.serialize_field("size", size)?;
                s.serialize_field("limit", limit)?;
            }
            _ => {}
        }
        s.end()
    }
}

pub type FsResult<T> = Result<T, FsError>;

/// 超过该大小的文件拒绝读取（阈值后续按性能实测调整，§2.4）
pub const READ_LIMIT_BYTES: u64 = 20 * 1024 * 1024;

/// 统一文件系统 Provider（路线图 §5.2 接口示意）。
/// `expected_mtime_ms` 用于保存前冲突检测：与当前 mtime 不一致时返回 `FsError::Conflict`。
#[async_trait]
pub trait FileSystemProvider: Send + Sync {
    async fn list_dir(&self, path: &str) -> FsResult<Vec<FileEntry>>;
    async fn read_file(&self, path: &str) -> FsResult<FileContent>;
    async fn write_file(
        &self,
        path: &str,
        content: &str,
        expected_mtime_ms: Option<i64>,
    ) -> FsResult<WriteResult>;
    async fn create_dir(&self, path: &str) -> FsResult<()>;
    async fn create_file(&self, path: &str) -> FsResult<()>;
    async fn rename(&self, from: &str, to: &str) -> FsResult<()>;
    async fn delete(&self, path: &str, recursive: bool) -> FsResult<()>;
}

/// SystemTime → Unix 毫秒
pub fn system_time_to_ms(time: std::time::SystemTime) -> i64 {
    time.duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
