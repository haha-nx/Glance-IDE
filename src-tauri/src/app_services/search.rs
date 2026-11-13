//! 全局文本搜索。
//! 大小写不敏感的流式子串匹配；遍历跳过常见构建目录、超限文件与二进制文件，限制结果数。

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// 单文件读取上限：超过视为大文件跳过（阈值策略）
const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;
/// 二进制嗅探字节数：前 4KB 出现 NUL 字节则视为二进制文件直接跳过
const BINARY_SNIFF_LEN: usize = 4096;
/// 单行最大字节数：跳过超长压缩行，避免无效 CPU 消耗
const MAX_LINE_BYTES: usize = 64 * 1024;
/// 结果总数上限
const MAX_HITS: usize = 200;
/// 每文件命中上限（避免单文件刷屏）
const MAX_HITS_PER_FILE: usize = 20;

const SKIP_DIRS: &[&str] = &[
    ".git", ".svn", ".hg", "node_modules", "target", "dist", "build",
    "__pycache__", ".venv", "venv", ".idea", ".vscode", "vendor",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub line_number: usize,
    pub line_text: String,
    /// 匹配起始列（0-based，供前端高亮）
    pub match_start: usize,
    pub match_len: usize,
}

fn is_skipped_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name)
}

/// ASCII 大小写不敏感子串查找，避免为未命中行分配 String。
fn find_ascii_ci(haystack: &[u8], lower_needle: &[u8]) -> Option<usize> {
    if lower_needle.is_empty() {
        return Some(0);
    }
    if haystack.len() < lower_needle.len() {
        return None;
    }
    haystack.windows(lower_needle.len()).position(|window| {
        window
            .iter()
            .zip(lower_needle)
            .all(|(h, n)| h.to_ascii_lowercase() == *n)
    })
}

/// 将源字符串转小写写入复用缓冲，消除逐行堆分配。
fn fill_lowercase_scratch(line: &str, scratch: &mut String) {
    scratch.clear();
    for ch in line.chars() {
        for lower in ch.to_lowercase() {
            scratch.push(lower);
        }
    }
}

/// 在目录内递归搜索（阻塞实现，调用方需放到 spawn_blocking）。
fn search_sync(root: &Path, needle: &str) -> Vec<SearchHit> {
    let query = needle.trim();
    if query.is_empty() {
        return Vec::new();
    }
    let needle_lower = query.to_lowercase();
    let needle_is_ascii = query.is_ascii();
    let needle_lower_chars = needle_lower.chars().count();
    let needle_lower_bytes = needle_lower.as_bytes();

    let mut hits = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut visited = 0usize;
    let mut raw_line = Vec::with_capacity(512);
    let mut line_lower_scratch = String::with_capacity(512);

    while let Some(dir) = stack.pop() {
        if hits.len() >= MAX_HITS || visited > 50_000 {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut children: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        children.sort();
        for path in children {
            visited += 1;
            let Ok(meta) = std::fs::metadata(&path) else { continue };
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if meta.is_dir() {
                if !is_skipped_dir(&name) {
                    stack.push(path);
                }
                continue;
            }
            if !meta.is_file() || meta.len() > MAX_FILE_SIZE {
                continue;
            }
            if hits.len() >= MAX_HITS {
                break;
            }
            let Ok(file) = File::open(&path) else { continue };
            let mut reader = BufReader::new(file);

            // 先检查前 4KB 是否包含 NUL 字节，快速跳过二进制文件避免整文件读取
            let Ok(sniff) = reader.fill_buf() else { continue };
            let sniff_len = sniff.len().min(BINARY_SNIFF_LEN);
            if sniff[..sniff_len].contains(&0) {
                continue;
            }

            let mut file_hits = 0usize;
            let mut line_number = 0usize;
            let path_display = path.display().to_string();

            loop {
                if file_hits >= MAX_HITS_PER_FILE || hits.len() >= MAX_HITS {
                    break;
                }
                raw_line.clear();
                let Ok(read_bytes) = reader.read_until(b'\n', &mut raw_line) else {
                    break;
                };
                if read_bytes == 0 {
                    break;
                }
                line_number += 1;

                while matches!(raw_line.last(), Some(b'\n' | b'\r')) {
                    raw_line.pop();
                }
                if raw_line.len() > MAX_LINE_BYTES {
                    continue;
                }
                let Ok(line) = std::str::from_utf8(&raw_line) else {
                    // 包含非法 UTF-8 字节序列则中止该文件（保持跳过非文本文件语义）
                    break;
                };

                let matched = if needle_is_ascii && line.is_ascii() {
                    find_ascii_ci(line.as_bytes(), needle_lower_bytes)
                        .map(|pos| (pos, query.len()))
                } else {
                    fill_lowercase_scratch(line, &mut line_lower_scratch);
                    line_lower_scratch
                        .find(&needle_lower)
                        .map(|pos| (line_lower_scratch[..pos].chars().count(), needle_lower_chars))
                };

                if let Some((match_start, match_len)) = matched {
                    hits.push(SearchHit {
                        path: path_display.clone(),
                        line_number,
                        line_text: line.chars().take(400).collect(),
                        match_start,
                        match_len,
                    });
                    file_hits += 1;
                }
            }
        }
    }
    hits
}

pub async fn search(root: PathBuf, query: String) -> Vec<SearchHit> {
    tokio::task::spawn_blocking(move || search_sync(&root, &query))
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn searches_and_skips_vendor_dirs() {
        let root = std::env::temp_dir().join(format!("glance-search-{}", uuid::Uuid::new_v4().simple()));
        let src = root.join("src");
        let nm = root.join("node_modules").join("pkg");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&nm).unwrap();
        std::fs::write(src.join("a.rs"), "fn main() {\n    let ROS = 2;\n    println!(\"ros\");\n}").unwrap();
        std::fs::write(nm.join("dep.js"), "const ros = 1;").unwrap();

        let hits = search_sync(&root, "ros");
        let paths: Vec<String> = hits.iter().map(|h| h.path.replace('\\', "/")).collect();
        assert_eq!(hits.len(), 2, "{paths:?}");
        assert!(paths.iter().all(|p| p.contains("src/a.rs")), "node_modules 应被跳过: {paths:?}");
        assert_eq!(hits[0].line_number, 2);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_query_returns_empty() {
        let root = std::env::temp_dir();
        let hits = search_sync(&root, "  ");
        assert!(hits.is_empty());
    }

    #[test]
    fn skips_binary_files_and_matches_unicode_case_insensitively() {
        let root = std::env::temp_dir().join(format!("glance-search-bin-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("binary.dat"), b"prefix\0needle\0suffix").unwrap();
        std::fs::write(root.join("unicode.txt"), "第一行\nHELLO 世界 needle 测试\n").unwrap();

        let hits = search_sync(&root, "NEEDLE");
        assert_eq!(hits.len(), 1);
        assert!(hits[0].path.ends_with("unicode.txt"));
        assert_eq!(hits[0].line_number, 2);
        assert_eq!(hits[0].match_start, "HELLO 世界 ".chars().count());
        assert_eq!(hits[0].match_len, 6);

        let _ = std::fs::remove_dir_all(&root);
    }
}
