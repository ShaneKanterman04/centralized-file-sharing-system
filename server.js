const net = require("net");
const fs = require("fs");
const path = require("path");

const HOST = process.env.FILESHARE_HOST || "0.0.0.0";
const PORT = Number(process.env.FILESHARE_PORT || 9000);
const SHARED_DIR = process.env.FILESHARE_SHARED_DIR || "/shared/files";

fs.mkdirSync(SHARED_DIR, { recursive: true });

function safeName(name) {
  return path.basename(String(name || "")).replace(/[^\w.\-]/g, "_");
}

function sendLine(socket, line) {
  socket.write(line + "\n");
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const server = net.createServer((socket) => {
  log(`client connected ${socket.remoteAddress}:${socket.remotePort}`);

  let buffer = Buffer.alloc(0);
  let uploadState = null;

  function resetUploadState() {
    if (uploadState && uploadState.stream) {
      try {
        uploadState.stream.end();
      } catch {}
    }
    uploadState = null;
  }

  socket.on("data", (chunk) => {
    try {
      if (uploadState) {
        const remaining = uploadState.size - uploadState.received;
        const toWrite = chunk.slice(0, remaining);

        uploadState.stream.write(toWrite);
        uploadState.received += toWrite.length;

        if (uploadState.received === uploadState.size) {
          uploadState.stream.end();
          log(`upload complete ${uploadState.filename} (${uploadState.size} bytes)`);
          sendLine(socket, `OK upload ${uploadState.filename}`);

          const leftover = chunk.slice(toWrite.length);
          uploadState = null;

          if (leftover.length > 0) {
            buffer = Buffer.concat([buffer, leftover]);
          }
        }

        return;
      }

      buffer = Buffer.concat([buffer, chunk]);

      while (true) {
        const newlineIndex = buffer.indexOf(0x0a);
        if (newlineIndex === -1) break;

        const lineBuf = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        const line = lineBuf.toString().trim();
        if (!line) continue;

        log(`command from ${socket.remoteAddress}:${socket.remotePort} -> ${line}`);

        const parts = line.split(" ");
        const cmd = parts[0];

        if (cmd === "LIST") {
          try {
            const files = fs
              .readdirSync(SHARED_DIR, { withFileTypes: true })
              .filter((entry) => entry.isFile())
              .map((entry) => entry.name)
              .join("|");

            sendLine(socket, `OK ${files}`);
          } catch (err) {
            sendLine(socket, `ERR ${err.message}`);
          }
        } else if (cmd === "GET") {
          const requested = safeName(parts.slice(1).join(" "));
          const filePath = path.join(SHARED_DIR, requested);

          if (!requested) {
            sendLine(socket, "ERR invalid filename");
            continue;
          }

          if (!fs.existsSync(filePath)) {
            sendLine(socket, "ERR file not found");
            continue;
          }

          const stat = fs.statSync(filePath);
          if (!stat.isFile()) {
            sendLine(socket, "ERR not a file");
            continue;
          }

          sendLine(socket, `FILE ${requested} ${stat.size}`);

          const readStream = fs.createReadStream(filePath);
          readStream.on("error", (err) => {
            sendLine(socket, `ERR ${err.message}`);
          });
          readStream.pipe(socket, { end: false });
        } else if (cmd === "PUT") {
          const filename = safeName(parts[1]);
          const size = Number(parts[2]);

          if (!filename || !Number.isFinite(size) || size < 0) {
            sendLine(socket, "ERR invalid PUT");
            continue;
          }

          const filePath = path.join(SHARED_DIR, filename);

          uploadState = {
            filename,
            size,
            received: 0,
            stream: fs.createWriteStream(filePath),
          };

          uploadState.stream.on("error", (err) => {
            sendLine(socket, `ERR ${err.message}`);
            resetUploadState();
          });

          if (size === 0) {
            uploadState.stream.end();
            uploadState = null;
            sendLine(socket, `OK upload ${filename}`);
          }
        } else {
          sendLine(socket, "ERR unknown command");
        }
      }
    } catch (err) {
      sendLine(socket, `ERR ${err.message}`);
      resetUploadState();
    }
  });

  socket.on("end", () => {
    log(`client disconnected ${socket.remoteAddress}:${socket.remotePort}`);
  });

  socket.on("close", () => {
    resetUploadState();
  });

  socket.on("error", (err) => {
    log(`socket error ${socket.remoteAddress}:${socket.remotePort} -> ${err.message}`);
    resetUploadState();
  });
});

server.on("error", (err) => {
  console.error("server error:", err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`file server listening on ${HOST}:${PORT}`);
  log(`shared directory ${SHARED_DIR}`);
});
