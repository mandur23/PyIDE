//! The pipelines made ahead ([`Engine::warm_pipelines`]): a render after them never waits for the shader compiler,
//! which on Direct3D 12 took up to 150 ms for one effect and dropped frames the first time it played.

mod common;

use std::time::Duration;

use common::*;
use cut_engine::{Engine, RenderOptions};
use cut_model::{Id, Project};
use serde_json::json;

const WAIT: RenderOptions = RenderOptions {
    quality: 1.0,
    captions: cut_engine::Captions::None,
    wait: Some(Duration::from_secs(20)),
    proxy: false,
};

/// A colour effect and a mask on one clip, a dissolve into the next.
fn busy_project() -> Project {
    let mut p = project(64, 36);
    let mut a = clip("c1", "V1", 0, 0.0, SEC as f64, solid("#ff0000"));
    a.effects.push(effect("e1", "color.basic", json!({ "contrast": 20, "saturation": 140 })));
    let path = cut_model::masks::ellipse(64.0, 36.0, cut_model::masks::Place { cx: 0.5, cy: 0.5, size: Some(50.0) });
    a.masks = Some(vec![
        serde_json::from_value(json!({ "id": "m1", "mode": "add", "inverted": false, "path": path, "feather": 0, "opacity": 100, "expansion": 0 }))
            .expect("a mask"),
    ]);
    put(&mut p, "s1", a);
    put(&mut p, "s1", clip("c2", "V1", SEC, 0.0, SEC as f64, solid("#0000ff")));
    p.sequence_mut(Id::new("s1")).expect("s1").transitions.push(
        serde_json::from_value(
            json!({ "id": "t1", "track": "V1", "at": SEC, "type": "dissolve", "duration": 10 * F, "align": "center", "params": {} }),
        )
        .expect("a transition"),
    );
    reload(&p).0
}

fn render_all(e: &mut Engine, p: &Project) {
    for t in [0, SEC - 2 * F, SEC + 2 * F] {
        assert!(e.render(p, Id::new("s1"), t, (64, 36), &WAIT).expect("a render").complete);
    }
}

#[test]
fn a_render_after_the_warm_up_compiles_no_pipeline() {
    let p = busy_project();
    let mut cold = Engine::headless().expect("a GPU");
    render_all(&mut cold, &p);
    assert!(cold.pipelines_compiled() >= 5, "without the warm-up the renders compile: {}", cold.pipelines_compiled());

    let mut warm = Engine::headless().expect("a GPU");
    warm.warm_pipelines().join().expect("the warm-up thread");
    render_all(&mut warm, &p);
    assert_eq!(warm.pipelines_compiled(), 0, "every pipeline the renders drew with was made ahead");
    assert_eq!(warm.read_pixels(), cold.read_pixels(), "the same picture either way");
}
