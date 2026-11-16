//! Generator clips' settings and their text and graphic layers (port of commands.js's `setGenerator`, `setLayer`,
//! `addLayer` and `removeLayer`).

use serde_json::{Value as Json, json};

use super::timeline::text_layers;
use super::{Code, Ctx, R, context, defined, fail, invalid, opts, string};
use crate::history::journal::Tx;
use crate::id::Id;
use crate::project::{Clip, Generator, Project, Source};

fn generator_clip(c: &Ctx, cmd: &Json) -> R<(Clip, Generator)> {
    let clip = c.clip_json(cmd.get("clipId"))?.clone();
    let Source::Generator { generator, .. } = &clip.source else {
        return invalid(format!("clip {} is not a generator clip", clip.id));
    };
    let g = *generator;
    c.unlocked(clip.track)?;
    Ok((clip, g))
}

fn layers_of(clip: &Clip) -> Vec<Json> {
    match &clip.source {
        Source::Generator { layers: Some(l), .. } => l.clone(),
        _ => Vec::new(),
    }
}

fn set_layers(c: &mut Ctx, id: Id, layers: Vec<Json>) {
    c.edit(id, |x| {
        if let Source::Generator { layers: l, .. } = &mut x.source {
            *l = Some(layers);
        }
    });
}

fn drop_layer_keys(c: &mut Ctx, id: Id, layer: &str) {
    let prefix = format!("layers.{layer}.");
    c.edit(id, |x| x.keyframes.retain(|k, _| !k.starts_with(&prefix)));
}

fn layer_id(l: &Json) -> Option<&str> {
    l.get("id").and_then(Json::as_str)
}

fn bad_graphic(layers: &[Json]) -> R<()> {
    let errors = crate::graphic::validate(Some(&Json::Array(layers.to_vec())));
    if errors.is_empty() {
        Ok(())
    } else {
        fail(format!("the graphic is not valid: {}", errors.join("; ")), Code::BadGraphic)
    }
}

pub fn set_generator(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let (clip, g) = generator_clip(&c, cmd)?;
    let patch = opts(cmd, "patch").clone();
    for k in super::js_spread(&patch).keys() {
        if k != "color" && k != "layers" {
            return invalid(format!("unknown generator setting {k}"));
        }
    }
    if let Some(color) = defined(&patch, "color") {
        if g != Generator::Solid {
            return invalid("only a solid has a color");
        }
        let color = string(color);
        c.edit(clip.id, |x| {
            if let Source::Generator { color: cl, .. } = &mut x.source {
                *cl = Some(color);
            }
        });
    }
    if let Some(l) = defined(&patch, "layers") {
        let layers = match g {
            Generator::Text => text_layers(Some(l)),
            Generator::Graphic => super::timeline::graphic_layers(Some(l))?,
            _ => return invalid("only a text or graphic clip has layers"),
        };
        for old in layers_of(&clip) {
            if let Some(id) = layer_id(&old)
                && !layers.iter().any(|x| layer_id(x) == Some(id))
            {
                drop_layer_keys(&mut c, clip.id, id);
            }
        }
        set_layers(&mut c, clip.id, layers);
    }
    Ok(json!({}))
}

fn layer_index(clip: &Clip, id: Option<&Json>) -> R<usize> {
    let want = id.and_then(Json::as_str);
    layers_of(clip).iter().position(|l| layer_id(l).is_some() && layer_id(l) == want).map_or_else(
        || fail(format!("there is no layer {}", id.map_or("undefined".into(), string)), Code::NotFound),
        Ok,
    )
}

fn no_layers<T>(cmd: &Json) -> R<T> {
    invalid(format!("clip {} has no layers", cmd.get("clipId").map_or("undefined".into(), string)))
}

pub fn set_layer(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let (clip, g) = generator_clip(&c, cmd)?;
    let i = layer_index(&clip, cmd.get("layerId"))?;
    let mut layers = layers_of(&clip);
    match g {
        Generator::Graphic => {
            let patch = super::js_spread(opts(cmd, "patch"));
            if patch.contains_key("id") || patch.get("kind").is_some_and(|k| Some(k) != layers[i].get("kind")) {
                return invalid("a layer keeps its id and kind");
            }
            for (k, v) in patch {
                if k != "kind" {
                    layers[i][k] = v;
                }
            }
            bad_graphic(&layers)?;
        }
        Generator::Text => {
            let fields: Vec<String> = crate::defaults::text_layer(&Default::default())
                .as_object()
                .map(|o| o.keys().filter(|k| *k != "id").cloned().collect())
                .unwrap_or_default();
            for (k, v) in super::js_spread(opts(cmd, "patch")) {
                if !fields.contains(&k) {
                    return invalid(format!("unknown text layer field {k}"));
                }
                layers[i][k] = v;
            }
        }
        _ => return no_layers(cmd),
    }
    set_layers(&mut c, clip.id, layers);
    Ok(json!({}))
}

pub fn add_layer(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let (clip, g) = generator_clip(&c, cmd)?;
    let mut layers = layers_of(&clip);
    let index = super::splice_index(cmd.get("index"), layers.len());
    let given = super::js_spread(opts(cmd, "layer"));
    let (id, layer) = match g {
        Generator::Graphic => {
            let id = match given.get("id").and_then(Json::as_str).filter(|id| !id.is_empty()) {
                Some(id) => id.to_owned(),
                None => free_id(&layers, "g"),
            };
            let mut o = given;
            o.insert("id".into(), json!(id));
            let o = Json::Object(o);
            let mut next = layers.clone();
            next.insert(index, o.clone());
            bad_graphic(&next)?;
            (id, crate::graphic::normalize(&o))
        }
        Generator::Text => {
            let id = free_id(&layers, "l");
            let mut o = given;
            o.insert("id".into(), json!(id));
            (id, crate::defaults::text_layer(&o))
        }
        _ => return no_layers(cmd),
    };
    layers.insert(index, layer);
    set_layers(&mut c, clip.id, layers);
    Ok(json!({ "id": id }))
}

/// `<prefix><n>` from n = the layer count + 1 up, the first no layer has.
fn free_id(layers: &[Json], prefix: &str) -> String {
    let mut n = layers.len() + 1;
    while layers.iter().any(|l| layer_id(l) == Some(format!("{prefix}{n}").as_str())) {
        n += 1;
    }
    format!("{prefix}{n}")
}

pub fn remove_layer(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let (clip, g) = generator_clip(&c, cmd)?;
    let i = layer_index(&clip, cmd.get("layerId"))?;
    let mut layers = layers_of(&clip);
    let id = layer_id(&layers[i]).unwrap_or_default().to_owned();
    match g {
        Generator::Graphic => {
            if layers.len() == 1 {
                return invalid("a graphic keeps one layer at least");
            }
            let child = layers
                .iter()
                .enumerate()
                .any(|(j, l)| j != i && l.get("parent").and_then(Json::as_str) == Some(id.as_str()));
            if child {
                return invalid(format!("layer {id} is the parent of other layers; remove or move them first"));
            }
        }
        Generator::Text => {}
        _ => return no_layers(cmd),
    }
    drop_layer_keys(&mut c, clip.id, &id);
    layers.remove(i);
    set_layers(&mut c, clip.id, layers);
    Ok(json!({}))
}
