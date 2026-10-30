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

/// Update channel (docs/DESKTOP.md, "Updates"): `stable` reads the stable feed only, `beta`
/// also reads the beta feed and takes the higher version.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Beta,
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
    /// The streamer's update channel (panel "Get beta versions"), at `ready` and on every
    /// change; `null` = automatic (beta when this version is a pre-release).
    UpdateChannel {
        #[serde(default)]
        channel: Option<Channel>,
    },
    /// Answer to `export-logs`: the ZIP's path, or why it failed.
    ExportLogs {
        #[serde(default)]
        ok: bool,
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        error: Option<String>,
    },
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
    Click {
        id: ClickId,
    },
    Quit,
    Update(UpdateInfo),
    /// Tray "Export logs…": the server writes the anonymised ZIP and answers with its path.
    #[serde(rename = "export-logs")]
    ExportLogs,
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

    /// Server log lines (pino JSON), a prefix with a typo and an empty line are copied to the log.
    #[test]
    fn ordinary_lines_are_logs() {
        // Arrange
        let lines = ["{\"level\":30,\"msg\":\"hello\"}", "@@swarmcas {}", ""];

        // Act
        let parsed = lines.map(parse_line);

        // Assert
        assert_eq!(parsed, [Line::Log, Line::Log, Line::Log]);
    }

    #[test]
    fn parses_ready() {
        // Arrange
        let line = r#"@@swarmcast {"type":"ready","adminUrl":"http://127.0.0.1:8081/auth/abc","version":"0.2.0"}"#;

        // Act
        let parsed = parse_line(line);

        // Assert
        assert_eq!(
            parsed,
            Line::Message(ServerMessage::Ready { admin_url: "http://127.0.0.1:8081/auth/abc".into(), version: "0.2.0".into() })
        );
    }

    /// A newer server may add fields: they are ignored, not an invalid message.
    #[test]
    fn parses_a_state_and_ignores_unknown_fields() {
        // Arrange
        let line = r#"@@swarmcast {"type":"state","state":"live","tooltip":"x","canStart":false,"canStop":true,"phase":"waiting-obs","viewers":4,"extra":1}"#;

        // Act
        let parsed = parse_line(line);

        // Assert
        let Line::Message(ServerMessage::State(s)) = &parsed else { panic!("not a state: {parsed:?}") };
        assert_eq!(s.state, IconState::Live);
        assert_eq!(s.phase, Phase::WaitingObs);
        assert_eq!(s.viewers, 4);
        assert!(s.can_stop && !s.can_start);
    }

    #[test]
    fn a_bare_state_gets_the_defaults() {
        // Act
        let parsed = parse_line(r#"@@swarmcast {"type":"state"}"#);

        // Assert
        assert_eq!(parsed, Line::Message(ServerMessage::State(LiveState::default())));
    }

    #[test]
    fn parses_fatal() {
        // Act
        let parsed = parse_line(r#"@@swarmcast {"type":"fatal","code":"ports-in-use","message":"busy"}"#);

        // Assert
        assert_eq!(parsed, Line::Message(ServerMessage::Fatal { code: "ports-in-use".into(), message: "busy".into() }));
    }

    /// The `\r` is a CRLF line end (a Windows server's stdout): the message still parses.
    #[test]
    fn parses_update_requests_with_or_without_a_crlf() {
        // Act
        let check = parse_line(r#"@@swarmcast {"type":"update-check"}"#);
        let install = parse_line("@@swarmcast {\"type\":\"update-install\"}\r");

        // Assert
        assert_eq!(check, Line::Message(ServerMessage::UpdateCheck));
        assert_eq!(install, Line::Message(ServerMessage::UpdateInstall));
    }

    /// `null` or no channel is "automatic"; a channel this shell does not know is invalid.
    #[test]
    fn parses_update_channel() {
        // Arrange
        let channel = |line: &str| match parse_line(line) {
            Line::Message(ServerMessage::UpdateChannel { channel }) => Some(channel),
            _ => None,
        };

        // Act
        let beta = channel(r#"@@swarmcast {"type":"update-channel","channel":"beta"}"#);
        let stable = channel(r#"@@swarmcast {"type":"update-channel","channel":"stable"}"#);
        let null = channel(r#"@@swarmcast {"type":"update-channel","channel":null}"#);
        let missing = channel(r#"@@swarmcast {"type":"update-channel"}"#);
        let unknown = parse_line(r#"@@swarmcast {"type":"update-channel","channel":"nightly"}"#);

        // Assert
        assert_eq!([beta, stable, null, missing], [Some(Some(Channel::Beta)), Some(Some(Channel::Stable)), Some(None), Some(None)]);
        assert!(matches!(unknown, Line::Invalid(_)), "{unknown:?}");
    }

    #[test]
    fn export_logs_round_trip() {
        // Act
        let request = encode(&ShellMessage::ExportLogs);
        let done = parse_line(r#"@@swarmcast {"type":"export-logs","ok":true,"path":"/home/a/Downloads/SwarmCast-logs.zip"}"#);
        let failed = parse_line(r#"@@swarmcast {"type":"export-logs","ok":false,"error":"disk full"}"#);

        // Assert
        assert_eq!(request, "{\"type\":\"export-logs\"}\n");
        assert_eq!(
            done,
            Line::Message(ServerMessage::ExportLogs { ok: true, path: Some("/home/a/Downloads/SwarmCast-logs.zip".into()), error: None })
        );
        assert_eq!(failed, Line::Message(ServerMessage::ExportLogs { ok: false, path: None, error: Some("disk full".into()) }));
    }

    /// An unknown type, broken JSON, and a `ready` without its required adminUrl.
    #[test]
    fn rejects_unknown_or_broken_messages() {
        // Arrange
        let lines = [r#"@@swarmcast {"type":"nope"}"#, "@@swarmcast {", r#"@@swarmcast {"type":"ready"}"#];

        // Act
        let parsed = lines.map(parse_line);

        // Assert
        assert!(parsed.iter().all(|p| matches!(p, Line::Invalid(_))), "{parsed:?}");
    }

    /// One JSON object per stdin line; optional update fields are left out, not sent as null.
    #[test]
    fn encodes_shell_messages() {
        // Arrange
        let downloading = ShellMessage::Update(UpdateInfo {
            status: UpdateStatus::Downloading,
            current: "0.2.0".into(),
            version: Some("0.3.0".into()),
            progress: Some(0.5),
            ..Default::default()
        });

        // Act
        let quit = encode(&ShellMessage::Quit);
        let click = encode(&ShellMessage::Click { id: ClickId::Start });
        let update = encode(&downloading);

        // Assert
        assert_eq!(quit, "{\"type\":\"quit\"}\n");
        assert_eq!(click, "{\"type\":\"click\",\"id\":\"start\"}\n");
        assert_eq!(
            update,
            "{\"type\":\"update\",\"status\":\"downloading\",\"current\":\"0.2.0\",\"version\":\"0.3.0\",\"progress\":0.5}\n"
        );
    }
}
