//! The screen's texts in English or Korean, as the JavaScript editor's `tr()`: an English sentence is the key, and the
//! Korean comes from the editor's own dictionaries (`renderer/locales/ko.json`, then the Cut plugin's
//! `renderer/features/cut/locales/ko.json` on top), embedded at build time so no translation is retyped here.

use std::borrow::Cow;
use std::cell::Cell;
use std::collections::HashMap;
use std::sync::OnceLock;

const CORE_KO: &str = include_str!("../../../../renderer/locales/ko.json");
const CUT_KO: &str = include_str!("../../../../renderer/features/cut/locales/ko.json");

/// Texts only the native app shows (the JavaScript editor has no such sentence to reuse).
const NATIVE_KO: [(&str, &str); 18] = [
    ("Find Action", "동작 찾기"),
    ("No action matches.", "일치하는 동작이 없습니다."),
    ("{n} clips", "클립 {n}개"),
    ("{n} selected", "{n}개 선택"),
    ("Not available yet", "아직 없는 기능입니다"),
    ("Folder", "폴더"),
    (
        "This PC has no VP8/VP9 decoder. Install the VP9 Video Extensions from the Microsoft Store.",
        "이 PC에는 VP8/VP9 디코더가 없습니다. Microsoft Store에서 VP9 동영상 확장을 설치하세요.",
    ),
    (
        "This PC has no AV1 decoder. Install the AV1 Video Extension from the Microsoft Store.",
        "이 PC에는 AV1 디코더가 없습니다. Microsoft Store에서 AV1 Video Extension을 설치하세요.",
    ),
    (
        "This PC has no HEVC decoder. Install the HEVC Video Extensions from the Microsoft Store.",
        "이 PC에는 HEVC 디코더가 없습니다. Microsoft Store에서 HEVC 동영상 확장을 설치하세요.",
    ),
    ("This PC has no H.264 decoder.", "이 PC에는 H.264 디코더가 없습니다."),
    ("This PC has no AAC decoder.", "이 PC에는 AAC 디코더가 없습니다."),
    ("This PC has no MP3 decoder.", "이 PC에는 MP3 디코더가 없습니다."),
    ("This PC has no FLAC decoder.", "이 PC에는 FLAC 디코더가 없습니다."),
    ("This PC has no Opus decoder.", "이 PC에는 Opus 디코더가 없습니다."),
    ("Vorbis audio is not supported yet.", "Vorbis 오디오는 아직 지원하지 않습니다."),
    ("ALAC audio is not supported yet.", "ALAC 오디오는 아직 지원하지 않습니다."),
    ("This audio codec is not supported.", "지원하지 않는 오디오 코덱입니다."),
    (
        "Opus audio with more than two channels is not supported yet.",
        "2채널을 넘는 Opus 오디오는 아직 지원하지 않습니다.",
    ),
];

/// The panels' windows: words agreed with the JavaScript apps' same feature, so they win over the core dictionary's
/// "Open in New Window" (an editor tab's "새 창에서 열기").
const WINDOWS_KO: [(&str, &str); 4] = [
    ("Open in New Window", "새 창으로 열기"),
    ("Return to Main Window", "기본 창으로 되돌리기"),
    ("Return All Panels to Main Window", "모든 패널을 기본 창으로 되돌리기"),
    ("{panel} is in its own window.", "{panel} 패널은 별도 창에 있습니다."),
];

/// A language of the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    Ko,
}

impl Lang {
    /// The settings value (`"en"`, `"ko"`).
    pub fn code(self) -> &'static str {
        match self {
            Lang::En => "en",
            Lang::Ko => "ko",
        }
    }

    pub fn from_code(code: &str) -> Option<Lang> {
        match code {
            "en" => Some(Lang::En),
            "ko" => Some(Lang::Ko),
            _ => None,
        }
    }
}

// The language belongs to the thread that draws the screen: the app draws on one thread, and each test that builds
// a shell draws on its own, so parallel tests never switch each other's texts.
thread_local! {
    static LANG: Cell<Lang> = const { Cell::new(Lang::En) };
}

/// Switches every later `tr` on this thread to `lang`.
pub fn set_lang(lang: Lang) {
    LANG.with(|l| l.set(lang));
}

pub fn lang() -> Lang {
    LANG.with(Cell::get)
}

fn korean() -> &'static HashMap<String, String> {
    static KO: OnceLock<HashMap<String, String>> = OnceLock::new();
    KO.get_or_init(|| {
        let mut map: HashMap<String, String> = serde_json::from_str(CORE_KO).unwrap_or_default();
        map.extend(serde_json::from_str::<HashMap<String, String>>(CUT_KO).unwrap_or_default());
        for (k, v) in NATIVE_KO {
            map.entry(k.to_owned()).or_insert_with(|| v.to_owned());
        }
        for (k, v) in crate::timeline::direct::KO {
            map.entry(k.to_owned()).or_insert_with(|| v.to_owned());
        }
        for (k, v) in WINDOWS_KO {
            map.insert(k.to_owned(), v.to_owned());
        }
        map
    })
}

/// The text of `key` in the current language (the key itself when there is no translation).
pub fn tr(key: &str) -> Cow<'static, str> {
    match lang() {
        Lang::Ko => match korean().get(key) {
            Some(v) => Cow::Borrowed(v.as_str()),
            None => Cow::Owned(key.to_owned()),
        },
        Lang::En => Cow::Owned(key.to_owned()),
    }
}

/// `tr` with `{name}` placeholders filled, as `tr('Sequence {n}', {n: 1})`.
pub fn trf(key: &str, params: &[(&str, &str)]) -> String {
    let mut s = tr(key).into_owned();
    for (k, v) in params {
        s = s.replace(&format!("{{{k}}}"), v);
    }
    s
}

/// The text of `key` in `lang`, whatever the screen's language is (tests).
pub fn text_in(lang: Lang, key: &str) -> String {
    match lang {
        Lang::Ko => korean().get(key).cloned().unwrap_or_else(|| key.to_owned()),
        Lang::En => key.to_owned(),
    }
}

/// Whether the dictionary has `key` (tests: every text the screen shows in Korean is translated).
pub fn has_korean(key: &str) -> bool {
    korean().contains_key(key)
}
