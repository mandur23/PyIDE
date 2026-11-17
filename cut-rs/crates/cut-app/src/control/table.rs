//! The tool table: every tool's name, kind, title, description and argument schema, the server's instructions and
//! run_action's actions, as `Cut.control` has them. `table.json` is written from the JavaScript's own table
//! (`tools/scenarios/control.cjs`) by `tests/control_oracle.rs`, which fails while the two differ.

use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::{Value as Json, json};

use super::schema::Schema;

/// What a tool does to the project: the MCP annotations and the edit report follow from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Read,
    Edit,
    Play,
    Export,
}

/// One tool of the table.
#[derive(Debug, Deserialize)]
pub struct Tool {
    pub name: String,
    pub kind: Kind,
    pub title: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input: Schema,
}

/// One action run_action takes: what it does, what it needs (a key of [`NEEDS`]), whether it only changes the view.
#[derive(Debug, Deserialize)]
pub struct Action {
    pub id: String,
    pub what: String,
    pub needs: Option<String>,
    pub view: bool,
    pub panel: Option<String>,
}

/// A keyboard or Automation entry run_action does not run: not for AI (`no`), or covered by tools of its own.
#[derive(Debug, Deserialize)]
pub struct Entry {
    pub no: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
}

#[derive(Deserialize)]
struct File {
    instructions: String,
    tools: Vec<Tool>,
    actions: Vec<Action>,
    keys: std::collections::BTreeMap<String, Entry>,
    automation: std::collections::BTreeMap<String, Entry>,
}

fn file() -> &'static File {
    static FILE: OnceLock<File> = OnceLock::new();
    FILE.get_or_init(|| serde_json::from_str(include_str!("table.json")).expect("control/table.json"))
}

/// The tools in the JavaScript's order.
pub fn tools() -> &'static [Tool] {
    &file().tools
}

pub fn tool(name: &str) -> Option<&'static Tool> {
    tools().iter().find(|t| t.name == name)
}

/// `Cut.control.INSTRUCTIONS`: what the server tells a client at `initialize`.
pub fn instructions() -> &'static str {
    &file().instructions
}

/// run_action's actions (`K.actions`), in the JavaScript's order.
pub fn actions() -> &'static [Action] {
    &file().actions
}

/// What run_action says of an id it does not run (`KEYS[id] || AUTOMATION[id without auto.]`).
pub fn entry(id: &str) -> Option<&'static Entry> {
    let f = file();
    f.keys.get(id).or_else(|| f.automation.get(id.strip_prefix("auto.").unwrap_or(id)))
}

/// What an action needs, as list_actions and run_action's refusal say it (control-actions.js `NEEDS`).
pub const NEEDS: [(&str, &str); 11] = [
    ("selection", "selected clips (select_clips or clip_ids)"),
    ("two", "two selected clips or more"),
    ("clip", "a clip under the playhead (seek or time)"),
    ("video", "a video clip of a media file under the playhead"),
    ("in", "a sequence In point (markIn)"),
    ("out", "a sequence Out point (markOut)"),
    ("inOut", "a sequence In and Out (markIn, markOut or markClip)"),
    ("marker", "a sequence marker at the playhead"),
    ("markers", "sequence markers"),
    ("source", "a clip open in the Source monitor (matchFrame opens one)"),
    ("clipboard", "clips copied with copy or cut"),
];

pub fn needs(key: &str) -> &'static str {
    NEEDS.iter().find(|(k, _)| *k == key).map_or("", |(_, v)| v)
}

/// The tools as MCP's tools/list gives them (`definitions()`).
pub fn definitions() -> Vec<Json> {
    tools()
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": t.input.to_json(),
                "annotations": {
                    "title": t.title,
                    "readOnlyHint": t.kind == Kind::Read,
                    "destructiveHint": t.kind == Kind::Edit,
                    "openWorldHint": false,
                },
            })
        })
        .collect()
}
