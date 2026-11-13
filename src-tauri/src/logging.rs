//! 应用轻量滚动日志实现（零额外外部依赖）。
//! Debug 模式输出到 stderr；所有构建均将日志按上限滚动写入应用日志目录下的 `glance.log`。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::Local;
use log::{LevelFilter, Log, Metadata, Record};

/// 单份日志文件大小上限（2 MiB）
const MAX_LOG_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// 最多保留的旧归档份数（glance.log.1 .. glance.log.2）
const MAX_LOG_BACKUPS: usize = 2;

struct FileLogSink {
    path: PathBuf,
    file: File,
    bytes_written: u64,
}

impl FileLogSink {
    fn open(path: PathBuf) -> std::io::Result<Self> {
        let existing_len = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self {
            path,
            file,
            bytes_written: existing_len,
        })
    }

    fn write_line(&mut self, line: &str) {
        let bytes = line.as_bytes();
        if self.bytes_written.saturating_add(bytes.len() as u64) > MAX_LOG_FILE_BYTES {
            self.rotate();
        }
        if self.file.write_all(bytes).is_ok() {
            self.bytes_written = self.bytes_written.saturating_add(bytes.len() as u64);
        }
    }

    fn rotate(&mut self) {
        let _ = self.file.flush();
        for idx in (1..MAX_LOG_BACKUPS).rev() {
            let from = PathBuf::from(format!("{}.{idx}", self.path.display()));
            let to = PathBuf::from(format!("{}.{}", self.path.display(), idx + 1));
            if from.exists() {
                let _ = fs::rename(&from, &to);
            }
        }
        let first_backup = PathBuf::from(format!("{}.1", self.path.display()));
        let _ = fs::rename(&self.path, &first_backup);
        if let Ok(new_file) = OpenOptions::new().create(true).truncate(true).write(true).open(&self.path) {
            self.file = new_file;
            self.bytes_written = 0;
        }
    }
}

struct GlanceLogger {
    level: LevelFilter,
    sink: Mutex<Option<FileLogSink>>,
}

impl Log for GlanceLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        if metadata.level() > self.level {
            return false;
        }
        let target = metadata.target();
        if target.starts_with("glance_ide") {
            true
        } else {
            metadata.level() <= log::Level::Warn
        }
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let ts = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let line = format!(
            "[{ts}] [{:<5}] [{}] {}\n",
            record.level(),
            record.target(),
            record.args()
        );
        if cfg!(debug_assertions) {
            eprint!("{line}");
        }
        if let Ok(mut guard) = self.sink.lock() {
            if let Some(sink) = guard.as_mut() {
                sink.write_line(&line);
            }
        }
    }

    fn flush(&self) {
        if let Ok(mut guard) = self.sink.lock() {
            if let Some(sink) = guard.as_mut() {
                let _ = sink.file.flush();
            }
        }
    }
}

static LOGGER: OnceLock<GlanceLogger> = OnceLock::new();

fn resolve_log_level() -> LevelFilter {
    match std::env::var("GLANCE_LOG")
        .ok()
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("error") => LevelFilter::Error,
        Some("warn") => LevelFilter::Warn,
        Some("info") => LevelFilter::Info,
        Some("debug") => LevelFilter::Debug,
        Some("trace") => LevelFilter::Trace,
        _ => {
            if cfg!(debug_assertions) {
                LevelFilter::Debug
            } else {
                LevelFilter::Info
            }
        }
    }
}

/// 初始化全局滚动日志器；重复调用安全无副作用。
pub fn init(log_dir: &Path) {
    let _ = fs::create_dir_all(log_dir);
    let log_file = log_dir.join("glance.log");
    let sink = FileLogSink::open(log_file).ok();
    let level = resolve_log_level();

    let logger = LOGGER.get_or_init(|| GlanceLogger {
        level,
        sink: Mutex::new(sink),
    });
    if log::set_logger(logger).is_ok() {
        log::set_max_level(level);
    }
}
