#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [, , rawTag, outFile] = process.argv;
if (!rawTag) {
  console.error("用法: node scripts/release-notes.mjs <tag> [output-file]");
  process.exit(1);
}

const tag = rawTag.trim();
const version = tag.replace(/^v/i, "");
const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapedVer = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function extractFromChangelog() {
  const changelogPath = path.resolve(process.cwd(), "CHANGELOG.md");
  if (!fs.existsSync(changelogPath)) return "";

  const content = fs.readFileSync(changelogPath, "utf8").replace(/\r\n/g, "\n");
  const lines = content.split("\n");
  const headingRe = new RegExp(
    `^##\\s+\\[?(?:${escapedTag}|v?${escapedVer})\\]?(?:\\s|\\(|$)`,
    "i",
  );

  let collecting = false;
  const collected = [];
  for (const line of lines) {
    if (!collecting) {
      if (headingRe.test(line)) {
        collecting = true;
      }
      continue;
    }
    if (/^##\s+/.test(line)) {
      break;
    }
    collected.push(line);
  }

  return collected.join("\n").trim();
}

function extractFromGitTag() {
  try {
    const msg = execFileSync("git", ["tag", "-l", "--format=%(contents)", tag], {
      encoding: "utf8",
    }).trim();
    return msg;
  } catch {
    return "";
  }
}

let notes = extractFromChangelog();
if (!notes) {
  notes = extractFromGitTag();
}
if (!notes) {
  notes = `Glance IDE ${tag} 发布版本`;
}

if (outFile) {
  fs.writeFileSync(path.resolve(process.cwd(), outFile), `${notes}\n`, "utf8");
} else {
  process.stdout.write(`${notes}\n`);
}
