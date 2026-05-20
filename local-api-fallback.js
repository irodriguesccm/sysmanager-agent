import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

function toBool(value) {
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true';
}

function parsePath(apiPath) {
  const url = new URL(apiPath, 'http://agent.local');
  return { pathname: url.pathname, searchParams: url.searchParams };
}

function notFound(pathname) {
  return { ok: false, status: 404, data: { error: `Endpoint not found: ${pathname}` } };
}

function sanitize(value) {
  return String(value || '').replace(/"/g, '').replace(/`/g, '').trim();
}

export function createLocalApiFallback(options = {}) {
  const requestedStateDir = options.stateDir || path.join(process.cwd(), '.sysmanager-agent');
  let resolvedStateDir = requestedStateDir;
  let servicesFile = options.servicesFile || path.join(resolvedStateDir, 'services.json');
  let maintenanceFlagFile = options.maintenanceFlagFile || path.join(resolvedStateDir, 'maintenance.flag');
  const keepServices = new Set(['ssh', 'dhcpv6-client']);
  let stateDirChecked = false;

  const resolveWritableStateDir = async () => {
    if (stateDirChecked) return;

    const candidates = [
      requestedStateDir,
      path.join(process.cwd(), '.sysmanager-agent'),
      '/tmp/sysmanager-agent',
    ];

    for (const candidate of candidates) {
      try {
        await fs.mkdir(candidate, { recursive: true });
        resolvedStateDir = candidate;
        if (!options.servicesFile) {
          servicesFile = path.join(candidate, 'services.json');
        }
        if (!options.maintenanceFlagFile) {
          maintenanceFlagFile = path.join(candidate, 'maintenance.flag');
        }
        stateDirChecked = true;
        return;
      } catch {
        // try next candidate
      }
    }

    stateDirChecked = true;
  };

  const executeCommand = async (command, timeout = 15000, privileged = false) => {
    const run = async (cmd) => {
      try {
        const { stdout, stderr } = await execAsync(cmd, { timeout, maxBuffer: 2 * 1024 * 1024 });
        return { success: true, stdout, stderr };
      } catch (error) {
        return {
          success: false,
          stdout: error.stdout || '',
          stderr: error.stderr || '',
          error: error.message,
        };
      }
    };

    if (!privileged) {
      return run(command);
    }

    const sudoResult = await run(`sudo -n ${command}`);
    if (sudoResult.success) return sudoResult;

    const reason = `${sudoResult.stderr || ''} ${sudoResult.error || ''}`.toLowerCase();
    const sudoDenied =
      reason.includes('a password is required') ||
      reason.includes('password is required') ||
      reason.includes('not in the sudoers') ||
      reason.includes('permission denied');

    if (sudoDenied) {
      return run(command);
    }

    return sudoResult;
  };

  const executePrivileged = async (command, timeout = 15000) => {
    return executeCommand(command, timeout, true);
  };

  const readConfiguredServices = async () => {
    try {
      await resolveWritableStateDir();
      const raw = (await fs.readFile(servicesFile, 'utf-8')).trim();
      if (!raw) return [];
      return JSON.parse(raw);
    } catch {
      return [];
    }
  };

  const writeConfiguredServices = async (services) => {
    await resolveWritableStateDir();
    await fs.mkdir(path.dirname(servicesFile), { recursive: true });
    await fs.writeFile(servicesFile, JSON.stringify(services, null, 2), 'utf-8');
  };

  const readMaintenanceFlag = async () => {
    try {
      await resolveWritableStateDir();
      const raw = await fs.readFile(maintenanceFlagFile, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const writeMaintenanceFlag = async (value) => {
    await resolveWritableStateDir();
    await fs.mkdir(path.dirname(maintenanceFlagFile), { recursive: true });
    await fs.writeFile(maintenanceFlagFile, JSON.stringify(value, null, 2), 'utf-8');
  };

  const deleteMaintenanceFlag = async () => {
    await resolveWritableStateDir();
    await fs.unlink(maintenanceFlagFile).catch(() => {});
  };

  const handleSystemInfo = async () => {
    const [hostname, osRelease, kernel, uptime, loadavg, meminfo, diskUsage, cpuInfo] = await Promise.all([
      executeCommand('hostname'),
      executeCommand('cat /etc/os-release | grep "PRETTY_NAME" | cut -d= -f2 | tr -d \'"\''),
      executeCommand('uname -r'),
      executeCommand('uptime -p'),
      executeCommand('cat /proc/loadavg'),
      executeCommand('free -b'),
      executeCommand('df -h /'),
      executeCommand('lscpu | grep -E "^CPU\\(s\\):|^Model name:"'),
    ]);

    const memLines = (meminfo.stdout || '').trim().split('\n');
    const memData = (memLines[1] || '').split(/\s+/);
    const bytesToGB = (bytes) => {
      const n = parseInt(bytes || '0', 10);
      if (!n) return 'N/A';
      return `${(n / 1e9).toFixed(2)} GB`;
    };

    const diskLines = (diskUsage.stdout || '').trim().split('\n');
    const diskData = (diskLines[1] || '').split(/\s+/);

    const loadData = ((loadavg.stdout || '').trim() || '0 0 0').split(' ');

    const cpuLines = (cpuInfo.stdout || '').trim().split('\n');
    const cpuCount = (cpuLines[0] || '').split(':')[1]?.trim() || 'N/A';
    const cpuModel = (cpuLines[1] || '').split(':')[1]?.trim() || 'N/A';

    return {
      ok: true,
      status: 200,
      data: {
        hostname: (hostname.stdout || '').trim() || 'N/A',
        os: (osRelease.stdout || '').trim() || 'N/A',
        kernel: (kernel.stdout || '').trim() || 'N/A',
        uptime: ((uptime.stdout || '').trim() || 'N/A').replace('up ', ''),
        loadAverage: {
          one: loadData[0] || '0',
          five: loadData[1] || '0',
          fifteen: loadData[2] || '0',
        },
        cpu: {
          count: cpuCount,
          model: cpuModel,
        },
        memory: {
          total: bytesToGB(memData[1]),
          used: bytesToGB(memData[2]),
          free: bytesToGB(memData[3]),
          available: bytesToGB(memData[6]),
        },
        disk: {
          filesystem: diskData[0] || 'N/A',
          size: diskData[1] || 'N/A',
          used: diskData[2] || 'N/A',
          available: diskData[3] || 'N/A',
          usePercent: diskData[4] || 'N/A',
          mountpoint: diskData[5] || '/',
        },
      },
    };
  };

  const handleServicesList = async () => {
    const configuredServices = await readConfiguredServices();
    if (configuredServices.length === 0) {
      return { ok: true, status: 200, data: [] };
    }

    const services = await Promise.all(
      configuredServices.map(async (configuredService) => {
        const serviceName = configuredService.name;
        try {
          const statusCmd = `systemctl status ${sanitize(serviceName)}.service --no-pager -l`;
          const listCmd = `systemctl list-units --type=service --all --no-pager --no-legend ${sanitize(serviceName)}.service`;
          const [statusResult, listResult] = await Promise.all([
            executeCommand(statusCmd),
            executeCommand(listCmd),
          ]);

          const listOutput = (listResult.stdout || '').trim();
          const parts = listOutput.split(/\s+/);
          const activeState = parts[2] || 'unknown';
          const subState = parts[3] || 'unknown';
          const isRunning = subState === 'running' || (activeState === 'active' && subState === 'exited');

          let status = 'inactive';
          if (activeState === 'failed') status = 'failed';
          else if (isRunning) status = 'running';
          else if (activeState === 'active') status = 'stopped';

          const statusOutput = statusResult.stdout || '';
          const pidMatch = statusOutput.match(/Main PID: (\d+)/);
          const memoryMatch = statusOutput.match(/Memory: ([\d.]+[KMG])/);
          const taskMatch = statusOutput.match(/Tasks: (\d+)/);
          const uptimeMatch = statusOutput.match(/Active: active \([^)]+\) since ([^;]+);/);

          return {
            id: serviceName,
            name: serviceName,
            displayName:
              configuredService.displayName ||
              serviceName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            description: configuredService.description || 'No description',
            status,
            pid: pidMatch ? parseInt(pidMatch[1], 10) : null,
            memory: memoryMatch ? memoryMatch[1] : null,
            tasks: taskMatch ? taskMatch[1] : null,
            startedAt: uptimeMatch ? new Date(uptimeMatch[1]).toISOString() : null,
          };
        } catch {
          return {
            id: serviceName,
            name: serviceName,
            displayName: configuredService.displayName || serviceName,
            description: configuredService.description || 'Service not found or not available',
            status: 'inactive',
            pid: null,
            memory: null,
            tasks: null,
            startedAt: null,
          };
        }
      }),
    );

    return { ok: true, status: 200, data: services };
  };

  const handleServicesAdd = async (body) => {
    const name = sanitize(body?.name);
    const displayName = sanitize(body?.displayName) || name;
    const description = sanitize(body?.description);

    if (!name) {
      return { ok: false, status: 400, data: { error: 'Service name is required' } };
    }

    const configuredServices = await readConfiguredServices();
    if (configuredServices.find(s => s.name === name)) {
      return { ok: false, status: 400, data: { error: 'Servico ja esta sendo monitorado' } };
    }

    const verifyResult = await executeCommand(`timeout 3 systemctl cat ${name}.service`);
    if (!verifyResult.success) {
      return {
        ok: false,
        status: 404,
        data: {
          error: `Servico '${name}' nao encontrado no sistema`,
          details: 'Verifique se o nome esta correto e se o servico esta instalado',
        },
      };
    }

    const entry = {
      name,
      displayName,
      description,
      addedAt: new Date().toISOString(),
    };

    configuredServices.push(entry);
    try {
      await writeConfiguredServices(configuredServices);
    } catch (error) {
      return {
        ok: false,
        status: 500,
        data: {
          error: error instanceof Error ? error.message : 'Erro ao salvar configuracao de servicos',
        },
      };
    }

    return {
      ok: true,
      status: 200,
      data: {
        success: true,
        message: `Servico ${name} adicionado com sucesso`,
        service: entry,
      },
    };
  };

  const handleServicesUpdate = async (serviceName, body) => {
    const configuredServices = await readConfiguredServices();
    const index = configuredServices.findIndex(s => s.name === serviceName);
    if (index === -1) {
      return { ok: false, status: 404, data: { error: 'Service not found in configuration' } };
    }

    configuredServices[index] = {
      ...configuredServices[index],
      displayName: sanitize(body?.displayName) || configuredServices[index].displayName,
      description: sanitize(body?.description) || configuredServices[index].description,
      updatedAt: new Date().toISOString(),
    };

    await writeConfiguredServices(configuredServices);

    return {
      ok: true,
      status: 200,
      data: {
        success: true,
        message: `Service ${serviceName} updated`,
        service: configuredServices[index],
      },
    };
  };

  const handleServicesRemove = async (serviceName) => {
    const configuredServices = await readConfiguredServices();
    const filtered = configuredServices.filter(s => s.name !== serviceName);
    if (filtered.length === configuredServices.length) {
      return { ok: false, status: 404, data: { error: 'Service not found in configuration' } };
    }

    await writeConfiguredServices(filtered);
    return {
      ok: true,
      status: 200,
      data: {
        success: true,
        message: `Service ${serviceName} removed from monitoring`,
      },
    };
  };

  const handleServiceAction = async (serviceName, action) => {
    const allowed = new Set(['start', 'stop', 'restart', 'enable', 'disable']);
    if (!allowed.has(action)) {
      return { ok: false, status: 400, data: { error: 'Invalid action' } };
    }

    const result = await executePrivileged(`systemctl ${action} ${sanitize(serviceName)}.service`);
    if (!result.success) {
      return { ok: false, status: 500, data: { error: result.error || result.stderr || 'Action failed' } };
    }

    return {
      ok: true,
      status: 200,
      data: {
        success: true,
        message: `Service ${serviceName} ${action}ed`,
      },
    };
  };

  const handleServiceUnitFile = async (serviceName) => {
    const possiblePaths = [
      `/etc/systemd/system/${serviceName}.service`,
      `/usr/lib/systemd/system/${serviceName}.service`,
      `/lib/systemd/system/${serviceName}.service`,
    ];

    for (const p of possiblePaths) {
      const result = await executePrivileged(`cat ${p}`);
      if (result.success && (result.stdout || '').trim()) {
        return {
          ok: true,
          status: 200,
          data: {
            success: true,
            path: p,
            content: result.stdout,
          },
        };
      }
    }

    return { ok: false, status: 404, data: { error: 'Service unit file not found' } };
  };

  const handleTerminalExecute = async (body) => {
    const command = String(body?.command || '').trim();
    if (!command) {
      return { ok: false, status: 400, data: { error: 'Command is required' } };
    }

    const result = await executeCommand(command);
    return {
      ok: true,
      status: 200,
      data: {
        success: result.success,
        output: result.stdout || result.stderr || result.error,
        error: result.success ? null : result.error,
      },
    };
  };

  const handleFirewallStatus = async () => {
    const result = await executePrivileged('firewall-cmd --state');
    return {
      ok: true,
      status: 200,
      data: {
        status: (result.stdout || '').trim() === 'running' ? 'active' : 'inactive',
        output: result.stdout || '',
      },
    };
  };

  const handleFirewallRules = async (zone) => {
    const result = await executePrivileged(`firewall-cmd --zone=${sanitize(zone)} --list-all`);
    if (!result.success) {
      return { ok: false, status: 500, data: { error: result.error || 'Failed to read rules' } };
    }
    return { ok: true, status: 200, data: { zone, rules: result.stdout || '', success: true } };
  };

  const handleFirewallAddRemovePort = async (body, add) => {
    const port = sanitize(body?.port);
    const protocol = sanitize(body?.protocol || 'tcp');
    const zone = sanitize(body?.zone || 'public');
    const permanent = toBool(body?.permanent ?? true);

    if (!port) {
      return { ok: false, status: 400, data: { error: 'Port is required' } };
    }

    const permanentFlag = permanent ? '--permanent' : '';
    const op = add ? '--add-port' : '--remove-port';
    const result = await executePrivileged(`firewall-cmd --zone=${zone} ${permanentFlag} ${op}=${port}/${protocol}`);

    if (permanent) {
      await executePrivileged('firewall-cmd --reload');
    }

    return {
      ok: result.success,
      status: result.success ? 200 : 500,
      data: result.success
        ? { success: true, message: `Port ${port}/${protocol} ${add ? 'added to' : 'removed from'} zone ${zone}` }
        : { error: result.error || result.stderr || 'Firewall operation failed' },
    };
  };

  const handleFirewallAddRemoveService = async (body, add) => {
    const service = sanitize(body?.service);
    const zone = sanitize(body?.zone || 'public');
    const permanent = toBool(body?.permanent ?? true);

    if (!service) {
      return { ok: false, status: 400, data: { error: 'Service is required' } };
    }

    const permanentFlag = permanent ? '--permanent' : '';
    const op = add ? '--add-service' : '--remove-service';
    const result = await executePrivileged(`firewall-cmd --zone=${zone} ${permanentFlag} ${op}=${service}`);

    if (permanent) {
      await executePrivileged('firewall-cmd --reload');
    }

    return {
      ok: result.success,
      status: result.success ? 200 : 500,
      data: result.success
        ? { success: true, message: `Service ${service} ${add ? 'added to' : 'removed from'} zone ${zone}` }
        : { error: result.error || result.stderr || 'Firewall service operation failed' },
    };
  };

  const handleFirewallPorts = async (zone) => {
    const [portsResult, servicesResult] = await Promise.all([
      executePrivileged(`firewall-cmd --zone=${zone} --list-ports`),
      executePrivileged(`firewall-cmd --zone=${zone} --list-services`),
    ]);

    const SERVICE_META = {
      http: { port: '80', protocol: 'tcp', label: 'HTTP', risk: 'public', icon: 'globe' },
      https: { port: '443', protocol: 'tcp', label: 'HTTPS', risk: 'public', icon: 'lock' },
      ssh: { port: '22', protocol: 'tcp', label: 'SSH', risk: 'caution', icon: 'terminal' },
      ftp: { port: '21', protocol: 'tcp', label: 'FTP', risk: 'danger', icon: 'file' },
      dns: { port: '53', protocol: 'udp', label: 'DNS', risk: 'caution', icon: 'globe' },
      smtp: { port: '25', protocol: 'tcp', label: 'SMTP', risk: 'caution', icon: 'mail' },
      mysql: { port: '3306', protocol: 'tcp', label: 'MySQL', risk: 'danger', icon: 'database' },
      postgresql: { port: '5432', protocol: 'tcp', label: 'PostgreSQL', risk: 'danger', icon: 'database' },
      redis: { port: '6379', protocol: 'tcp', label: 'Redis', risk: 'danger', icon: 'database' },
      mongodb: { port: '27017', protocol: 'tcp', label: 'MongoDB', risk: 'danger', icon: 'database' },
    };

    const riskLabels = { public: 'Publico', caution: 'Atencao', danger: 'Risco', unknown: 'Desconhecido' };
    const entries = [];

    (servicesResult.stdout || '').trim().split(/\s+/).filter(Boolean).forEach((svc) => {
      const meta = SERVICE_META[svc] || { port: '?', protocol: 'tcp', label: svc, risk: 'unknown', icon: 'shield' };
      entries.push({ ...meta, source: 'service', service: svc, riskLabel: riskLabels[meta.risk] || 'Desconhecido' });
    });

    (portsResult.stdout || '').trim().split(/\s+/).filter(Boolean).forEach((portValue) => {
      const [port, protocol] = portValue.split('/');
      const knownService = Object.entries(SERVICE_META).find(([, m]) => m.port === port);
      if (knownService) {
        if (!entries.find(e => e.port === port)) {
          entries.push({
            ...knownService[1],
            source: 'port',
            service: null,
            riskLabel: riskLabels[knownService[1].risk],
          });
        }
      } else {
        entries.push({
          port,
          protocol: protocol || 'tcp',
          label: 'Personalizado',
          risk: 'unknown',
          icon: 'shield',
          source: 'port',
          service: null,
          riskLabel: 'Desconhecido',
        });
      }
    });

    return { ok: true, status: 200, data: { success: true, ports: entries, zone } };
  };

  const handleFirewallAnalysis = async () => {
    const [tcpResult, fwPortsResult, fwSvcResult] = await Promise.all([
      executePrivileged('ss -tlnp 2>/dev/null'),
      executePrivileged('firewall-cmd --zone=public --list-ports 2>/dev/null'),
      executePrivileged('firewall-cmd --zone=public --list-services 2>/dev/null'),
    ]);

    const servicePorts = {
      http: '80', https: '443', ssh: '22', ftp: '21', dns: '53',
      smtp: '25', mysql: '3306', postgresql: '5432', redis: '6379', mongodb: '27017',
    };

    const portToRule = {};
    (fwSvcResult.stdout || '').trim().split(/\s+/).filter(Boolean).forEach((svc) => {
      const port = servicePorts[svc];
      if (port) portToRule[port] = svc;
    });

    (fwPortsResult.stdout || '').trim().split(/\s+/).filter(Boolean).forEach((p) => {
      const [port] = p.split('/');
      if (port && !portToRule[port]) portToRule[port] = p;
    });

    const fwPorts = new Set(Object.keys(portToRule));
    const rawEntries = [];
    const seen = new Set();

    (tcpResult.stdout || '').trim().split('\n').slice(1).filter(Boolean).forEach((line) => {
      const portMatch = line.match(/[^\s]+:(\d+)\s+[^\s]+\s*(.*)/);
      if (!portMatch) return;

      const port = portMatch[1];
      if (seen.has(port)) return;
      seen.add(port);

      const rest = portMatch[2] || '';
      const procMatch = rest.match(/\("([^"]+)"/);
      const pidMatch = rest.match(/pid=(\d+)/);

      rawEntries.push({
        port,
        process: procMatch ? procMatch[1] : null,
        pid: pidMatch ? pidMatch[1] : null,
        inFirewall: fwPorts.has(port),
        rule: portToRule[port] || null,
      });
    });

    for (const entry of rawEntries) {
      if (!entry.pid) {
        const r = await executePrivileged(`fuser ${entry.port}/tcp 2>/dev/null`);
        const pids = (r.stdout || '').trim().split(/\s+/).filter(Boolean);
        if (pids.length > 0) {
          entry.pid = pids[0];
        }
      }
    }

    const listening = await Promise.all(rawEntries.map(async (entry) => {
      let processName = entry.process;
      let exe = null;

      if (entry.pid) {
        if (!processName) {
          const comm = await executePrivileged(`cat /proc/${entry.pid}/comm 2>/dev/null`);
          processName = (comm.stdout || '').trim() || null;
        }

        if (!entry.inFirewall) {
          const exeResult = await executePrivileged(`readlink -f /proc/${entry.pid}/exe 2>/dev/null`);
          exe = (exeResult.stdout || '').trim() || null;
        }
      }

      return {
        port: entry.port,
        process: processName || 'desconhecido',
        inFirewall: entry.inFirewall,
        rule: entry.rule,
        exe,
      };
    }));

    return { ok: true, status: 200, data: { success: true, listening } };
  };

  const handleFirewallTemplate = async (body) => {
    const template = sanitize(body?.template);

    const templates = {
      'web-server': ['http', 'https', 'ssh'],
      'database': ['ssh'],
      'ssh-restricted': ['ssh'],
      docker: ['http', 'https', 'ssh'],
      kubernetes: ['http', 'https', 'ssh'],
    };

    const templatePorts = {
      kubernetes: ['6443/tcp', '10250/tcp', '10251/tcp', '10252/tcp', '2379/tcp', '2380/tcp'],
    };

    const services = templates[template];
    if (!services) {
      return { ok: false, status: 400, data: { error: 'Template nao encontrado' } };
    }

    await executePrivileged('firewall-cmd --zone=public --permanent --remove-service=http 2>/dev/null; true');
    await executePrivileged('firewall-cmd --zone=public --permanent --remove-service=https 2>/dev/null; true');

    for (const svc of services) {
      await executePrivileged(`firewall-cmd --zone=public --permanent --add-service=${svc}`);
    }

    for (const p of templatePorts[template] || []) {
      await executePrivileged(`firewall-cmd --zone=public --permanent --add-port=${p}`);
    }

    await executePrivileged('firewall-cmd --reload');

    return {
      ok: true,
      status: 200,
      data: { success: true, message: `Template "${template}" aplicado com sucesso` },
    };
  };

  const handleSshUsers = async () => {
    const [passwdResult, sudoResult, lastResult, shadowResult] = await Promise.all([
      executeCommand('getent passwd | awk -F: \'($3 >= 1000 && $3 < 65534) || $1 == "root" {print}\''),
      executeCommand('getent group wheel sudo 2>/dev/null | cut -d: -f4 | tr "," "\\n" | sort -u'),
      executeCommand('last -n 100 -w 2>/dev/null'),
      executePrivileged('passwd -S -a 2>/dev/null | awk \'{print $1, $2}\''),
    ]);

    const sudoUsers = new Set((sudoResult.stdout || '').split('\n').map(u => u.trim()).filter(Boolean));

    const lastLogins = {};
    (lastResult.stdout || '').trim().split('\n').forEach((line) => {
      const parts = line.split(/\s+/);
      const user = parts[0];
      if (user && user !== 'wtmp' && user !== 'reboot' && user !== 'shutdown' && !lastLogins[user]) {
        lastLogins[user] = parts.slice(2, 8).join(' ').trim();
      }
    });

    const shadowStatus = {};
    (shadowResult.stdout || '').trim().split('\n').forEach((line) => {
      const [user, status] = line.split(/\s+/);
      if (user) shadowStatus[user] = status;
    });

    const users = (passwdResult.stdout || '').trim().split('\n').filter(Boolean).map((line) => {
      const [username, , uid, , comment, home, shell] = line.split(':');
      return {
        username,
        uid: parseInt(uid, 10),
        comment,
        home,
        shell,
        sudo: sudoUsers.has(username),
        lastLogin: lastLogins[username] || 'Nunca',
        locked: shadowStatus[username] === 'L',
        hasLoginShell: shell && !shell.includes('nologin') && !shell.includes('false'),
      };
    });

    return { ok: true, status: 200, data: { success: true, users } };
  };

  const handleSshUserKeys = async (username) => {
    const homeResult = await executeCommand(`getent passwd ${sanitize(username)} | cut -d: -f6`);
    const home = (homeResult.stdout || '').trim();
    if (!home) {
      return { ok: false, status: 404, data: { error: 'Usuario nao encontrado' } };
    }

    const keysResult = await executePrivileged(`cat ${home}/.ssh/authorized_keys 2>/dev/null || echo ""`);
    const keys = (keysResult.stdout || '').trim().split('\n').filter(k => k && !k.startsWith('#'));

    return { ok: true, status: 200, data: { success: true, keys, keyCount: keys.length } };
  };

  const handleSshLockUnlock = async (username, body) => {
    const action = sanitize(body?.action);
    if (username === 'root') {
      return { ok: false, status: 403, data: { error: 'Nao e possivel bloquear o root' } };
    }

    const cmd = action === 'lock' ? `usermod -L ${sanitize(username)}` : `usermod -U ${sanitize(username)}`;
    const result = await executePrivileged(cmd);

    return {
      ok: result.success,
      status: result.success ? 200 : 500,
      data: result.success
        ? { success: true, message: `Usuario ${username} ${action === 'lock' ? 'bloqueado' : 'desbloqueado'}` }
        : { error: result.error || result.stderr || 'Erro ao atualizar usuario' },
    };
  };

  const handleSshRevokeKey = async (username, body) => {
    const keyIndex = Number(body?.keyIndex);
    const homeResult = await executeCommand(`getent passwd ${sanitize(username)} | cut -d: -f6`);
    const home = (homeResult.stdout || '').trim();
    if (!home) {
      return { ok: false, status: 404, data: { error: 'Usuario nao encontrado' } };
    }

    const keysResult = await executePrivileged(`cat ${home}/.ssh/authorized_keys 2>/dev/null || echo ""`);
    const keys = (keysResult.stdout || '').trim().split('\n').filter(Boolean);

    if (Number.isNaN(keyIndex) || keyIndex < 0 || keyIndex >= keys.length) {
      return { ok: false, status: 400, data: { error: 'Indice de chave invalido' } };
    }

    keys.splice(keyIndex, 1);
    const tmpFile = `/tmp/keys_${Date.now()}`;
    await fs.writeFile(tmpFile, `${keys.join('\n')}\n`, 'utf-8');
    const result = await executePrivileged(`cp ${tmpFile} ${home}/.ssh/authorized_keys && rm -f ${tmpFile}`);

    return {
      ok: result.success,
      status: result.success ? 200 : 500,
      data: result.success ? { success: true, message: 'Chave SSH revogada' } : { error: result.error || result.stderr },
    };
  };

  const handleSshCreateUser = async (body) => {
    const username = sanitize(body?.username);
    const password = String(body?.password || '');
    const shell = sanitize(body?.shell || '/bin/bash');
    const addSudo = toBool(body?.addSudo);
    const comment = sanitize(body?.comment || '');

    if (!username || !/^[a-z_][a-z0-9_-]{0,31}$/.test(username)) {
      return {
        ok: false,
        status: 400,
        data: { error: 'Nome de usuario invalido. Use apenas letras minusculas, numeros, _ ou -' },
      };
    }

    const checkUser = await executeCommand(`id ${username} 2>/dev/null && echo "exists" || echo "not_found"`);
    if ((checkUser.stdout || '').includes('exists')) {
      return { ok: false, status: 409, data: { error: `Usuario "${username}" ja existe` } };
    }

    const commentFlag = comment ? `-c "${comment}"` : '';
    const createResult = await executePrivileged(`useradd -m -s ${shell} ${commentFlag} ${username}`);
    if (!createResult.success) {
      return { ok: false, status: 500, data: { error: createResult.error || createResult.stderr } };
    }

    if (password) {
      const passResult = await executePrivileged(`echo "${username}:${password}" | chpasswd`);
      if (!passResult.success) {
        return {
          ok: false,
          status: 500,
          data: { error: `Usuario criado, mas falha ao definir senha: ${passResult.stderr || passResult.error}` },
        };
      }
    }

    if (addSudo) {
      await executePrivileged(`usermod -aG wheel ${username}`);
    }

    return { ok: true, status: 200, data: { success: true, message: `Usuario "${username}" criado com sucesso` } };
  };

  const handleSshPermissions = async (username) => {
    const [groupsResult, idResult] = await Promise.all([
      executeCommand(`groups ${sanitize(username)} 2>/dev/null`),
      executeCommand(`id ${sanitize(username)} 2>/dev/null`),
    ]);

    const groupsRaw = (groupsResult.stdout || '').trim();
    const groupsPart = groupsRaw.includes(':') ? groupsRaw.split(':')[1] : groupsRaw;
    const groups = groupsPart.trim().split(/\s+/).filter(Boolean);
    const idLine = (idResult.stdout || '').trim();

    return { ok: true, status: 200, data: { success: true, groups, idLine } };
  };

  const handleUpdatesPending = async () => {
    const [checkResult, secResult] = await Promise.all([
      executeCommand('dnf check-update --quiet 2>/dev/null; true', 30000),
      executeCommand('dnf updateinfo list security --quiet 2>/dev/null || echo ""', 30000),
    ]);

    const secPackages = new Set(
      (secResult.stdout || '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(l => l.split(/\s+/)[2])
        .filter(Boolean),
    );

    const lines = (checkResult.stdout || '')
      .trim()
      .split('\n')
      .filter(line => line && !line.startsWith('Last metadata') && line.trim());

    const updates = lines
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) return null;

        const pkg = parts[0];
        const type = pkg.startsWith('kernel')
          ? 'kernel'
          : secPackages.has(pkg)
            ? 'security'
            : pkg.includes('lib')
              ? 'system'
              : 'application';

        return { package: pkg, version: parts[1], repo: parts[2], type };
      })
      .filter(Boolean);

    const summary = {
      total: updates.length,
      security: updates.filter(u => u.type === 'security').length,
      kernel: updates.filter(u => u.type === 'kernel').length,
      system: updates.filter(u => u.type === 'system').length,
      application: updates.filter(u => u.type === 'application').length,
    };

    return { ok: true, status: 200, data: { success: true, updates, summary } };
  };

  const handleUpdatesInstall = async (body) => {
    const type = sanitize(body?.type || 'all');
    const cmd = type === 'security' ? 'dnf update --security -y 2>&1' : 'dnf update -y 2>&1';
    executePrivileged(cmd, 1800000).then((r) => {
      // Keep logs visible in the agent journal without blocking responses.
      console.log('[Agent] Updates completed:', r.success);
    });

    return {
      ok: true,
      status: 200,
      data: {
        success: true,
        message: 'Atualizacao iniciada em segundo plano. Verifique o terminal para progresso.',
      },
    };
  };

  const handleCleanupInfo = async () => {
    const [logSize, dnfCache, kernelCount, orphanPkgs, dockerImages, dockerSize] = await Promise.all([
      executePrivileged('du -sh /var/log 2>/dev/null | cut -f1 || echo "N/A"'),
      executePrivileged('du -sh /var/cache/dnf 2>/dev/null | cut -f1 || echo "N/A"'),
      executeCommand('rpm -q kernel --queryformat "%{NAME}\\n" 2>/dev/null | wc -l || echo 0'),
      executeCommand('dnf list extras --quiet 2>/dev/null | tail -n +2 | wc -l || echo 0'),
      executeCommand('docker images -q 2>/dev/null | wc -l || echo 0'),
      executeCommand('docker system df --format "{{.Size}}" 2>/dev/null | head -1 || echo "N/A"'),
    ]);

    return {
      ok: true,
      status: 200,
      data: {
        success: true,
        logSize: (logSize.stdout || '').trim() || 'N/A',
        dnfCacheSize: (dnfCache.stdout || '').trim() || 'N/A',
        kernelCount: parseInt((kernelCount.stdout || '').trim(), 10) || 0,
        orphanPackages: parseInt((orphanPkgs.stdout || '').trim(), 10) || 0,
        unusedDockerImages: parseInt((dockerImages.stdout || '').trim(), 10) || 0,
        dockerTotalSize: (dockerSize.stdout || '').trim() || 'N/A',
      },
    };
  };

  const handleCleanupExecute = async (body) => {
    const action = sanitize(body?.action);
    const actions = {
      logs: 'journalctl --vacuum-time=30d 2>&1 && find /var/log -type f -name "*.log.*" -mtime +30 -delete 2>&1 | head -20',
      'dnf-cache': 'dnf clean all 2>&1',
      'orphan-packages': 'dnf autoremove -y 2>&1 | tail -10',
      'docker-images': 'docker image prune -a -f 2>&1',
      'docker-all': 'docker system prune -a -f 2>&1',
    };

    const cmd = actions[action];
    if (!cmd) {
      return { ok: false, status: 400, data: { error: 'Acao invalida' } };
    }

    const result = await executePrivileged(cmd, 120000);

    return {
      ok: result.success,
      status: result.success ? 200 : 500,
      data: {
        success: result.success,
        output: `${result.stdout || ''}${result.stderr || ''}`,
        message: result.success ? 'Limpeza concluida com sucesso' : 'Erro durante a limpeza',
      },
    };
  };

  const handleBootServices = async () => {
    const [blameResult, enabledResult, analyzeResult] = await Promise.all([
      executeCommand('systemd-analyze blame --no-pager 2>/dev/null | head -40'),
      executeCommand('systemctl list-unit-files --type=service --no-pager --no-legend 2>/dev/null | awk \'{print $1, $2}\''),
      executeCommand('systemd-analyze 2>/dev/null'),
    ]);

    const bootTimeMatch = (analyzeResult.stdout || '').match(/Finished in ([\d.]+\w+)/);
    const bootTime = bootTimeMatch ? bootTimeMatch[1] : null;

    const blameMap = {};
    (blameResult.stdout || '').trim().split('\n').filter(Boolean).forEach((line) => {
      const match = line.trim().match(/^([\d.]+\w+)\s+(.+\.service)$/);
      if (match) blameMap[match[2]] = match[1];
    });

    const services = (enabledResult.stdout || '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [fullName, state] = line.split(/\s+/);
        const name = fullName?.replace('.service', '') || '';
        return { name, fullName, enabled: state === 'enabled', state, bootTime: blameMap[fullName] || null };
      })
      .filter(s => s.name);

    return { ok: true, status: 200, data: { success: true, services, bootTime } };
  };

  const handleBootToggle = async (serviceName, body) => {
    const enable = toBool(body?.enable);
    const cmd = enable
      ? `systemctl enable ${sanitize(serviceName)}.service`
      : `systemctl disable ${sanitize(serviceName)}.service`;
    const result = await executePrivileged(cmd);

    return {
      ok: result.success,
      status: result.success ? 200 : 500,
      data: result.success
        ? { success: true, message: `Servico ${serviceName} ${enable ? 'habilitado' : 'desabilitado'} no boot` }
        : { error: result.error || result.stderr || 'Failed to toggle boot service' },
    };
  };

  const handleMaintenancePorts = async () => {
    const [portsResult, servicesResult] = await Promise.all([
      executePrivileged('firewall-cmd --zone=public --list-ports 2>/dev/null'),
      executePrivileged('firewall-cmd --zone=public --list-services 2>/dev/null'),
    ]);

    const ports = (portsResult.stdout || '').trim().split(/\s+/).filter(Boolean);
    const services = (servicesResult.stdout || '').trim().split(/\s+/).filter(s => s && !keepServices.has(s));

    return { ok: true, status: 200, data: { success: true, ports, services } };
  };

  const handleMaintenanceStatus = async () => {
    const flag = await readMaintenanceFlag();
    const maintenance = flag !== null;

    const sshResult = await executePrivileged('firewall-cmd --zone=public --query-service=ssh 2>/dev/null');
    const sshOpen = (sshResult.stdout || '').trim() === 'yes';

    return {
      ok: true,
      status: 200,
      data: {
        success: true,
        maintenance,
        sshOpen,
        blockedPorts: flag?.ports || [],
        blockedServices: flag?.services || [],
      },
    };
  };

  const handleMaintenanceEnable = async (body) => {
    const ports = Array.isArray(body?.ports) ? body.ports : [];
    const services = Array.isArray(body?.services) ? body.services : [];

    for (const port of ports) {
      await executePrivileged(`firewall-cmd --zone=public --permanent --remove-port=${sanitize(port)} 2>/dev/null; true`);
    }
    for (const svc of services) {
      if (!keepServices.has(svc)) {
        await executePrivileged(`firewall-cmd --zone=public --permanent --remove-service=${sanitize(svc)} 2>/dev/null; true`);
      }
    }

    if (ports.length > 0 || services.length > 0) {
      await executePrivileged('firewall-cmd --reload');
    }

    const flagData = {
      blockedAt: new Date().toISOString(),
      ports,
      services,
    };

    await writeMaintenanceFlag(flagData);

    const total = ports.length + services.length;
    return {
      ok: true,
      status: 200,
      data: {
        success: true,
        message: `Modo manutencao ativado. ${total} porta(s)/servico(s) bloqueada(s).`,
      },
    };
  };

  const handleMaintenanceDisable = async () => {
    const flag = await readMaintenanceFlag();
    const ports = flag?.ports || [];
    const services = flag?.services || [];

    for (const port of ports) {
      await executePrivileged(`firewall-cmd --zone=public --permanent --add-port=${sanitize(port)}`);
    }
    for (const svc of services) {
      await executePrivileged(`firewall-cmd --zone=public --permanent --add-service=${sanitize(svc)}`);
    }

    if (ports.length > 0 || services.length > 0) {
      await executePrivileged('firewall-cmd --reload');
    }

    await deleteMaintenanceFlag();

    const total = ports.length + services.length;
    return {
      ok: true,
      status: 200,
      data: {
        success: true,
        message: `Modo manutencao desativado. ${total} porta(s)/servico(s) restaurada(s).`,
      },
    };
  };

  const handleRequest = async (method, apiPath, body = {}) => {
    const verb = String(method || 'GET').toUpperCase();
    const { pathname, searchParams } = parsePath(apiPath);

    try {
      if (verb === 'GET' && pathname === '/api/system/ip') {
        const result = await executeCommand("hostname -I | awk '{print $1}'");
        return { ok: true, status: 200, data: { ip: (result.stdout || '').trim() || 'N/A' } };
      }

      if (verb === 'GET' && pathname === '/api/system/info') {
        return handleSystemInfo();
      }

      if (verb === 'GET' && pathname === '/api/services') {
        return handleServicesList();
      }

      if (verb === 'POST' && pathname === '/api/services') {
        return handleServicesAdd(body);
      }

      const serviceUnitMatch = pathname.match(/^\/api\/services\/([^/]+)\/unit-file$/);
      if (verb === 'GET' && serviceUnitMatch) {
        return handleServiceUnitFile(decodeURIComponent(serviceUnitMatch[1]));
      }

      const serviceActionMatch = pathname.match(/^\/api\/services\/([^/]+)\/(start|stop|restart|enable|disable)$/);
      if (verb === 'POST' && serviceActionMatch) {
        return handleServiceAction(decodeURIComponent(serviceActionMatch[1]), serviceActionMatch[2]);
      }

      const serviceNameMatch = pathname.match(/^\/api\/services\/([^/]+)$/);
      if (serviceNameMatch) {
        const serviceName = decodeURIComponent(serviceNameMatch[1]);
        if (verb === 'DELETE') {
          return handleServicesRemove(serviceName);
        }
        if (verb === 'PUT') {
          return handleServicesUpdate(serviceName, body);
        }
      }

      if (verb === 'POST' && pathname === '/api/terminal/execute') {
        return handleTerminalExecute(body);
      }

      if (verb === 'GET' && pathname === '/api/firewall/status') {
        return handleFirewallStatus();
      }

      if (verb === 'GET' && pathname === '/api/firewall/rules') {
        const zone = sanitize(searchParams.get('zone') || 'public');
        return handleFirewallRules(zone);
      }

      if (verb === 'POST' && pathname === '/api/firewall/add-port') {
        return handleFirewallAddRemovePort(body, true);
      }

      if (verb === 'POST' && pathname === '/api/firewall/remove-port') {
        return handleFirewallAddRemovePort(body, false);
      }

      if (verb === 'POST' && pathname === '/api/firewall/add-service') {
        return handleFirewallAddRemoveService(body, true);
      }

      if (verb === 'POST' && pathname === '/api/firewall/remove-service') {
        return handleFirewallAddRemoveService(body, false);
      }

      if (verb === 'GET' && pathname === '/api/firewall/ports') {
        const zone = sanitize(searchParams.get('zone') || 'public');
        return handleFirewallPorts(zone);
      }

      if (verb === 'GET' && pathname === '/api/firewall/analysis') {
        return handleFirewallAnalysis();
      }

      if (verb === 'POST' && pathname === '/api/firewall/template') {
        return handleFirewallTemplate(body);
      }

      if (verb === 'GET' && pathname === '/api/ssh/users') {
        return handleSshUsers();
      }

      const sshKeysMatch = pathname.match(/^\/api\/ssh\/users\/([^/]+)\/keys$/);
      if (verb === 'GET' && sshKeysMatch) {
        return handleSshUserKeys(decodeURIComponent(sshKeysMatch[1]));
      }

      const sshLockMatch = pathname.match(/^\/api\/ssh\/users\/([^/]+)\/lock$/);
      if (verb === 'POST' && sshLockMatch) {
        return handleSshLockUnlock(decodeURIComponent(sshLockMatch[1]), body);
      }

      const sshRevokeMatch = pathname.match(/^\/api\/ssh\/users\/([^/]+)\/revoke-key$/);
      if (verb === 'POST' && sshRevokeMatch) {
        return handleSshRevokeKey(decodeURIComponent(sshRevokeMatch[1]), body);
      }

      if (verb === 'POST' && pathname === '/api/ssh/users') {
        return handleSshCreateUser(body);
      }

      const sshPermMatch = pathname.match(/^\/api\/ssh\/users\/([^/]+)\/permissions$/);
      if (verb === 'GET' && sshPermMatch) {
        return handleSshPermissions(decodeURIComponent(sshPermMatch[1]));
      }

      if (verb === 'GET' && pathname === '/api/updates/pending') {
        return handleUpdatesPending();
      }

      if (verb === 'POST' && pathname === '/api/updates/install') {
        return handleUpdatesInstall(body);
      }

      if (verb === 'GET' && pathname === '/api/cleanup/info') {
        return handleCleanupInfo();
      }

      if (verb === 'POST' && pathname === '/api/cleanup/execute') {
        return handleCleanupExecute(body);
      }

      if (verb === 'GET' && pathname === '/api/boot/services') {
        return handleBootServices();
      }

      const bootToggleMatch = pathname.match(/^\/api\/boot\/services\/([^/]+)\/toggle$/);
      if (verb === 'POST' && bootToggleMatch) {
        return handleBootToggle(decodeURIComponent(bootToggleMatch[1]), body);
      }

      if (verb === 'GET' && pathname === '/api/maintenance/ports') {
        return handleMaintenancePorts();
      }

      if (verb === 'GET' && pathname === '/api/maintenance/status') {
        return handleMaintenanceStatus();
      }

      if (verb === 'POST' && pathname === '/api/maintenance/enable') {
        return handleMaintenanceEnable(body);
      }

      if (verb === 'POST' && pathname === '/api/maintenance/disable') {
        return handleMaintenanceDisable();
      }

      return notFound(pathname);
    } catch (error) {
      return {
        ok: false,
        status: 500,
        data: {
          error: error instanceof Error ? error.message : 'Unknown fallback API error',
        },
      };
    }
  };

  return {
    handleRequest,
  };
}
