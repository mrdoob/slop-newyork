// tools/reorganize.mjs — moves the flat js/ modules into folders by concern (FOLDERS below) and rewrites every
// reference to them: relative imports between modules (static & dynamic), js/… paths in index.html, tests, tools,
// docs & comments, and the import specifiers tests stub by name. It only plans by default; --apply does it (with
// git mv when run in a git checkout, so history follows the files).
//
//   node tools/reorganize.mjs            print the plan
//   node tools/reorganize.mjs --apply    move & rewrite
//
// Re-runnable: modules already in their folder are left alone, so after merging a branch that still adds flat
// js/*.js files (or edits old paths), running it again files the newcomers and fixes their references. A flat
// module that FOLDERS doesn't list stays put and is reported.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = path.join(ROOT, 'js');

// js/<entry> → js/<folder>/<entry>; main.js stays at js/main.js as the page's entry point
const FOLDERS = {
  render: ['lighting.js', 'post-processing.js', 'tsl-materials.js', 'scene-culling.js'],
  world: [
    'city-config.js', 'city-geodata.js', 'city-grid.js', 'buildings.js', 'tepic-landmarks.js', 'cotos.js', 'street-details.js',
    'storefronts', 'terrain.js', 'ground.js', 'drape.js', 'trees.js', 'road-network.js', 'road-paint.js', 'bridges.js', 'weather.js'
  ],
  sim: ['traffic.js', 'pedestrians.js', 'pedestrian-routes.js', 'mayhem.js', 'weapons.js', 'crime-rules.js', 'gunfire-fx.js', 'crime.js'],
  actors: ['actor-models.js', 'vehicle-lights.js'],
  player: ['controllers.js', 'cameras.js', 'drivetrain.js', 'vehicle-damage.js'],
  input: ['touch-controls.js', 'gamepad-controls.js'],
  ui: ['city-map.js', 'tachometer.js', 'crime-hud.js'],
  audio: ['audio-acoustics.js', 'audio-events.js', 'audio-sources.js', 'audio-synthesis.js', 'audio-system.js'],
  net: ['multiplayer.js'],
  models: [] // (born in its folder: body shapes & the car models' data, js/models/cars/README.md)
};
const STAYS = new Set(['main.js']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.html', '.css', '.md', '.json', '.sh']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude', 'data']);

const apply = process.argv.includes('--apply');
const targetOf = new Map(Object.entries(FOLDERS).flatMap(([folder, entries]) => entries.map((e) => [e, folder])));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out);
    } else out.push(full);
  }
  return out;
}

// 1. Which top-level js/ entries move where
const moves = []; // [oldAbs, newAbs] per top-level entry
const unknown = [];
for (const entry of readdirSync(JS)) {
  if (STAYS.has(entry) || Object.hasOwn(FOLDERS, entry)) continue;
  const folder = targetOf.get(entry);
  if (!folder) {
    unknown.push(entry);
    continue;
  }
  moves.push([path.join(JS, entry), path.join(JS, folder, entry)]);
}

// Every file's new location (a moved folder carries its whole subtree)
const fileMap = new Map();
for (const [from, to] of moves) {
  if (statSync(from).isDirectory()) {
    for (const f of walk(from)) fileMap.set(f, path.join(to, path.relative(from, f)));
  } else fileMap.set(from, to);
}
const newPath = (abs) => fileMap.get(abs) ?? abs;
const movedNames = moves.map(([from]) => path.basename(from));

// 2. Rewrite contents (keyed by current path), before anything moves
const files = walk(ROOT).filter((f) => TEXT_EXT.has(path.extname(f)));
const rewritten = new Map();
const specMaps = new Map(); // module name → Map(old specifier → new specifier)
const SPEC_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"\n]+)\2/g;
const toSpec = (fromFile, target) => {
  const rel = path.relative(path.dirname(fromFile), target).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
};

for (const file of files) {
  let text = readFileSync(file, 'utf8');
  const original = text;
  const isModule = file.startsWith(JS + path.sep) && /\.m?js$/.test(file);
  if (isModule) {
    const specMap = new Map();
    text = text.replace(SPEC_RE, (match, lead, quote, spec) => {
      const target = path.resolve(path.dirname(file), spec);
      const next = toSpec(newPath(file), newPath(target));
      if (next !== spec) specMap.set(spec, next);
      return `${lead}${quote}${next}${quote}`;
    });
    specMaps.set(path.basename(file), specMap);
  }
  if (movedNames.length) {
    // js/<moved entry> anywhere (paths, preloads, comments) → js/<folder>/<entry>
    const names = movedNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const tokenRe = new RegExp(`(?<![\\w.-])js/(${names})(?=/|['"\`\\s),;:#?\\]]|$)`, 'gm');
    text = text.replace(tokenRe, (m, name) => `js/${targetOf.get(name)}/${name}`);
  }
  if (text !== original) rewritten.set(file, text);
}

// 3. Tests stub a module's imports by their exact specifier: follow the specifiers of the modules each test reads
for (const file of files.filter((f) => f.startsWith(path.join(ROOT, 'tests') + path.sep))) {
  let text = rewritten.get(file) ?? readFileSync(file, 'utf8');
  const tested = [...text.matchAll(/js\/(?:[\w-]+\/)*([\w-]+\.js)/g)].map((m) => m[1]);
  const changes = new Map();
  for (const name of new Set(tested)) {
    for (const [from, to] of specMaps.get(name) ?? []) {
      if (changes.has(from) && changes.get(from) !== to) changes.set(from, null); // two modules disagree
      else changes.set(from, to);
    }
  }
  for (const [from, to] of changes) {
    if (to === null) {
      console.warn(`! ${path.relative(ROOT, file)}: '${from}' is imported differently by the modules it tests; fix by hand`);
      continue;
    }
    text = text.split(`'${from}'`).join(`'${to}'`).split(`"${from}"`).join(`"${to}"`);
  }
  // the boot test's preload-path pattern (whatever shape a branch gave it) learns about folders
  const anyFolders = String.raw`/^\.\/js\/(?:[\w-]+\/)*[\w-]+\.js$/`;
  text = text.replace(/\/\^\\\.\\\/js\\\/[^\n]*?\\\.js\$\//g, () => anyFolders);
  if (text !== (rewritten.get(file) ?? readFileSync(file, 'utf8'))) rewritten.set(file, text);
}

// 4. Report / apply
const rel = (f) => path.relative(ROOT, f);
console.log(moves.length ? `${moves.length} entries to move:` : 'Nothing to move: js/ is already organized.');
for (const [from, to] of moves) console.log(`  ${rel(from)} → ${rel(to)}`);
console.log(`${rewritten.size} files with references to update${rewritten.size ? ':' : '.'}`);
for (const f of rewritten.keys()) console.log(`  ${rel(newPath(f))}`);
if (unknown.length) console.warn(`! not in FOLDERS, left in js/: ${unknown.join(', ')}`);
if (!apply) {
  if (moves.length || rewritten.size) console.log('\nDry run. Re-run with --apply to do it.');
  process.exit(0);
}

const inGit = existsSync(path.join(ROOT, '.git'));
for (const [from, to] of moves) {
  mkdirSync(path.dirname(to), { recursive: true });
  if (inGit) execFileSync('git', ['mv', rel(from), rel(to)], { cwd: ROOT });
  else renameSync(from, to);
}
for (const [file, text] of rewritten) writeFileSync(newPath(file), text);
console.log('\nDone. Run the tests (node --test tests/*.test.*) and load the page to check.');
