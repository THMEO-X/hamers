const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PAGE = path.join(__dirname, 'public', 'index.html');

function getLanIps() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
    }
  }
  return ips;
}

module.exports = function keepAlive(client) {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }

    if (url === '/status') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      return res.end(
        JSON.stringify({
          online: client?.isReady?.() ?? false,
          uptime: Math.floor(process.uptime()),
          ping: client?.ws?.ping ?? null,
        })
      );
    }

    if (url === '/') {
      return fs.readFile(PAGE, (err, data) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          return res.end('Không đọc được index.html');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Web server đang chạy ở port ${PORT}`);
    console.log(`Local:   http://localhost:${PORT}`);
    for (const ip of getLanIps()) console.log(`Mạng LAN: http://${ip}:${PORT}`);
    if (process.env.RENDER_EXTERNAL_URL) {
      console.log(`Public:  ${process.env.RENDER_EXTERNAL_URL}`);
    }
  });

  const base = (process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || '').replace(/\/$/, '');
  if (base) {
    setInterval(() => {
      fetch(`${base}/health`).catch(() => {});
    }, 10 * 60 * 1000);
  }
};
