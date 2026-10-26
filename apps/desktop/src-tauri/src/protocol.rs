//! Shell ↔ server protocol (docs/DESKTOP.md, "Shell ↔ server protocol").
//!
//! Server → shell: stdout lines starting with `@@swarmcast ` followed by one JSON object;
//! every other line is an ordinary log line. Shell → server: one JSON object per stdin line.

use serde::{Deserialize, Serialize};

pub const PREFIX: &str = "@@swarmcast ";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    #[default]
    Off,
    Starting,
    WaitingObs,
    Live,
    Stopping,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IconState {
    #[default]
    Off,
    Waiting,
    Live,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveState {
    #[serde(default)]
    pub state: IconState,
    #[serde(default)]
    pub tooltip: String,
    #[serde(default)]
    pub can_start: bool,
    #[serde(default)]
    pub can_stop: bool,
    #[serde(default)]
    pub phase: Phase,
    #[serde(default)]
    pub viewers: u64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ServerMessage {
    #[serde(rename_all = "camelCase")]
    Ready {
        admin_url: String,
        #[serde(default)]
        version: String,
    },
    State(LiveState),
    Fatal {
        #[serde(default)]
        code: String,
        #[serde(default)]
        message: String,
    },
    UpdateCheck,
    UpdateInstall,
}

/// What one stdout line of the server is.
#[derive(Debug, PartialEq)]
pub enum Line {
    /// An ordinary log line, copied to desktop.log.
    Log,
    Message(ServerMessage),
    /// Prefixed but not understood (newer server, broken JSON): logged and ignored.
    Invalid(String),
}

pub fn parse_line(line: &str) -> Line {
    let Some(json) = line.strip_prefix(PREFIX) else {
        return Line::Log;
    };
    match serde_json::from_str::<ServerMessage>(json.trim()) {
        Ok(msg) => Line::Message(msg),
        Err(err) => Line::Invalid(err.to_string()),
    }
}

/// Tray clicks forwarded to the server. (The contract also has `quit`; the shell sends the
/// `quit` message instead, because it must wait for the exit and then close itself.)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClickId {
    Start,
    Stop,
}

/// `installing` is part of the contract, but the shell stops the server before it installs,
/// so in practice the panel never receives it.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateStatus {
    #[default]
    None,
    Available,
    Downloading,
    Installing,
    Error,
}

/// The `update` message: what the panel shows in its update banner.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct UpdateInfo {
    pub status: UpdateStatus,
    pub current: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ShellMessage {
    Click { id: ClickId },
    Quit,
    Update(UpdateInfo),
}

/// One stdin line for the server (JSON + `\n`).
pub fn encode(msg: &ShellMessage) -> String {
    let mut s = serde_json::to_string(msg).expect("shell messages always serialize");
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_lines_are_logs() {
        assert_eq!(parse_line("{\"level\":30,\"msg\":\"hello\"}"), Line::Log);
        assert_eq!(parse_line("@@swarmcas {}"), Line::Log);
        assert_eq!(parse_line(""), Line::Log);
    }

    #[test]
    fn parses_ready() {
        let line = r#"@@swarmcast {"type":"ready","adminUrl":"http://127.0.0.1:8081/auth/abc","version":"0.2.0"}"#;
        assert_eq!(
            parse_line(line),
            Line::Message(ServerMessage::Ready { admin_url: "http://127.0.0.1:8081/auth/abc".into(), version: "0.2.0".into() })
        );
    }

    #[test]
    fn parses_state_with_defaults_and_unknown_fields() {
        let line = r#"@@swarmcast {"type":"state","state":"live","tooltip":"x","canStart":false,"canStop":true,"phase":"waiting-obs","viewers":4,"extra":1}"#;
        let Line::Message(ServerMessage::State(s)) = parse_line(line) else { panic!("not a state") };
        assert_eq!(s.state, IconState::Live);
        assert_eq!(s.phase, Phase::WaitingObs);
        assert_eq!(s.viewers, 4);
        assert!(s.can_stop && !s.can_start);
        let Line::Message(ServerMessage::State(s)) = parse_line(r#"@@swarmcast {"type":"state"}"#) else { panic!() };
        assert_eq!(s, LiveState::default());
    }

    #[test]
    fn parses_fatal_and_update_requests() {
        assert_eq!(
            parse_line(r#"@@swarmcast {"type":"fatal","code":"ports-in-use","message":"busy"}"#),
            Line::Message(ServerMessage::Fatal { code: "ports-in-use".into(), message: "busy".into() })
        );
        assert_eq!(parse_line(r#"@@swarmcast {"type":"update-check"}"#), Line::Message(ServerMessage::UpdateCheck));
        assert_eq!(parse_line("@@swarmcast {\"type\":\"update-install\"}\r"), Line::Message(ServerMessage::UpdateInstall));
    }

    #[test]
    fn rejects_unknown_or_broken_messages() {
        assert!(matches!(parse_line(r#"@@swarmcast {"type":"nope"}"#), Line::Invalid(_)));
        assert!(matches!(parse_line("@@swarmcast {"), Line::Invalid(_)));
        assert!(matches!(parse_line(r#"@@swarmcast {"type":"ready"}"#), Line::Invalid(_)));
    }

    #[test]
    fn encodes_shell_messages() {
        assert_eq!(encode(&ShellMessage::Quit), "{\"type\":\"quit\"}\n");
        assert_eq!(encode(&ShellMessage::Click { id: ClickId::Start }), "{\"type\":\"click\",\"id\":\"start\"}\n");
        let update = ShellMessage::Update(UpdateInfo {
            status: UpdateStatus::Downloading,
            current: "0.2.0".into(),
            version: Some("0.3.0".into()),
            progress: Some(0.5),
            ..Default::default()
        });
        assert_eq!(
            encode(&update),
            "{\"type\":\"update\",\"status\":\"downloading\",\"current\":\"0.2.0\",\"version\":\"0.3.0\",\"progress\":0.5}\n"
        );
    }
}
