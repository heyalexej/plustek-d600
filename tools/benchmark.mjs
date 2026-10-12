#!/usr/bin/env node
// Run one bounded scan and record acquisition time separately from startup/ejection.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
console.time('benchmark');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let child;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child?.kill(signal));
try {
  const args = process.argv.slice(2), options = {};
  while (args.length) {
    const flag = args.shift();
    if (flag === '--duplex') options.duplex = true;
    else if (['--period', '--exposure', '--gain', '--dpi', '--feed-period', '--mode', '--output'].includes(flag) && args.length) options[flag.slice(2)] = args.shift();
    else throw new Error('Usage: node tools/benchmark.mjs --period 12000 --exposure 10000 [--gain 0] [--dpi 300|600] [--feed-period 700..10000] [--mode gray|color] [--duplex] [--output captures/benchmark/name]');
  }
  const feedPeriod = Number(options['feed-period'] ?? 10000);
  if (!Number.isInteger(feedPeriod) || feedPeriod < 700 || feedPeriod > 10000) throw new Error('Feed period must be 700..10000.');
  const period = Number(options.period), gain = Number(options.gain ?? 0), mode = options.mode ?? 'color', dpi = Number(options.dpi ?? 600);
  if (!Number.isInteger(period) || period < (dpi === 300 ? 1400 : 2800) || period > 20000 || ![300,600].includes(dpi) || !['gray','color'].includes(mode) || !Number.isInteger(gain) || gain < 0 || gain > 63) throw new Error('Invalid timing, gain or mode. Period must be 1400..20000 (300 dpi) or 2800..20000 (600 dpi), gain 0..63.');
  if (options.exposure && (!Number.isInteger(Number(options.exposure)) || Number(options.exposure) < 1 || Number(options.exposure) >= period)) throw new Error('Exposure must be positive and below the line period. Omit it to use profile RGB exposures.');
  try {
    await fetch('http://127.0.0.1:8765/api/state', {signal: AbortSignal.timeout(1000)});
    throw new Error('Stop the scanner UI before running a hardware benchmark.');
  } catch (error) { if (error.message.startsWith('Stop the')) throw error; }
  const output = resolve(root, options.output ?? `captures/benchmark/${Date.now()}-${mode}-${options.duplex ? 'duplex' : 'simplex'}-${period}`);
  if (existsSync(output + '.json') || existsSync(output + '.log')) throw new Error('Output already exists; choose a new name.');
  mkdirSync(dirname(output), {recursive: true});
  const env = {...process.env};
  for (const key of Object.keys(env)) if (key.startsWith('D600_')) delete env[key];
  Object.assign(env, {D600_LINE_PERIOD: String(period), D600_GAIN: String(gain), D600_SIDE: '1', D600_LAMPS: '3', D600_FEED_PERIOD: String(feedPeriod)});
  if (options.exposure) env.D600_EXPOSURE = options.exposure;
  let log = '', cancelled = false;
  async function run(args) {
    return new Promise((done, reject) => {
      child = spawn(resolve(root, 'artifacts/bin/d600-experiment'), args, {cwd: root, env, stdio:['ignore','pipe','pipe']});
      child.once('error', reject);
      child.stdout.on('data', bytes => {log += bytes; process.stdout.write(bytes);});
      child.stderr.on('data', bytes => {log += bytes;});
      child.once('close', (code, signal) => {cancelled ||= Boolean(signal); child = null; done(code);});
    });
  }
  const started = performance.now();
  const profile = resolve(root, `profiles/native-${options.duplex ? 'duplex-' : ''}${mode}${dpi}.json`);
  const code = await run(['--scan-auto', profile, output + (mode === 'color' ? '.ppm' : '.pgm')]);
  const scanSeconds = (performance.now() - started) / 1000;
  const timing = /Capture timing: seconds=([\d.]+) rows=(\d+) bytes=(\d+)/.exec(log);
  let ejectCode = null;
  if (code === 0 && !cancelled) ejectCode = await run(['--eject-tail', resolve(root,'profiles/native-gray600.json')]);
  const result = {mode, duplex: Boolean(options.duplex), dpi, period, feedPeriod, exposure:options.exposure ? Number(options.exposure) : 'profile', gain,
    code, ejectCode, scanSeconds, acquisitionSeconds:timing ? Number(timing[1]) : null, rows:timing ? Number(timing[2]) : null, bytes:timing ? Number(timing[3]) : null};
  writeFileSync(output + '.log', log); writeFileSync(output + '.json', JSON.stringify(result,null,2)+'\n');
  console.table([result]);
  console.log(`Saved ${output}.json and .log`);
  if (code !== 0 || ejectCode !== 0) process.exitCode = 1;
} catch (error) {console.error(error.message);process.exitCode = 1;}
finally {console.timeEnd('benchmark');}
