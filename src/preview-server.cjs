const { readFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { join } = require('node:path');

const host = '127.0.0.1';
const defaultPort = 8080;
const routes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/go-engine.js', ['go-engine.js', 'text/javascript; charset=utf-8']],
  ['/winrate-panel.js', ['winrate-panel.js', 'text/javascript; charset=utf-8']],
  ['/go-record.js', ['go-record.js', 'text/javascript; charset=utf-8']],
  ['/go-ending.js', ['go-ending.js', 'text/javascript; charset=utf-8']],
]);

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  const route = routes.get(request.url.split('?')[0]);
  if (!route) {
    response.writeHead(404).end();
    return;
  }

  const [filename, contentType] = route;
  try {
    const contents = await readFile(join(__dirname, filename));
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': contentType,
      'Content-Length': contents.length,
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : contents);
  } catch (error) {
    console.error(`读取 ${filename} 失败：${error.message}`);
    response.writeHead(500).end();
  }
});

let port = defaultPort;
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && port === defaultPort) {
    console.log(`${defaultPort} 端口已被占用，正在分配可用端口。`);
    port = 0;
    server.listen(port, host);
    return;
  }
  console.error(`预览启动失败：${error.message}`);
  process.exitCode = 1;
});

server.on('listening', () => {
  console.log(`围棋对战已启动，打开 http://${host}:${server.address().port}/`);
  console.log('按 Ctrl+C 停止预览。');
});

server.listen(port, host);
