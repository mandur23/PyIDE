//! What this PC can decode and encode (ignored; `cargo test -p cut-decode --test inventory -- --ignored --nocapture`):
//! Media Foundation's decoder and encoder transforms for every codec and audio format, and each GPU's DXVA profiles.

use cut_decode::{Codec, Format, PixelFormat, adapters, decoders, encoders, gpu_decodes};

#[test]
#[ignore]
fn print_what_this_pc_has() {
    for c in [Codec::H264, Codec::Hevc, Codec::Vp8, Codec::Vp9, Codec::Av1, Codec::Aac] {
        eprintln!("{c:?}: decoders {:?}; encoders {:?}", decoders(c), encoders(c));
    }
    for f in Format::ALL {
        let names = |l: Vec<cut_decode::Listed>| l.into_iter().map(|l| l.name).collect::<Vec<_>>();
        eprintln!("{f:?}: decoders {:?}; encoders {:?}", names(f.transforms(false)), names(f.transforms(true)));
    }
    for (i, name) in adapters().iter().enumerate() {
        let mut dxva = Vec::new();
        for c in [Codec::H264, Codec::Hevc, Codec::Vp8, Codec::Vp9, Codec::Av1] {
            for f in [PixelFormat::Nv12, PixelFormat::P010] {
                if gpu_decodes(Some(i as u32), c, f) {
                    dxva.push(format!("{c:?} {f:?}"));
                }
            }
        }
        eprintln!("adapter {i} {name}: DXVA {}", dxva.join(", "));
    }
}
