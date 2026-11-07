const { Client } = require("ssh2");
const fs = require("fs");
const conn = new Client();
conn.on("ready", () => {
  conn.sftp((err, sftp) => {
    if (err) { console.log("SFTP ERR", err.message); process.exit(1); }
    sftp.readdir("/tmp/glance-e2e", (err2, list) => {
      if (err2) { console.log("READDIR ERR", err2.message); process.exit(1); }
      console.log("READDIR OK:", list.map(e => e.filename).join(", "));
      sftp.writeFile("/tmp/glance-e2e/node-sftp-test.txt", "hello-from-node", (err3) => {
        if (err3) { console.log("WRITE ERR", err3.message); process.exit(1); }
        sftp.readFile("/tmp/glance-e2e/node-sftp-test.txt", (err4, buf) => {
          console.log("READBACK:", buf.toString());
          conn.end();
          process.exit(0);
        });
      });
    });
  });
}).connect({ host: "127.0.0.1", port: 2222, username: "pi", password: "raspberry", hostVerifier: (key) => {
  // 打印服务器指纹供比对
  console.log("server key fp:", require("crypto").createHash("sha256").update(key).digest("base64").replace(/=+$/,""));
  return true;
} });
