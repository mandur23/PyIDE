//! Which way Cut's AI requests go, as Nano Studio started this program (`main/ai/connection.js`'s `forCut`): Claude
//! Code on this PC (the default), or the API chosen in Nano Studio's Settings › AI › Connection. With an API that is
//! set up, `CUT_CLAUDE_PATH` is `nano-studio-api.cmd` (`main/ai/api-cli.js`), which answers as the CLI does, so the
//! requests themselves are unchanged ([`super::claude`], [`super::agent`]); with one that is not, it is `none`.
//! `CUT_AI_PROVIDER` says which, and this module gives the notices and errors their words for it.

use std::borrow::Cow;
use std::sync::OnceLock;

use crate::i18n::{Lang, lang};

/// The way the requests go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    ClaudeCode,
    Anthropic,
    OpenAi,
}

impl Via {
    /// `CUT_AI_PROVIDER`'s value: `anthropic`, `openai`, anything else (unset) Claude Code.
    pub fn of(value: Option<&str>) -> Via {
        match value {
            Some("anthropic") => Via::Anthropic,
            Some("openai") => Via::OpenAi,
            _ => Via::ClaudeCode,
        }
    }

    pub fn api(self) -> bool {
        self != Via::ClaudeCode
    }

    /// The API's name in a sentence.
    pub fn name(self) -> Cow<'static, str> {
        text(match self {
            Via::OpenAi => "the OpenAI-compatible API",
            _ => "the Anthropic API",
        })
    }
}

/// The way this program was started with (read once).
pub fn via() -> Via {
    static VIA: OnceLock<Via> = OnceLock::new();
    *VIA.get_or_init(|| Via::of(std::env::var("CUT_AI_PROVIDER").ok().as_deref()))
}

/// The Korean of these texts; Nano Studio's dictionaries have none of them.
pub const KO: [(&str, &str); 16] = [
    ("the Anthropic API", "Anthropic API"),
    ("the OpenAI-compatible API", "OpenAI 호환 API"),
    ("API", "API"),
    (
        "These features send text to {name}, with the key set in Nano Studio (Settings › AI › Connection): the transcript or the caption text, and clip, track and marker names with their times.",
        "이 기능들은 Nano Studio에 넣은 키로 {name}에 글을 보냅니다(설정 › AI › 연결): 대본이나 자막 글, 클립·트랙·마커 이름과 그 시간입니다.",
    ),
    (
        "No video, sound or file paths are sent. Usage is billed to that API account.",
        "영상, 소리, 파일 경로는 보내지 않습니다. 사용량은 그 API 계정에 청구됩니다.",
    ),
    ("The API refused the key.", "API가 키를 받지 않았습니다."),
    (
        "Check the key in Nano Studio, Settings › AI › Connection (in Code or Craft), then open Cut again.",
        "Nano Studio의 설정 › AI › 연결(Code나 Craft)에서 키를 확인한 뒤 Cut을 다시 여세요.",
    ),
    ("The API's rate or spending limit was reached.", "API의 사용 한도나 요금 한도에 닿았습니다."),
    ("Try again later, or check the limits of the API account.", "나중에 다시 하거나 API 계정의 한도를 확인하세요."),
    ("The API chosen in Nano Studio is not set up yet.", "Nano Studio에서 고른 API가 아직 설정되지 않았습니다."),
    (
        "Set its key (and for an OpenAI-compatible API its address and model) in Settings › AI › Connection in Code or Craft, then open Cut again.",
        "Code나 Craft의 설정 › AI › 연결에서 키(OpenAI 호환 API는 주소와 모델도)를 넣은 뒤 Cut을 다시 여세요.",
    ),
    ("The API request failed: {error}", "API 요청이 실패했습니다: {error}"),
    (
        "Requests go to {name} chosen in Nano Studio (Settings › AI › Connection).",
        "요청은 Nano Studio에서 고른 {name}(으)로 갑니다(설정 › AI › 연결).",
    ),
    (
        "An OpenAI-compatible API always uses the model set in Nano Studio; the model here does not apply.",
        "OpenAI 호환 API는 늘 Nano Studio에 정한 모델을 씁니다. 여기의 모델은 쓰이지 않습니다.",
    ),
    (
        "The AI assistant sends your request and a description of the project (clip, track and marker names and times, captions) to {name} chosen in Nano Studio, and lets the model edit the project with Cut's tools.",
        "AI 어시스턴트는 요청과 프로젝트 설명(클립·트랙·마커 이름과 시간, 자막)을 Nano Studio에서 고른 {name}(으)로 보내고, 모델이 Cut의 도구로 프로젝트를 고치게 합니다.",
    ),
    (
        "When the model asks to see a frame, a picture of the program monitor is sent too. Files and file paths are not sent, and the model cannot change files on this PC.",
        "모델이 프레임을 보자고 하면 프로그램 모니터의 그림도 보냅니다. 파일과 파일 경로는 보내지 않고, 모델은 이 PC의 파일을 바꿀 수 없습니다.",
    ),
];

/// `text` in the screen's language.
pub fn text(en: &'static str) -> Cow<'static, str> {
    if lang() == Lang::Ko
        && let Some((_, ko)) = KO.iter().find(|(k, _)| *k == en)
    {
        return Cow::Borrowed(ko);
    }
    Cow::Borrowed(en)
}

/// `text` with its `{key}`s filled in.
pub fn textf(en: &'static str, args: &[(&str, &str)]) -> String {
    let mut out = text(en).into_owned();
    for (k, v) in args {
        out = out.replace(&format!("{{{k}}}"), v);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_provider_is_read_from_its_value() {
        assert_eq!(Via::of(Some("anthropic")), Via::Anthropic);
        assert_eq!(Via::of(Some("openai")), Via::OpenAi);
        assert_eq!(Via::of(Some("claude-code")), Via::ClaudeCode);
        assert_eq!(Via::of(None), Via::ClaudeCode);
        assert!(!Via::ClaudeCode.api() && Via::OpenAi.api());
    }

    #[test]
    fn every_text_has_its_korean_and_keeps_its_placeholders() {
        for (en, ko) in KO {
            for key in ["{name}", "{error}"] {
                assert_eq!(en.contains(key), ko.contains(key), "{en}");
            }
        }
        crate::i18n::set_lang(Lang::Ko);
        assert_eq!(textf("The API request failed: {error}", &[("error", "x")]), "API 요청이 실패했습니다: x");
        crate::i18n::set_lang(Lang::En);
        assert_eq!(text("The API refused the key."), "The API refused the key.");
    }
}
