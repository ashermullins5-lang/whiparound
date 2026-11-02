#!/usr/bin/env node
// Writes free-now.json: which official free channels in data/free-sources.json are live right now.
// Run by .github/workflows/free-now.yml every ~15 minutes; also works locally:
//   node scripts/free-now.mjs out/free-now.json
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkFreeNow } = require('../dev-server.cjs');

const outPath = process.argv[2] || 'free-now.json';
const catalog = JSON.parse(await readFile(new URL('../data/free-sources.json', import.meta.url), 'utf8'));
const result = await checkFreeNow(catalog.sources || [], { log: (m) => console.log(m) });
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(result, null, 1) + '\n');
console.log(`\n${result.live.length} live or upcoming of ${result.checked} channels checked; ${result.errors.length} errors → ${outPath}`);
// Always publish, even when YouTube refused every check: the site then says the check couldn't
// reach YouTube, instead of GitHub emailing a failure notice every 15 minutes.
