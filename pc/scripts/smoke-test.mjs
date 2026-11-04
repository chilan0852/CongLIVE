#!/usr/bin/env node
/**
 * Developer smoke test for the Electron shell.
 *
 * Runs the real app (current host platform — Linux/ARM64 on this build machine)
 * under Xvfb, loads either the launcher or the configured server, captures a
 * screenshot and prints a machine-readable `SMOKE_RESULT {...}` line.
 *
 * This validates main/preload/launcher wiring; Windows-only behaviour
 * (camera/mic permissions, screen picker, native shortcuts) still needs a real
 * Windows 10/11 machine — see README.
 *
 * Usage:
 *   node scripts/smoke-test.mjs [launcher|server] [serverUrl]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mode = ['launcher', 'server', 'flow', 'picker'].includes(process.argv[2]) ? process.argv[2] : 'launcher';
const serverUrl = process.argv[3] || '';
const buildDir = join(ROOT, 'build');
const outFile = join(buildDir, `smoke-${mode}.png`);
const userDataDir = join(buildDir, 'user-data-smoke');

const electronPath = (await import('electron')).default;
mkdirSync(buildDir, { recursive: true });
rmSync(userDataDir, { recursive: true, force: true });

const appArgs = [
  '.',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--enable-logging=stderr',
  '--v=0',
  `--smoke-test=${mode}`,
  `--smoke-out=${outFile}`,
];
if (serverUrl) appArgs.push(`--smoke-server=${serverUrl}`);

const hasDisplay = Boolean(process.env.DISPLAY);
const hasXvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).status === 0;
const command = !hasDisplay && hasXvfb ? 'xvfb-run' : electronPath;
const args = !hasDisplay && hasXvfb
  ? ['-a', electronPath, ...appArgs]
  : appArgs;

if (!hasDisplay && !hasXvfb) {
  console.error('smoke-test: no DISPLAY and xvfb-run is not installed; cannot run the GUI smoke test');
  process.exit(0);
}

console.log(`smoke-test: mode=${mode}${serverUrl ? ` server=${serverUrl}` : ''}`);
console.log(`smoke-test: ${command} ${args.join(' ')}`);

const result = spawnSync(command, args, {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 180000,
  env: {
    ...process.env,
    CONGLIVE_PC_USER_DATA: userDataDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  },
});

const stdout = result.stdout || '';
const stderr = result.stderr || '';
const match = stdout.match(/SMOKE_RESULT (\{.*\})/);
if (!match) {
  console.error('smoke-test: no SMOKE_RESULT line found');
  if (stdout.trim()) console.error('--- stdout ---\n' + stdout.slice(-4000));
  if (stderr.trim()) console.error('--- stderr ---\n' + stderr.slice(-6000));
  process.exit(1);
}

const info = JSON.parse(match[1]);
console.log(JSON.stringify(info, null, 2));

const problems = [];
if (!info.ok) problems.push('app reported failure: ' + (info.error || 'unknown'));
if (!existsSync(outFile)) problems.push('screenshot was not captured');
else if (statSync(outFile).size < 5000) problems.push('screenshot looks empty');
if (mode === 'server') {
  if (info.pcClass !== true) problems.push('desktop/pc-client classes were not injected into the page');
  if (info.preloadApi !== true) problems.push('window.conglivePC preload bridge is missing');
  if (info.mobileHintsHidden !== true) problems.push('injected CSS does not hide .mobile-only markers');
}
if (mode === 'flow') {
  if (info.launcherForm !== true) problems.push('launcher form did not render in flow mode');
  if (!info.savedServer) problems.push('server address was not persisted to config.json');
  if (info.pcClass !== true) problems.push('desktop/pc-client classes were not injected into the main window');
  if (info.preloadApi !== true) problems.push('window.conglivePC preload bridge is missing in the main window');
  if (info.mobileHintsHidden !== true) problems.push('injected CSS does not hide .mobile-only markers in the main window');
  if (!String(info.url || '').startsWith(String(info.savedServer || '\u0000'))) problems.push('main window did not load the saved server');
  if (!String(info.title || '').length) problems.push('main window has no document title');
}
if (mode === 'picker') {
  if (info.visible !== true) problems.push('screen picker window is not visible');
  if (!(info.sourceCount >= 2)) problems.push(`screen picker listed ${info.sourceCount} sources (expected >= 2)`);
  if (info.closedAfterSelect !== true) problems.push('screen picker did not close after selecting a source');
  if (!String(info.titleText || '').length) problems.push('screen picker title is empty');
}
if (mode === 'launcher') {
  if (info.launcherForm !== true) problems.push('launcher form did not render');
  if (info.launcherI18n && (info.launcherI18n.zh !== '服务器地址' || info.launcherI18n.en !== 'Server address')) {
    problems.push(`launcher language toggle is broken: ${JSON.stringify(info.launcherI18n)}`);
  }
  if (info.launcherPreview && !String(info.launcherPreview).includes('https://xinglan.work')) {
    problems.push(`launcher normalisation preview is wrong: ${JSON.stringify(info.launcherPreview)}`);
  }
}

if (result.status !== 0) problems.push(`electron exited with code ${result.status}`);
if (problems.length) {
  console.error('\nsmoke-test FAILED:');
  for (const problem of problems) console.error(` - ${problem}`);
  if (stderr.trim()) console.error('--- stderr tail ---\n' + stderr.slice(-4000));
  process.exit(1);
}
console.log(`\nsmoke-test PASS (screenshot: ${outFile})`);
