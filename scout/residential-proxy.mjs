#!/usr/bin/env node
/**
 * scout/residential-proxy.mjs
 *
 * Lightweight, zero-dependency residential HTTP/HTTPS proxy daemon for macOS.
 * Listens on the Mac's Tailscale interface (or 0.0.0.0:3128) and handles:
 *  1. HTTPS tunneling via HTTP CONNECT method (end-to-end TLS between server and gov sites).
 *  2. Plain HTTP request forwarding.
 *  3. Liveness / health probe via GET/HEAD /health.
 *
 * Run:
 *   node scout/residential-proxy.mjs [port] [host]
 */

import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';

const PORT = parseInt(process.env.PROXY_PORT || process.argv[2] || '3128', 10);
const HOST = process.env.PROXY_HOST || process.argv[3] || '0.0.0.0';
const IDLE_TIMEOUT_MS = 30_000;

const server = http.createServer((req, res) => {
  // Liveness probe
  const pathname = req.url?.startsWith('http') ? new URL(req.url).pathname : req.url;
  if (pathname === '/health' || pathname === '/') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'connection': 'close',
    });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'residential-proxy',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }

  // Plain HTTP proxying
  try {
    const targetUrl = new URL(req.url);
    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || 80,
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers: { ...req.headers },
    };

    delete options.headers['proxy-connection'];
    delete options.headers['proxy-authorization'];

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
      }
      res.end(`Proxy Error: ${err.message}`);
    });

    proxyReq.setTimeout(IDLE_TIMEOUT_MS, () => {
      proxyReq.destroy(new Error('Proxy upstream timeout'));
    });

    req.pipe(proxyReq);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'text/plain' });
    }
    res.end(`Bad Request: ${err.message}`);
  }
});

// HTTPS tunneling via CONNECT method
server.on('connect', (req, clientSocket, head) => {
  const [hostname, rawPort] = (req.url || '').split(':');
  const port = parseInt(rawPort || '443', 10);

  if (!hostname || isNaN(port)) {
    clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    clientSocket.end();
    return;
  }

  const serverSocket = net.connect(port, hostname, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length > 0) {
      serverSocket.write(head);
    }
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });

  serverSocket.setTimeout(IDLE_TIMEOUT_MS);
  clientSocket.setTimeout(IDLE_TIMEOUT_MS);

  serverSocket.on('timeout', () => {
    serverSocket.destroy();
    clientSocket.destroy();
  });

  clientSocket.on('timeout', () => {
    clientSocket.destroy();
    serverSocket.destroy();
  });

  serverSocket.on('error', (err) => {
    if (!clientSocket.destroyed) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.end();
    }
  });

  clientSocket.on('error', () => {
    serverSocket.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[residential-proxy] listening on ${HOST}:${PORT} (pid: ${process.pid})`);
});
