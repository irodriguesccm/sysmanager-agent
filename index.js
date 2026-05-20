#!/usr/bin/env node
/**
 * SysManager Agent
 * Instale no servidor remoto e configure com o token gerado no console.
 *
 * Uso:
 *   node index.js --config /etc/sysmanager-agent/config.json
 *
 * Ou defina as variáveis de ambiente:
 *   AGENT_SERVER_URL=ws://console:7877/ws/agent
 *   AGENT_TOKEN=seu_token_aqui
 *   AGENT_NAME=Agent-001
 *   AGENT_INTERVAL=5000
 */

import WebSocket from 'ws';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLocalApiFallback } from './local-api-fallback.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execAsync = promisify(exec);
let localApiBaseUrl = process.env.LOCAL_API_BASE_URL || 'http://127.0.0.1:3001';
const defaultStateDir = process.env.AGENT_STATE_DIR || path.join(process.cwd(), '.sysmanager-agent');
let fallbackApi = createLocalApiFallback({ stateDir: defaultStateDir });

// ─── Config ──────────────────────────────────────────────────────────────────

async function loadConfig() {
  // 1. Try --config flag
  const configFlagIdx = process.argv.indexOf('--config');
  if (configFlagIdx !== -1 && process.argv[configFlagIdx + 1]) {
    try {
      const raw = await fs.readFile(process.argv[configFlagIdx + 1], 'utf-8');
      return JSON.parse(raw);
    } catch (e) {
      console.error('[Agent] Erro ao ler config:', e.message);
      process.exit(1);
    }
  }

  // 2. Try default config file locations
  const defaultPaths = [
    '/etc/sysmanager-agent/config.json',
    path.join(__dirname, 'config.json'),
  ];
  for (const p of defaultPaths) {
    try {
      const raw = await fs.readFile(p, 'utf-8');
      return JSON.parse(raw);
    } catch { /* try next */ }
  }

  // 3. Environment variables
  if (process.env.AGENT_TOKEN) {
    return {
      serverUrl: process.env.AGENT_SERVER_URL || 'ws://localhost:7877/ws/agent',
      token: process.env.AGENT_TOKEN,
      agentName: process.env.AGENT_NAME || 'Agent',
      reportInterval: parseInt(process.env.AGENT_INTERVAL || '5000'),
    };
  }

  console.error('[Agent] Nenhuma configuração encontrada.');
  console.error('Crie /etc/sysmanager-agent/config.json ou use --config <arquivo>');
  console.error('Exemplo de config.json:');
  console.error(JSON.stringify({
    serverUrl: 'ws://10.0.0.1:7877/ws/agent',
    token: 'SEU_TOKEN_AQUI',
    agentName: 'Agent-001',
    reportInterval: 5000,
  }, null, 2));
  process.exit(1);
}

// ─── System data collection ───────────────────────────────────────────────────

