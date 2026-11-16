// Writes crates/cut-model/src/effects/table.rs from the effect registry of renderer/features/cut/effects.js: every
// effect's and transition's name, kind and parameter definitions (the data; the shaders and CPU references stay in
// the JavaScript). Run it after effects.js changes: `node tools/gen-effects.mjs` and `cargo fmt`; tests/registry.rs fails until then.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const E = require(path.resolve(HERE, '..', '..', 'renderer', 'features', 'cut', 'effects.js'));
const OUT = path.resolve(HERE, '..', 'crates', 'cut-model', 'src', 'effects', 'table.rs');

const str = (s) => JSON.stringify(s);
const opt = (v, f) => (v === undefined ? 'None' : `Some(${f(v)})`);
const f64 = (x) => (Number.isInteger(x) ? `${x}.0` : String(x));
const KINDS = { number: 'Number', percent: 'Percent', angle: 'Angle', color: 'Color', bool: 'Bool', choice: 'Choice', point: 'Point', curve: 'Curve', lut: 'Lut' };

function dflt(p) {
  const v = p.default;
  if (typeof v === 'number') return `Default::Num(${f64(v)})`;
  if (typeof v === 'boolean') return `Default::Flag(${v})`;
  if (typeof v === 'string') return `Default::Text(${str(v)})`;
  if (Array.isArray(v)) return `Default::List(&[${v.map(f64).join(', ')}])`;
  throw new Error(`a default of ${p.id} that is no number, flag, text or list`);
}

function param(p) {
  if (!KINDS[p.type]) throw new Error(`unknown parameter type ${p.type}`);
  const choices = (p.choices || []).map(([id, name]) => `(${str(id)}, ${str(name)})`).join(', ');
  return `Param { id: ${str(p.id)}, name: ${str(p.name)}, kind: ParamKind::${KINDS[p.type]}, min: ${opt(p.min, f64)}, max: ${opt(p.max, f64)}, step: ${opt(p.step, f64)}, default: ${dflt(p)}, keyframable: ${!!p.keyframable}, group: ${opt(p.group, str)}, unit: ${opt(p.unit, str)}, choices: &[${choices}] }`;
}

function def(d, transition) {
  const kind = d.kind === 'audio' ? 'Kind::Audio' : 'Kind::Video';
  const params = d.params.map((p) => `        ${param(p)},`).join('\n');
  return `    Def {
        id: ${str(d.type)},
        name: ${str(d.name)},
        category: ${str(d.category)},
        kind: ${kind},
        transition: ${transition},
        masks: ${d.masks !== false},
        extend: ${!!d.layer?.extend},
        params: &[
${params}
        ],
    },`;
}

const body = [...E.list().map((d) => def(d, false)), ...E.transitions().map((d) => def(d, true))].join('\n');
const text = `// Written by tools/gen-effects.mjs from renderer/features/cut/effects.js; do not edit.
use super::{Def, Default, Kind, Param, ParamKind};

/// Every effect (video, then audio) and then every transition, in the registry's order.
pub static ALL: &[Def] = &[
${body}
];
`;
fs.writeFileSync(OUT, text);
console.log(`${OUT}: ${E.list().length} effects, ${E.transitions().length} transitions`);
