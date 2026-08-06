// System detection — the "detect" step of the provisioning core.
// Reuses the same logic as DeepCamera's env_config.py: identify compute
// hardware (Apple Silicon / NVIDIA / CPU), memory, free disk, and recommend
// an engine + model tier. No external deps; shells out to native tools.
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const exec = promisify(execFile);

async function sh(cmd, args = []) {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 8000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function diskFreeGB(target) {
  try {
    const { stdout } = await exec('df', ['-k', target]);
    const line = stdout.split('\n')[1];
    const cols = line.trim().split(/\s+/);
    return Math.round(Number(cols[3]) / 1024 ** 2);
  } catch {
    return 0;
  }
}

function recommend(api, ramGB) {
  if (api === 'metal' || api === 'cuda') {
    return ramGB >= 16
      ? { engine: 'llama.cpp (GPU) / SwiftLM', model: 'Q4_K_M 7B–14B', note: 'GPU 加速可用，可跑较大模型' }
      : { engine: 'llama.cpp (GPU) / SwiftLM', model: 'Q4_K_M ≤ 7B', note: '内存有限，选小模型' };
  }
  return { engine: 'llama.cpp (CPU)', model: 'Q4_K_M ≤ 3B', note: '纯 CPU 推理，选小模型更流畅' };
}

async function hasSwift() {
  return (await sh('swift', ['--version'])).includes('Swift');
}

export async function detectSystem() {
  const platform = process.platform; // darwin | linux | win32
  const arch = process.arch; // arm64 | x64
  const ramGB = Math.round(os.totalmem() / 1024 ** 3);

  let osVersion = '';
  let gpu = 'CPU';
  let gpuApi = 'cpu';

  if (platform === 'darwin') {
    osVersion = await sh('sw_vers', ['-productVersion']);
    const brand = await sh('sysctl', ['-n', 'machdep.cpu.brand_string']);
    if (/Apple/.test(brand) || arch === 'arm64') {
      gpu = 'Apple Silicon';
      gpuApi = 'metal';
    } else {
      gpu = 'Intel Mac';
      gpuApi = 'cpu';
    }
  } else if (platform === 'linux') {
    const rel = await readFile('/etc/os-release', 'utf8').catch(() => '');
    osVersion = rel.match(/PRETTY_NAME="?([^"\n]+)/)?.[1] || '';
    const nvidia = await sh('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']);
    if (nvidia) {
      gpu = nvidia.split('\n')[0].trim();
      gpuApi = 'cuda';
    }
  } else {
    gpu = 'CPU (Windows)';
    gpuApi = 'cpu';
  }

  const freeGB = await diskFreeGB(os.homedir());
  const modelRoot = os.homedir();
  const swiftPresent = await hasSwift();
  const appleSilicon = gpuApi === 'metal';

  const engines = [
    {
      id: 'llama.cpp',
      label: 'llama.cpp',
      available: true,
      note: gpuApi === 'metal' || gpuApi === 'cuda' ? 'GPU 加速推理（Metal / CUDA）' : '纯 CPU 推理',
    },
    {
      id: 'swiftlm',
      label: 'SwiftLM (Apple MLX)',
      available: swiftPresent && appleSilicon,
      appleOnly: true,
      note: swiftPresent && appleSilicon
        ? 'Apple Silicon 专属 · MLX 原生加速 · OpenAI 兼容'
        : '需 Apple Silicon + Swift 工具链',
    },
  ];

  return {
    platform,
    arch,
    osVersion,
    gpu,
    gpuApi,
    ramGB,
    diskFreeGB: freeGB,
    modelRoot,
    swiftAvailable: swiftPresent,
    appleSilicon,
    engines,
    recommended: recommend(gpuApi, ramGB),
  };
}
