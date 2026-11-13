import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const CHROME = resolve(
  process.env.HOME,
  'Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell',
);
const PORT = 9334;
const URL = 'http://127.0.0.1:5188/';
const PROFILE = resolve(ROOT, 'tmp/cdp-profile');
const OUTPUT = resolve(ROOT, 'tmp');
const HOME = resolve(ROOT, 'tmp/home');

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(OUTPUT, { recursive: true });

const browser = spawn(
  CHROME,
  [
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--hide-scrollbars',
    '--window-size=1600,960',
    '--force-device-scale-factor=1',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ],
  {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, HOME },
  },
);

let stderr = '';
browser.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

async function waitForDebugger() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return response.json();
    } catch {
      // Browser is still starting.
    }
    await sleep(150);
  }
  throw new Error('Chrome debugger did not start');
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.consoleLogs = [];
    this.exceptions = [];
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const args = message.params.args
          .map((arg) => arg.value ?? arg.description ?? arg.type)
          .join(' ');
        this.consoleLogs.push(`[${message.params.type}] ${args}`);
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(
          message.params.exceptionDetails.exception?.description ??
            message.params.exceptionDetails.text,
        );
      }
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener('open', resolveOpen, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function capture(client, name) {
  const result = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  writeFileSync(resolve(OUTPUT, `${name}.png`), Buffer.from(result.data, 'base64'));
  console.log(`saved tmp/${name}.png`);
}

try {
  await waitForDebugger();
  const targetResponse = await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL)}`,
    { method: 'PUT' },
  );
  const target = await targetResponse.json();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.open();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await sleep(4000);

  const evaluation = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const api = window.__tricolor;
      const data = api?.build();
      return {
        ready: !!data,
        debug: api?.debug(),
        state: api?.state(),
        canvas: (() => { const c = document.querySelector('#scene'); const r = c?.getBoundingClientRect(); return r ? { width: r.width, height: r.height } : null; })(),
        validation: data?.validation,
        stats: data?.stats,
        sites: data?.pattern?.sites?.length,
        storedParts: data?.parts?.map((part) => ({ vertices: part.positions.length / 3, volume: part.volume })),
      };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify(evaluation.result.value, null, 2));
  console.log('console:', client.consoleLogs.slice(-12));
  console.log('exceptions:', client.exceptions);

  const connectorCheck = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const report = window.__tricolor.build()?.validation;
      if (!report) return null;
      return {
        surfaceIslandCounts: report.surfaceIslandCounts,
        stemCounts: report.stemCounts,
        partConnected: report.partConnected,
        plateConnected: report.plateConnected,
        connectorVolume: report.connectorVolume,
        totalPrintVolume: report.totalPrintVolume,
      };
    })()`,
    returnByValue: true,
  });
  console.log('connectors:', JSON.stringify(connectorCheck.result.value, null, 2));

  await capture(client, 'scene-assembled');

  await client.send('Runtime.evaluate', {
    expression: `window.__tricolor.setMode('exploded');`,
  });
  await sleep(1400);
  await capture(client, 'scene-exploded');

  await client.send('Runtime.evaluate', {
    expression: `window.__tricolor.setMode('xray');`,
  });
  await sleep(800);
  await capture(client, 'scene-xray');

  await client.send('Runtime.evaluate', {
    expression: `window.__tricolor.setMode('assembled'); window.__tricolor.setSelection([0]);`,
  });
  await sleep(900);
  await capture(client, 'scene-solo-yellow');

  await client.send('Runtime.evaluate', {
    expression: `window.__tricolor.setSelection([0, 2]);`,
  });
  await sleep(500);
  await capture(client, 'scene-multi-select');

  await client.send('Runtime.evaluate', {
    expression: `window.__tricolor.setSelection([]); window.__tricolor.setMode('assembled'); window.__tricolor.setViewingAngle(20, -10, 240, 0);`,
  });
  await sleep(700);
  await capture(client, 'scene-top');

  await client.send('Runtime.evaluate', {
    expression: `window.__tricolor.setMode('assembled'); window.__tricolor.setViewingAngle(104, -136, 105, 0);`,
  });
  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 342;
      const context = canvas.getContext('2d');
      context.fillStyle = '#000';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const blobs = [
        [160, 160, 120, 'rgba(255,255,255,0.95)'],
        [350, 105, 100, 'rgba(210,210,210,0.85)'],
        [300, 245, 130, 'rgba(180,180,180,0.8)'],
        [405, 280, 65, 'rgba(150,150,150,0.7)'],
      ];
      for (const [x, y, r, color] of blobs) {
        const gradient = context.createRadialGradient(x, y, 0, x, y, r);
        gradient.addColorStop(0, color);
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      canvas.toBlob((blob) => {
        const input = document.getElementById('depth-file');
        const file = new File([blob], 'capture-depth.png', { type: 'image/png' });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, 'image/png');
    })()`,
    awaitPromise: true,
  });
  await sleep(3000);
  const depthResult = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const data = window.__tricolor.build();
      return {
        shapeName: document.getElementById('shape-name')?.textContent,
        shapeKind: document.getElementById('shape-kind')?.textContent,
        shapeRange: document.getElementById('shape-range')?.textContent,
        fieldKind: data?.field?.kind,
        validation: data ? {
          minHeight: data.validation.minSurfaceHeight,
          maxHeight: data.validation.maxSurfaceHeight,
          partConnected: data.validation.partConnected,
          connectorVolume: data.validation.connectorVolume,
        } : null,
      };
    })()`,
    returnByValue: true,
  });
  console.log('depth map:', JSON.stringify(depthResult.result.value, null, 2));
  await capture(client, 'scene-depthmap');

  await client.send('Runtime.evaluate', {
    expression: `document.getElementById('reset-shape').click()`,
  });
  await sleep(1600);

  await client.send('Runtime.evaluate', {
    expression: `document.getElementById('load-demo').click()`,
  });
  await sleep(5000);
  const demoResult = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const data = window.__tricolor.build();
      return {
        depthName: document.getElementById('shape-name')?.textContent,
        colourName: document.getElementById('color-name')?.textContent,
        colourStatus: document.getElementById('color-status')?.textContent,
        areaRatios: data?.validation?.areaRatios,
        islands: data?.validation?.surfaceIslandCounts,
        volumeExclusive: data?.validation?.volumeExclusive,
        partConnected: data?.validation?.partConnected,
        locks: [...document.querySelectorAll('#lattice-section input, #lattice-section button')].every((el) => el.disabled),
      };
    })()`,
    returnByValue: true,
  });
  console.log('wave demo:', JSON.stringify(demoResult.result.value, null, 2));
  await capture(client, 'scene-wave-demo');

  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const pitch = document.getElementById('pitch-range');
      pitch.value = '2.4';
      pitch.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
  });
  await sleep(1800);
  const densityResult = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const data = window.__tricolor.build();
      return {
        pitch: document.getElementById('pitch-output')?.textContent,
        ratios: data?.validation?.areaRatios,
        stems: data?.validation?.stemCounts,
        parts: data?.validation?.partConnected,
      };
    })()`,
    returnByValue: true,
  });
  console.log('density:', JSON.stringify(densityResult.result.value, null, 2));

  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const top = document.getElementById('layer-top');
      top.value = '1';
      top.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  });
  await sleep(1800);
  const layersResult = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const data = window.__tricolor.build();
      return {
        layers: [...document.querySelectorAll('#layer-top,#layer-middle,#layer-bottom')].map((el) => el.value),
        base: data?.validation?.baseColour,
        parts: data?.validation?.partConnected,
        ratios: data?.validation?.areaRatios,
      };
    })()`,
    returnByValue: true,
  });
  console.log('layer colors:', JSON.stringify(layersResult.result.value, null, 2));
  await capture(client, 'scene-layer-colors');

  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const top = document.getElementById('layer-top');
      top.value = '0';
      top.dispatchEvent(new Event('change', { bubbles: true }));
      const pitch = document.getElementById('pitch-range');
      pitch.value = '1.5';
      pitch.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('reset-color').click();
      document.getElementById('reset-shape').click();
      return true;
    })()`,
  });
  await sleep(1800);

  const changeResult = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const ratio = document.getElementById('ratio-yellow');
      ratio.value = '58';
      ratio.dispatchEvent(new Event('input', { bubbles: true }));
      const arrangement = document.querySelector('[data-arrangement="staggered"]');
      arrangement.click();
      const pitch = document.getElementById('pitch-input');
      pitch.value = '8';
      pitch.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
    returnByValue: true,
  });
  void changeResult;
  await sleep(2600);
  const changedMetrics = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const data = window.__tricolor.build();
      return {
        validation: data?.validation,
        stats: data?.stats,
        params: data?.pattern?.params,
        state: window.__tricolor.state(),
      };
    })()`,
    returnByValue: true,
  });
  console.log('after params:', JSON.stringify(changedMetrics.result.value, null, 2));
  await capture(client, 'scene-params-changed');

  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await client.send('Runtime.evaluate', {
    expression: `window.__tricolor.setMode('assembled'); window.__tricolor.setViewingAngle(104, -136, 105, 0);`,
  });
  await sleep(900);
  await capture(client, 'scene-1280');

  console.log('final console:', client.consoleLogs.slice(-20));
  console.log('final exceptions:', client.exceptions);
  client.close();
} catch (error) {
  console.error(error);
  console.error(stderr.split('\n').slice(-30).join('\n'));
  process.exitCode = 1;
} finally {
  browser.kill('SIGKILL');
}
