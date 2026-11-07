// Glance IDE 互操作测试用 SSH 服务器（仅本机回环，测试完毕即关闭）
// 用法: node server.js <hostkey路径> <端口>
// - 认证：pi / raspberry（密码）
// - exec：回显命令；`stderr:...` 走 stderr；`exit N` 返回 N
// - pty+shell：简单回显 shell（提示符 glance-test$）
// - sftp：直通 macOS 自带 OpenSSH sftp-server（真实互操作）
const { spawn } = require("child_process");
const fs = require("fs");
const { Server } = require("ssh2");

const hostKeyPath = process.argv[2] || "/tmp/glance-e2e/keys/hostkey";
const port = Number(process.argv[3] || 2222);
// sftp-server 二进制指定（避免 Git Bash/MSYS 对路径形环境变量做转换，用显式前缀协议）：
//   linux:/usr/lib/openssh/sftp-server  → 经 wsl.exe 直通（Windows 无原生 sftp-server）
//   win:C:\path\to\sftp-server.exe      → Windows 直接 spawn
//   /usr/libexec/sftp-server（默认）     → 直接 spawn（macOS/Linux）
const SFTP_SERVER_RAW = process.env.GLANCE_E2E_SFTP_SERVER || "/usr/libexec/sftp-server";

function spawnSftpServer() {
  if (SFTP_SERVER_RAW.startsWith("linux:")) {
    return spawn("wsl.exe", [SFTP_SERVER_RAW.slice(6)], { stdio: ["pipe", "pipe", "pipe"] });
  }
  if (SFTP_SERVER_RAW.startsWith("win:")) {
    return spawn(SFTP_SERVER_RAW.slice(4), [], { stdio: ["pipe", "pipe", "pipe"] });
  }
  return spawn(SFTP_SERVER_RAW, [], { stdio: ["pipe", "pipe", "pipe"] });
}

const hostKey = fs.readFileSync(hostKeyPath);

const EXPECTED_USER = "pi";
const EXPECTED_PASS = "raspberry";

new Server({ hostKeys: [hostKey], ident: "glance-e2e-sshd" }, (client) => {
  client.on("authentication", (ctx) => {
    if (ctx.method === "password" && ctx.username === EXPECTED_USER && ctx.password === EXPECTED_PASS) {
      ctx.accept();
    } else {
      ctx.reject(["password"]);
    }
  });
  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (accept, reject, info) => {
        const stream = accept();
        const cmd = info.command || "";
        const exitMatch = /(?:^|\s)exit (\d+)\s*$/.exec(cmd);
        if (cmd.startsWith("stderr:")) {
          stream.stderr.write(cmd.slice(7));
          stream.exit(3);
        } else {
          stream.write(`exec:${cmd}\n`);
          stream.exit(exitMatch ? Number(exitMatch[1]) : 0);
        }
        stream.end();
      });
      session.on("pty", (accept) => {
        accept();
      });
      session.on("shell", (accept) => {
        const stream = accept();
        stream.write("glance-test$ ");
        let line = "";
        stream.on("data", (d) => {
          const s = d.toString();
          if (s.includes("\u0003")) {
            stream.write("^C");
            line = "";
            return;
          }
          line += s;
          if (line.includes("\r") || line.includes("\n")) {
            stream.write(`\r\necho:${line.trim()}\r\nglance-test$ `);
            line = "";
          }
        });
      });
      // 不注册 'sftp' 监听器，让 ssh2 走原始 'subsystem' 通道 → 与 sftp-server 二进制字节透传
      session.on("subsystem", (accept, reject, info) => {
        if (info.name !== "sftp") return reject();
        const channel = accept();
        const proc = spawnSftpServer();
        proc.stderr.on("data", (d) => console.log("[sftp-server stderr]", d.toString()));
        channel.pipe(proc.stdin);
        proc.stdout.pipe(channel);
        proc.on("error", (e) => { console.log("[sftp-server spawn error]", e.message); channel.end(); });
        proc.on("exit", () => channel.end());
        channel.on("end", () => proc.kill());
      });
    });
  });
  client.on("error", () => {});
}).listen(port, "127.0.0.1", () => {
  console.log(`READY 127.0.0.1:${port}`);
});
