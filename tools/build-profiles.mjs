#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
console.time('build-profiles');
try {
  const directory = new URL('../profiles/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^native-.*(?:300|600)\.json$/.test(name))) {
    const path = fileURLToPath(new URL(name, directory));
    const profile = JSON.parse(readFileSync(path));
    if (profile.device !== '07b3:0c27' || profile.revision !== '0500' || ![300, 600].includes(profile.dpi)) throw new Error(`Unsupported profile: ${name}`);
    const registers = Object.entries(profile.registers), afe = Object.entries(profile.afe);
    if (registers.length !== 100 || afe.length !== 8) throw new Error(`Incomplete profile: ${name}`);
    for (const [entries, limit, maxValue] of [[registers, 192, 255], [afe, 48, 65535]]) {
      for (const [address, value] of entries) if (!/^0x[0-9a-f]{2}$/.test(address) || Number(address) >= limit || !Number.isInteger(value) || value < 0 || value > maxValue) throw new Error(`Invalid register in ${name}`);
    }
    writeFileSync(path + '.registers.bin', Buffer.from(registers.flatMap(([address, value]) => [Number(address), value])));
    writeFileSync(path + '.afe.bin', Buffer.from(afe.flatMap(([address, value]) => [Number(address), value >> 8, value & 255])));
    console.log(`Built ${name}`);
  }
} finally { console.timeEnd('build-profiles'); }
