const path = require('path');
const fs = require('fs');

// Dynamically read ADMIN_TOKEN from app/.dev.vars so it isn't hardcoded in git
let adminToken = '';
try {
  const devVarsPath = path.join(__dirname, 'app', '.dev.vars');
  const devVars = fs.readFileSync(devVarsPath, 'utf8');
  const match = devVars.match(/^ADMIN_TOKEN="?([^"\n]+)"?/m);
  if (match) {
    adminToken = match[1];
  }
} catch (e) {
  console.warn('Could not read ADMIN_TOKEN from app/.dev.vars', e.message);
}

module.exports = {
  apps: [
    {
      name: 'scout',
      script: './scout/run-scout.sh',
      interpreter: 'bash',
      cwd: __dirname,
      log_date_format: 'YYYY-MM-DD HH:mm Z',
      out_file: './scout/scout.log',
      error_file: './scout/scout.err',
      merge_logs: true
    },
    // Residential Senate eFD relay (Imperva blocks datacenter IPs). Pair with
    // senate-tunnel (cloudflared quick tunnel) and Coolify SENATE_RELAY_URL.
    {
      name: 'senate-relay',
      script: './scout/run-senate-relay.sh',
      interpreter: 'bash',
      cwd: __dirname,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: './scout/senate-relay.log',
      error_file: './scout/senate-relay.err',
      merge_logs: true,
      autorestart: true,
    },
    {
      name: 'senate-tunnel',
      // Ephemeral quick tunnel — URL regenerates on restart; Coolify's
      // SENATE_RELAY_URL must be updated when it changes (see docs #1604).
      // That manual step is exactly what failed on 2026-08-11: the tunnel
      // restarted 3x, minted 3 new hostnames, and nothing announced it, so the
      // server dialled a dead host while this entry looked "online" in pm2.
      // run-senate-tunnel.sh keeps the same quick tunnel but records the
      // hostname, alerts the owner the moment it rotates, and exits when the
      // relay stops answering through it so pm2 restarts it.
      script: './scout/run-senate-tunnel.sh',
      interpreter: 'bash',
      cwd: __dirname,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: './scout/senate-tunnel.log',
      error_file: './scout/senate-tunnel.err',
      merge_logs: true,
      autorestart: true,
    },
    {
      name: 'vision-worker',
      script: 'worker.py',
      interpreter: '/usr/bin/python3',
      cwd: path.join(__dirname, 'services', 'vision-worker'),
      env: {
        CONGRESS_TRADE_API_URL: 'http://localhost:8787',
        WORKER_ID: 'local_mac_1',
        POLL_INTERVAL_SEC: '30',
        HEARTBEAT_INTERVAL_SEC: '60',
        ADMIN_TOKEN: adminToken
      },
      log_date_format: 'YYYY-MM-DD HH:mm Z',
      out_file: '/Users/jay/Library/Logs/com.congress.trade.vision-worker.log',
      error_file: '/Users/jay/Library/Logs/com.congress.trade.vision-worker.err.log',
      merge_logs: true
    }
  ]
};
