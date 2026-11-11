//! 全局文本搜索。
//! 首版为大小写不敏感的子串匹配；遍历跳过常见构建目录与二进制文件，限制结果数。

use std::path::{Path, PathBuf};

use serde::Serialize;

/// 单文件读取上限：超过视为大文件跳过（阈值策略）
const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;
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

/// 在目录内递归搜索（阻塞实现，调用方需放到 spawn_blocking）。
fn search_sync(root: &Path, needle: &str) -> Vec<SearchHit> {
    let query = needle.trim();
    if query.is_empty() {
        return Vec::new();
    }
    let needle_lower = query.to_lowercase();
    let mut hits = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut visited = 0usize;

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
            let Ok(content) = std::fs::read(&path) else { continue };
            let Ok(text) = String::from_utf8(content) else { continue }; // 跳过非 UTF-8

            let mut file_hits = 0;
            for (idx, line) in text.lines().enumerate() {
                if file_hits >= MAX_HITS_PER_FILE || hits.len() >= MAX_HITS {
                    break;
                }
                let line_lower = line.to_lowercase();
                if let Some(pos) = line_lower.find(&needle_lower) {
                    hits.push(SearchHit {
                        path: path.display().to_string(),
                        line_number: idx + 1,
                        line_text: line.chars().take(400).collect(),
                        match_start: line_lower[..pos].chars().count(),
                        match_len: needle_lower.chars().count(),
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
}