async function safeExec(cmd) {
  try {
    const { stdout } = await execAsync(cmd, { timeout: 5000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function collectSystemInfo() {
  const [hostname, osRelease, kernel, uptime, loadavg, meminfo, diskUsage, cpuInfo] = await Promise.all([
    safeExec('hostname'),
    safeExec('cat /etc/os-release | grep "PRETTY_NAME" | cut -d= -f2 | tr -d \'"\''),
    safeExec('uname -r'),
    safeExec('uptime -p'),
    safeExec('cat /proc/loadavg'),
    safeExec('free -b'),
    safeExec('df -h /'),
    safeExec('lscpu | grep -E "^CPU\\(s\\):|^Model name:"'),
  ]);

  const memLines = meminfo.split('\n');
  const memData = (memLines[1] || '').split(/\s+/);
  const bytesToGB = (b) => b ? `${(parseInt(b) / 1e9).toFixed(2)} GB` : 'N/A';

  const diskLines = diskUsage.split('\n');
  const diskData = (diskLines[1] || '').split(/\s+/);

  const loadData = loadavg.split(' ');

  const cpuLines = cpuInfo.split('\n');
  const cpuCount = (cpuLines[0] || '').split(':')[1]?.trim() || 'N/A';
  const cpuModel = (cpuLines[1] || '').split(':')[1]?.trim() || 'N/A';

  return {
    hostname: hostname || 'N/A',
    os: osRelease || 'N/A',
    kernel: kernel || 'N/A',
    uptime: uptime.replace('up ', '') || 'N/A',
    loadAverage: { one: loadData[0] || '0', five: loadData[1] || '0', fifteen: loadData[2] || '0' },
    cpu: { count: cpuCount, model: cpuModel },
    memory: {
      total: bytesToGB(memData[1]),
      used: bytesToGB(memData[2]),
      free: bytesToGB(memData[3]),
      available: bytesToGB(memData[6]),
      totalBytes: parseInt(memData[1]) || 0,
      usedBytes: parseInt(memData[2]) || 0,
    },
    disk: {
      filesystem: diskData[0] || 'N/A',
      size: diskData[1] || 'N/A',
      used: diskData[2] || 'N/A',
      available: diskData[3] || 'N/A',
      usePercent: diskData[4] || 'N/A',
    },
  };
}

async function collectCpuUsage() {
  // Read /proc/stat twice with 500ms gap for accurate CPU %
  const read = async () => {
    const raw = await safeExec('head -1 /proc/stat');
    const parts = raw.split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  };
  const s1 = await read();
  await new Promise(r => setTimeout(r, 500));
  const s2 = await read();
  const dTotal = s2.total - s1.total;
  const dIdle = s2.idle - s1.idle;
  return dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;
}

async function collectServices() {
  try {
    const result = await fallbackApi.handleRequest('GET', '/api/services', {});
    if (result.ok && Array.isArray(result.data)) {
      return result.data.map((svc) => {
        const normalizedStatus =
          svc.status === 'failed' ? 'failed' :
          svc.status === 'running' ? 'running' :
          'inactive';

        return {
          name: svc.name,
          active: normalizedStatus === 'running' ? 'active' : normalizedStatus,
          sub: normalizedStatus === 'running' ? 'running' : normalizedStatus,
          status: normalizedStatus,
          monitored: true,
        };
      });
    }
  } catch {
    // fallback to legacy snapshot below
  }

  const raw = await safeExec('systemctl list-units --type=service --all --no-pager --no-legend 2>/dev/null | head -100');
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => {
    const clean = line.replace(/^[●•\s]+/, '');
    const parts = clean.trim().split(/\s+/);
    const name = (parts[0] || '').replace('.service', '');
    if (!name || name.startsWith('UNIT')) return null;
    const active = parts[2] || 'unknown';
    const sub = parts[3] || 'unknown';
    return {
      name,
      active,
      sub,
      status: active === 'failed' ? 'failed' : (sub === 'running' || (active === 'active' && sub === 'exited')) ? 'running' : 'inactive',
      monitored: false,
    };
  }).filter(Boolean).filter(s => s.name && s.name.length > 0);
}

async function collectReport() {
  const [systemInfo, cpuUsage, services] = await Promise.all([
    collectSystemInfo(),
    collectCpuUsage(),
    collectServices(),
  ]);

  return {
    timestamp: new Date().toISOString(),
    systemInfo,
    cpuUsage,
    services,
  };
}

// ─── Command handler ──────────────────────────────────────────────────────────

async function localApiCall(method, apiPath, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const targetUrl = new URL(apiPath, localApiBaseUrl).toString();
    const response = await fetch(targetUrl, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = { error: 'Invalid JSON response' };
    }

    return {
      ok: response.ok,
      status: response.status,
      data: payload,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: {
        error: error instanceof Error ? error.message : 'Local API connection failed',
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleCommand(msg) {
  const { commandId, command, args } = msg;

  const respond = (payload) => ({ type: 'command_result', commandId, ...payload });

  try {
    // ── HTTP proxy: forward API calls to local sysmanager server ──────────────
    if (command === 'http.proxy') {
      const { method = 'GET', path: apiPath, body } = args;
      const result = await localApiCall(method, apiPath, body);

      if (result.ok) {
        return respond({ success: true, data: result.data });
      }

      const connectionFailure =
        result.status === 0 ||
        /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|aborted/i.test(result.data?.error || '');

      if (connectionFailure) {
        const fallback = await fallbackApi.handleRequest(method, apiPath, body);
        return respond({
          success: fallback.ok,
          data: fallback.data,
          fallback: true,
        });
      }

      return respond({ success: false, data: result.data });
    }

    if (command === 'service.start') {
      const r = await safeExec(`systemctl start ${args.name}.service`);
      return respond({ success: true, output: r });
    }
    if (command === 'service.stop') {
      const r = await safeExec(`systemctl stop ${args.name}.service`);
      return respond({ success: true, output: r });
    }
    if (command === 'service.restart') {
      const r = await safeExec(`systemctl restart ${args.name}.service`);
      return respond({ success: true, output: r });
    }
    if (command === 'service.enable') {
      const r = await safeExec(`systemctl enable ${args.name}.service`);
      return respond({ success: true, output: r });
    }
    if (command === 'service.disable') {
      const r = await safeExec(`systemctl disable ${args.name}.service`);
      return respond({ success: true, output: r });
    }
    if (command === 'terminal.execute') {
      const r = await safeExec(args.command);
      return respond({ success: true, output: r });
    }
    return respond({ success: false, error: `Comando desconhecido: ${command}` });
  } catch (e) {
    return respond({ success: false, error: e.message });
  }
}

// ─── WebSocket connection ─────────────────────────────────────────────────────

async function start() {
  const config = await loadConfig();
  const { serverUrl, token, agentName, reportInterval = 5000 } = config;

  const localApiPort = Number(config.localApiPort || process.env.LOCAL_API_PORT || 3001);
  localApiBaseUrl = config.localApiBaseUrl || process.env.LOCAL_API_BASE_URL || `http://127.0.0.1:${localApiPort}`;

  const stateDir = config.stateDir || process.env.AGENT_STATE_DIR || path.join(process.cwd(), '.sysmanager-agent');
  fallbackApi = createLocalApiFallback({
    stateDir,
    servicesFile: config.servicesFile,
    maintenanceFlagFile: config.maintenanceFlagFile,
  });

  console.log(`[Agent] ${agentName} iniciando...`);
  console.log(`[Agent] Conectando em ${serverUrl}`);
  console.log(`[Agent] Local API alvo: ${localApiBaseUrl}`);
  console.log(`[Agent] Fallback API local habilitado (stateDir=${stateDir})`);

  let ws = null;
  let reportTimer = null;
  let reconnectTimer = null;
  let authenticated = false;

  function connect() {
    if (ws) { try { ws.terminate(); } catch {} }
    ws = new WebSocket(serverUrl);

    ws.on('open', () => {
      console.log('[Agent] Conectado ao console. Autenticando...');
      ws.send(JSON.stringify({ type: 'auth', token, agentName }));
    });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'auth_ok') {
        console.log(`[Agent] Autenticado como "${msg.agentName}"`);
        authenticated = true;

        // Start reporting
        const sendReport = async () => {
          if (!authenticated || ws.readyState !== WebSocket.OPEN) return;
          try {
            const payload = await collectReport();
            ws.send(JSON.stringify({ type: 'report', payload }));
          } catch (e) {
            console.error('[Agent] Erro ao coletar dados:', e.message);
          }
        };

        sendReport(); // immediate first report
        reportTimer = setInterval(sendReport, reportInterval);
      }

      if (msg.type === 'auth_error') {
        console.error('[Agent] Erro de autenticação:', msg.message);
        console.error('[Agent] Verifique o token no arquivo de configuração.');
        process.exit(1);
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }

      if (msg.type === 'command') {
        const result = await handleCommand(msg);
        ws.send(JSON.stringify(result));
      }
    });

    ws.on('close', (code, reason) => {
      authenticated = false;
      if (reportTimer) { clearInterval(reportTimer); reportTimer = null; }
      console.log(`[Agent] Desconectado (code=${code} reason=${reason?.toString() || 'none'}). Reconectando em 10s...`);
      reconnectTimer = setTimeout(connect, 10000);
    });

    ws.on('error', (err) => {
      console.error('[Agent] Erro WebSocket:', err.message);
    });
  }

  connect();

  process.on('SIGINT', () => {
    console.log('\n[Agent] Encerrando...');
    if (reportTimer) clearInterval(reportTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) ws.close();
    process.exit(0);
  });
}

start();
