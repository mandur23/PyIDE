//! Loading straight into the types gives what loading through `migrate` gives: on every project the scenario builds
//! and samples, on the broken ones, and on thousands of variants with a field taken out, nulled, moved off the frame
//! grid or out of order. Where the cheap check says a file is current it must be what `migrate` returns.

mod common;

use common::{ask, projects};
use cut_model::Project;
use cut_model::canon::canonical;
use cut_oracle::Inputs;
use serde_json::{Value, json};

fn outcome(r: Result<Project, cut_model::LoadError>) -> Result<String, String> {
    r.map(|p| canonical(&p)).map_err(|e| format!("{}: {e:?}", e.code()))
}

/// A path to a random node of the tree, and the node.
fn pick_node<'a>(rng: &mut Inputs, v: &'a mut Value) -> &'a mut Value {
    let mut path: Vec<Value> = Vec::new();
    let mut node: &Value = v;
    for _ in 0..rng.range(0, 8) {
        let (step, next) = match node {
            Value::Object(o) if !o.is_empty() => {
                let k = o.keys().nth(rng.range(0, o.len() as i64 - 1) as usize).cloned().expect("a key");
                let n = &o[&k];
                (json!(k), n)
            }
            Value::Array(a) if !a.is_empty() => {
                let i = rng.range(0, a.len() as i64 - 1) as usize;
                (json!(i), &a[i])
            }
            _ => break,
        };
        if !(next.is_object() || next.is_array() || rng.range(0, 2) == 0) {
            break;
        }
        path.push(step);
        node = next;
    }
    let mut node = v;
    for step in path {
        node = match step {
            Value::String(k) => &mut node[k.as_str()],
            s => &mut node[s.as_u64().expect("an index") as usize],
        };
    }
    node
}

fn mutate(rng: &mut Inputs, v: &mut Value) {
    let node = pick_node(rng, v);
    match node {
        Value::Object(o) if !o.is_empty() => {
            let k = o.keys().nth(rng.range(0, o.len() as i64 - 1) as usize).cloned().expect("a key");
            match rng.range(0, 5) {
                0 | 1 => {
                    o.remove(&k);
                }
                2 => {
                    o.insert(k, Value::Null);
                }
                3 => {
                    if let Some(x) = o.get(&k).and_then(Value::as_f64) {
                        o.insert(k, json!(x + [1.0, 0.5, -3.0, 1e15][rng.range(0, 3) as usize]));
                    }
                }
                _ => {
                    o.insert(format!("{k}2"), json!(1));
                }
            }
        }
        Value::Array(a) if a.len() > 1 => {
            let (i, j) = (rng.range(0, a.len() as i64 - 1) as usize, rng.range(0, a.len() as i64 - 1) as usize);
            if rng.range(0, 1) == 0 {
                a.swap(i, j);
            } else {
                let x = a[i].clone();
                a.push(x);
            }
        }
        Value::Number(n) => {
            let x = n.as_f64().unwrap_or(0.0);
            *node = json!(x + [1.0, 0.5, -7.0][rng.range(0, 2) as usize]);
        }
        Value::String(s) => {
            *node = json!(["in", "out", "inOut", "", "x"][rng.range(0, 4) as usize].to_owned() + &s[..0]);
        }
        _ => {}
    }
}

#[test]
fn straight_load_is_the_migrated_load() {
    let mut texts = projects();
    texts
        .extend(ask(&[json!(["broken"])]).remove(0).as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_owned()));
    let base = texts.len();
    let mut rng = Inputs::new(51);
    let mut variants = Vec::new();
    for t in &texts {
        let Ok(v) = serde_json::from_str::<Value>(t) else { continue };
        for _ in 0..60 {
            let mut m = v.clone();
            for _ in 0..rng.range(1, 3) {
                mutate(&mut rng, &mut m);
            }
            variants.push(m.to_string());
        }
    }
    texts.extend(variants);
    let (mut fast, mut fast_ok, mut same_err, mut base_fast) = (0, 0, 0, 0);
    for (i, t) in texts.iter().enumerate() {
        let straight = outcome(Project::load(t));
        let migrated = outcome(Project::load_migrating(t));
        let current = serde_json::from_str::<Project>(t).is_ok_and(|p| cut_model::migrate::is_current(&p));
        if current {
            fast += 1;
            fast_ok += usize::from(straight.is_ok());
            base_fast += usize::from(i < base);
        }
        match (&straight, &migrated) {
            (Ok(a), Ok(b)) => assert!(a == b, "text {i} (current {current}): the loads differ\n{t}"),
            (Err(a), Err(b)) => {
                assert_eq!(a.split(':').next(), b.split(':').next(), "text {i}: the same refusal");
                same_err += 1;
            }
            _ => panic!("text {i} (current {current}): straight {straight:?}, migrated {migrated:?}\n{t}"),
        }
    }
    eprintln!(
        "{} texts ({base} projects, {base_fast} of them current, and {} variants): {fast} read straight ({fast_ok} valid), {same_err} refused alike",
        texts.len(),
        texts.len() - base
    );
    assert!(fast_ok > texts.len() / 10, "the straight path is taken");
}
