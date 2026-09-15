/**
 * 设备指纹生成（提取自 commandcode-proxy，对齐 CLI 1.53.1）
 *
 * 每个 CC API Key 确定性地生成一组逼真的 Windows 设备信号：
 * - MachineGuid 形状的机器 ID
 * - 真实形态的 MAC 地址
 * - DESKTOP-xxxx 主机名
 * - CPU / 内存 / 时区
 * 重启、多实例、停用后恢复都看到同一台设备。
 */
import crypto from 'crypto';
import config from '../config.js';

// CPU 型号与核心数对应表（仅 Windows x64）
const CPUS = [
  { model: '12th Gen Intel(R) Core(TM) i7-12650H', cores: 10 },
  { model: '12th Gen Intel(R) Core(TM) i5-12400F', cores: 6 },
  { model: '12th Gen Intel(R) Core(TM) i9-12900K', cores: 16 },
  { model: '13th Gen Intel(R) Core(TM) i7-13700K', cores: 16 },
  { model: '13th Gen Intel(R) Core(TM) i5-13600K', cores: 14 },
  { model: '13th Gen Intel(R) Core(TM) i9-13900K', cores: 24 },
  { model: 'Intel(R) Core(TM) Ultra 7 155H', cores: 16 },
  { model: 'Intel(R) Core(TM) Ultra 9 285H', cores: 16 },
  { model: 'Intel(R) Core(TM) i9-14900K', cores: 24 },
  { model: 'Intel(R) Core(TM) i7-14700K', cores: 20 },
  { model: 'AMD Ryzen 7 7800X3D', cores: 8 },
  { model: 'AMD Ryzen 9 7950X', cores: 16 },
  { model: 'AMD Ryzen 5 7600', cores: 6 },
  { model: 'AMD Ryzen 9 7900X', cores: 12 },
  { model: 'AMD Ryzen 7 5800X3D', cores: 8 },
];
const MEMS = [8, 16, 24, 32, 48, 64];
const TZS = [
  'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Toronto',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Moscow',
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Seoul', 'Asia/Hong_Kong',
  'Australia/Sydney', 'Pacific/Auckland',
];
const MAC_COUNT_RANGE = [2, 3, 4, 5];
const OS_USERS = ['dev', 'user', 'admin', 'coder', 'engineer', 'work'];
const MAIL_DOMAINS = ['gmail.com', 'outlook.com', 'qq.com', '163.com'];

// CLI 的根盐
const FP_SALT = 'command-code:device-fingerprint:v1';

// 设备档案
export const DEVICE_PROFILE = {
  platform: 'win32',
  arch: 'x64',
  osRelease: '10.0.22631',
  isContainer: false,
  get projectDir() { return config.ccDeviceProjectDir; },
};

function fpDigest(apiKey, field) {
  return crypto.createHash('sha256')
    .update(`${config.ccFingerprintSalt || ''}\0${apiKey}\0${field}`)
    .digest();
}

function fpPickIndex(apiKey, field, items, labelOf) {
  let bestIdx = 0;
  let bestScore = null;
  for (let i = 0; i < items.length; i++) {
    const score = fpDigest(apiKey, `${field}\0${labelOf(i)}`);
    if (!bestScore || Buffer.compare(score, bestScore) > 0) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}

function fingerprintHash(value) {
  const v = String(value ?? '').trim();
  if (!v) return undefined;
  return crypto.createHash('sha256').update(`${FP_SALT}\0${v.toLowerCase()}`).digest('hex');
}

/**
 * 可用时区列表（导出给前端选择）
 */
export const TIMEZONE_OPTIONS = TZS;

/**
 * 生成设备指纹
 * @param {string} apiKey - CC 原始 Key
 * @param {object} [overrides] - 管理员覆盖参数
 * @param {string} [overrides.timezone] - 强制指定时区
 */
export function generateFingerprint(apiKey, overrides = {}) {
  const cpuEntry = CPUS[fpPickIndex(apiKey, 'cpu', CPUS, i => `${CPUS[i].model}|${CPUS[i].cores}`)];
  const memGiB = MEMS[fpPickIndex(apiKey, 'mem', MEMS, i => String(MEMS[i]))];
  const autoTz = TZS[fpPickIndex(apiKey, 'timezone', TZS, i => TZS[i])];
  const tz = overrides.timezone || autoTz;
  const macCount = MAC_COUNT_RANGE[fpPickIndex(apiKey, 'macCount', MAC_COUNT_RANGE, i => String(MAC_COUNT_RANGE[i]))];
  const osUser = OS_USERS[fpPickIndex(apiKey, 'osUser', OS_USERS, i => OS_USERS[i])];
  const mailDomain = MAIL_DOMAINS[fpPickIndex(apiKey, 'mailDomain', MAIL_DOMAINS, i => MAIL_DOMAINS[i])];
  const hex = (field, bytes) => fpDigest(apiKey, field).subarray(0, bytes).toString('hex');

  // Windows MachineGuid 形状：8-4-4-4-12
  const mid = hex('machineId', 16);
  const machineId = `${mid.slice(0, 8)}-${mid.slice(8, 12)}-${mid.slice(12, 16)}-${mid.slice(16, 20)}-${mid.slice(20, 32)}`;
  const macs = [];
  for (let i = 0; i < macCount; i++) {
    const b = fpDigest(apiKey, `mac${i}`).subarray(0, 6);
    macs.push([...b].map(x => x.toString(16).padStart(2, '0')).join(':'));
  }
  macs.sort();
  const hostname = `DESKTOP-${hex('hostname', 4).toUpperCase()}`;
  const gitEmail = `${osUser}.${hex('gitEmail', 3)}@${mailDomain}`;

  const machineIdHash = fingerprintHash(machineId);
  const macHashes = macs.map(fingerprintHash).filter(Boolean);
  const osUserHash = fingerprintHash(osUser);
  const hostnameHash = fingerprintHash(hostname);
  const gitEmailHash = fingerprintHash(gitEmail);

  const thumbSeed = [machineId.trim(), macs.join(','), machineId.trim() ? '' : hostname, machineId.trim() ? '' : cpuEntry.model].filter(Boolean);
  const thumbmark = crypto.createHash('sha256').update(`${FP_SALT}\0machine\0${thumbSeed.join('|') || 'unknown'}`).digest('hex');

  return {
    thumbmark,
    // 管理员可见的设备摘要（不含敏感哈希）
    _summary: {
      hostname,
      cpu: cpuEntry.model,
      cores: cpuEntry.cores,
      memGiB,
      timezone: tz,
      macCount,
      osUser,
    },
    components: {
      machineIdHash, macHashes, osUserHash, hostnameHash, gitEmailHash,
      platform: DEVICE_PROFILE.platform,
      arch: DEVICE_PROFILE.arch,
      osRelease: DEVICE_PROFILE.osRelease,
      cpuModel: cpuEntry.model,
      cpuCount: cpuEntry.cores,
      memGiB,
      isContainer: DEVICE_PROFILE.isContainer,
      timezone: tz,
      runtime: 'cli',
      collectorVersion: 1,
    },
  };
}

/**
 * 只拿设备摘要（给前端看，不发到上游）
 */
export function getDeviceSummary(apiKey, overrides = {}) {
  const fp = generateFingerprint(apiKey, overrides);
  return fp._summary;
}
