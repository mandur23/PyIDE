//! The pretend download of the tests (`fakeSetupRun` of `whisper.js`, `voice.js`, `speakers.js`): with
//! `PYIDE_*_BACKEND=fake` and `PYIDE_*_FAKE_SETUP=ok|offline|disk|noPython` the model and the environment start
//! missing, and a setup reports a runtime step (when the environment is missing), then ten steps of the model, and
//! succeeds, or fails with that code at the fourth.

use std::time::Duration;

use crate::{Job, Phase, Progress, SetupCode, SetupFailure};

/// How one feature pretends.
#[derive(Debug, Clone, Copy)]
pub struct Pretend<'a> {
    /// The `PYIDE_*_FAKE_SETUP` word.
    pub outcome: &'a str,
    /// Whether the environment is there already (no runtime step).
    pub runtime_ready: bool,
    /// The runtime step's log line (`Collecting transformers`).
    pub runtime_text: &'a str,
    /// The model's size, reported with each step.
    pub bytes: f64,
    /// The pause after the runtime step and after each model step.
    pub runtime_pause: Duration,
    pub step_pause: Duration,
}

/// Runs the pretend setup; a [`Job::cancel`] stops it between steps (`cancelled`).
pub fn setup(p: Pretend<'_>, job: &Job, progress: &dyn Fn(Progress)) -> Result<(), SetupFailure> {
    let fail = |code: SetupCode, error: String| SetupFailure { code, error, log: String::new() };
    if !p.runtime_ready {
        progress(Progress {
            phase: Phase::Runtime,
            fraction: None,
            text: Some(p.runtime_text.to_owned()),
            bytes: None,
        });
        std::thread::sleep(p.runtime_pause);
    }
    for i in 1..=10 {
        if job.is_cancelled() {
            return Err(fail(SetupCode::Cancelled, "Cancelled".into()));
        }
        if p.outcome != "ok" && i == 4 {
            return Err(fail(SetupCode::parse(p.outcome), format!("pretend failure: {}", p.outcome)));
        }
        progress(Progress {
            phase: Phase::Download,
            fraction: Some(f64::from(i) / 10.0),
            text: None,
            bytes: Some(p.bytes),
        });
        std::thread::sleep(p.step_pause);
    }
    progress(Progress { phase: Phase::Done, fraction: Some(1.0), text: None, bytes: None });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn run(outcome: &str, runtime_ready: bool) -> (Result<(), SetupFailure>, Vec<Progress>) {
        let seen = Mutex::new(Vec::new());
        let p = Pretend {
            outcome,
            runtime_ready,
            runtime_text: "Collecting transformers",
            bytes: 970e6,
            runtime_pause: Duration::ZERO,
            step_pause: Duration::ZERO,
        };
        let r = setup(p, &Job::new(|_| {}), &|x| seen.lock().unwrap().push(x));
        (r, seen.into_inner().unwrap())
    }

    #[test]
    fn ten_steps_or_a_failure_at_the_fourth() {
        let (r, seen) = run("ok", false);
        assert!(r.is_ok());
        assert_eq!(seen.len(), 12);
        assert_eq!((seen[0].phase, seen[0].text.as_deref()), (Phase::Runtime, Some("Collecting transformers")));
        assert_eq!(seen[10].fraction, Some(1.0));
        assert_eq!(seen[11].phase, Phase::Done);
        for code in ["offline", "disk", "noPython"] {
            let (r, seen) = run(code, true);
            let e = r.unwrap_err();
            assert_eq!((e.code.as_str(), e.error.as_str()), (code, format!("pretend failure: {code}").as_str()));
            assert_eq!(seen.len(), 3, "three model steps before it fails");
        }
    }
}
