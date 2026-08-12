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
    // Residential Senate eFD relay (Imperva blocks datacenter IPs). Reached by
    // the server through the senate-tunnel entry below at the permanent
    // hostname https://scout.congress.trade (Coolify SENATE_RELAY_URL).
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
      // NAMED tunnel `ct-mac-scout` — permanent hostname
      // https://scout.congress.trade. Restarting this entry is safe and
      // changes nothing on the server: SENATE_RELAY_URL is set once and never
      // needs updating again. There is no manual step here anymore.
      //
      // It used to be a quick tunnel, which minted a new random hostname on
      // every start while the server kept dialling the static SENATE_RELAY_URL
      // — the silent 2026-08-11 outage. This comment used to tell you to go
      // update SENATE_RELAY_URL by hand; that instruction is dead, and so is
      // the failure mode behind it.
      script: './scout/run-senate-tunnel.sh',
      interpreter: 'bash',
      cwd: __dirname,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: './scout/senate-tunnel.log',
      error_file: './scout/senate-tunnel.err',
      merge_logs: true,
      autorestart: true,
      // The wrapper exits non-zero on purpose (unhealthy probe, missing
      // credentials, no connection) so pm2 restarts it. Without a delay, the
      // fail-fast paths return in under a second and pm2 would spin them in a
      // hot loop; 10s keeps recovery prompt without hammering.
      restart_delay: 10000,
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
