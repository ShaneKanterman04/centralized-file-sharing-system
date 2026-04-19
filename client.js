const net = require('net');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const HOST = '192.168.122.100';
const PORT = 9000;
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
const DOWNLOAD_DIR = path.join(process.cwd(), 'downloads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(q) {
  return new Promise((resolve) => rl.question(q, resolve));
}

function sendCommand(command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: HOST, port: PORT }, () => {
      socket.write(command + '\n');
    });

    let headerParsed = false;
    let fileStream = null;
    let expectedBytes = 0;
    let receivedBytes = 0;
    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      if (!headerParsed) {
        buffer = Buffer.concat([buffer, chunk]);
        const nl = buffer.indexOf(0x0a);
        if (nl === -1) return;

        const line = buffer.slice(0, nl).toString().trim();
        const rest = buffer.slice(nl + 1);
        headerParsed = true;

        if (line.startsWith('OK ') || line === 'OK') {
          console.log(line);
          socket.end();
          resolve();
          return;
        }

        if (line.startsWith('ERR ')) {
          console.log(line);
          socket.end();
          resolve();
          return;
        }

        if (line.startsWith('FILE ')) {
          const parts = line.split(' ');
          const filename = parts[1];
          expectedBytes = Number(parts[2]);
          const outPath = path.join(DOWNLOAD_DIR, filename);
          fileStream = fs.createWriteStream(outPath);

          if (rest.length > 0) {
            const toWrite = rest.slice(0, expectedBytes);
            fileStream.write(toWrite);
            receivedBytes += toWrite.length;
          }

          if (receivedBytes >= expectedBytes) {
            fileStream.end();
            console.log(`downloaded ${filename}`);
            socket.end();
            resolve();
          }
          return;
        }

        console.log('unexpected response:', line);
        socket.end();
        resolve();
        return;
      }

      if (fileStream) {
        const remaining = expectedBytes - receivedBytes;
        const toWrite = chunk.slice(0, remaining);
        fileStream.write(toWrite);
        receivedBytes += toWrite.length;

        if (receivedBytes >= expectedBytes) {
          fileStream.end();
          console.log('download complete');
          socket.end();
          resolve();
        }
      }
    });

    socket.on('error', reject);
  });
}

function uploadFile(filename) {
  return new Promise((resolve, reject) => {
    const localPath = path.join(UPLOAD_DIR, filename);
    if (!fs.existsSync(localPath)) {
      console.log('file not found in uploads/');
      resolve();
      return;
    }

    const stat = fs.statSync(localPath);
    const socket = net.createConnection({ host: HOST, port: PORT }, () => {
      socket.write(`PUT ${path.basename(filename)} ${stat.size}\n`);
      fs.createReadStream(localPath).pipe(socket, { end: false });
      fs.createReadStream(localPath).on('end', () => {});
    });

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes('\n')) {
        console.log(buffer.trim());
        socket.end();
        resolve();
      }
    });

    socket.on('error', reject);
  });
}

async function main() {
  while (true) {
    console.log('\n1) List files');
    console.log('2) Download file');
    console.log('3) Upload file');
    console.log('4) Quit');

    const choice = await ask('Choose: ');

    if (choice === '1') {
      await sendCommand('LIST');
    } else if (choice === '2') {
      const name = await ask('Filename to download: ');
      await sendCommand(`GET ${name}`);
    } else if (choice === '3') {
      const name = await ask('Filename from uploads/: ');
      await uploadFile(name);
    } else if (choice === '4') {
      break;
    } else {
      console.log('invalid choice');
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
});
