//! WebSockets and streams relayed to the machine, with a media ticket the proxy issues itself in
//! the URL (an image or a WebSocket cannot send a header) or its bearer token.
//!
//! Device and browser-preview streams are live pictures of what runs on the machine, so they
//! exist only while it runs. T3 Code keeps retrying one while it is on screen, so they never wake
//! the machine: a sleeping one answers 503. So does any socket T3 adds, until it is known.
//! Dictation is opened by a person and wakes it.

use super::auth::TicketUse;
use super::{
    answer_head, client_authorized, query_param, query_without, relay, unauthorized, upstream, upstream_bearer, wake,
    Relay, M,
};
use crate::machine::{MachineRuntime, Power};
use axum::body::Body;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{CloseFrame as DownClose, Message as DownMsg, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio_tungstenite::tungstenite::http::Response as UpResponse;
use tokio_tungstenite::tungstenite::protocol::CloseFrame as UpClose;
use tokio_tungstenite::tungstenite::{Error as UpError, Message as UpMsg};

/// T3 Code acknowledges every preview frame with this: the one message a stream sends with
/// nobody touching it.
const FRAME_ACK: &str = r#"{"type":"ack"}"#;

/// T3's mark on a tunnel refusal: the machine was reached and nothing listens on the port.
const TUNNEL_PORT_REFUSED: HeaderName = HeaderName::from_static("x-t3-tunnel-port-refused");

/// What a socket gets while the machine does not run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Asleep {
    /// Opened by a person: the machine wakes for it.
    Wakes,
    /// 503, until the machine runs.
    Unavailable,
    /// The loopback tunnel: nothing listens on a sleeping machine, so it is refused as T3 refuses
    /// a port nothing listens on.
    PortRefused,
}

/// `/api/device-hub/*` and `/api/preview-stream/*`: plain requests (snapshots, MJPEG and
/// event streams, uploads) and WebSockets alike.
pub async fn stream(
    State(m): M,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    if let Ok(upgrade) = upgrade {
        return socket(m, upgrade, &parts, Asleep::Unavailable).await;
    }
    let Some(target) = authorized_target(&m, &parts) else {
        return unauthorized();
    };
    // Anything but a read is someone working the device or the browser.
    if parts.method != Method::GET && parts.method != Method::HEAD {
        m.user_action();
    }
    let route = Relay { target, authorization: upstream_bearer(&m), wake: false };
    relay(&m, parts, body, route).await
}

/// `/ws/voice`: dictation, opened by a person with a mic click.
pub async fn voice(State(m): M, upgrade: WebSocketUpgrade, req: Request) -> Response {
    socket(m, upgrade, &req.into_parts().0, Asleep::Wakes).await
}

/// `/api/preview/tunnel`: a TCP connection to a loopback port on the machine, for preview pages.
/// T3 Code's desktop app also opens one on its own with every connection, retrying until it
/// learns whether the machine shares this computer's loopback, so it never wakes the machine.
pub async fn tunnel(State(m): M, upgrade: WebSocketUpgrade, req: Request) -> Response {
    socket(m, upgrade, &req.into_parts().0, Asleep::PortRefused).await
}

/// Relays a WebSocket to the same path on the machine.
pub(super) async fn socket(m: Arc<MachineRuntime>, upgrade: WebSocketUpgrade, parts: &Parts, asleep: Asleep) -> Response {
    let Some(target) = authorized_target(&m, parts) else {
        return unauthorized();
    };
    if m.power() != Power::Running {
        if asleep == Asleep::PortRefused {
            return port_refused();
        }
        if let Err(res) = wake(&m, asleep == Asleep::Wakes, &target).await {
            return res;
        }
    }
    let tunnel = asleep == Asleep::PortRefused;
    match upstream::connect(&m.upstream_url(), &m.upstream_token(), &target).await {
        Ok(up) => upgrade.on_upgrade(move |down| pump(m, down, up, tunnel)),
        Err(e) => match e.downcast_ref() {
            Some(UpError::Http(res)) => machine_refusal(res),
            _ => (StatusCode::BAD_GATEWAY, format!("{e:#}")).into_response(),
        },
    }
}

fn port_refused() -> Response {
    (StatusCode::FORBIDDEN, [(TUNNEL_PORT_REFUSED, HeaderValue::from_static("1"))], "The machine is asleep.")
        .into_response()
}

/// The machine's own refusal (no device hub, a tunnel port nothing listens on) reaches T3 Code as
/// it was, headers included: they say what it means.
fn machine_refusal(res: &UpResponse<Option<Vec<u8>>>) -> Response {
    let mut answer = answer_head(res.status(), res.headers())
        .body(Body::empty())
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
    // Its body, maybe read only in part, is not passed on.
    answer.headers_mut().remove(header::CONTENT_LENGTH);
    answer
}

/// Path and query on the machine, minus the proxy's ticket; `None` if the caller holds neither a
/// media ticket nor a token of this proxy.
fn authorized_target(m: &MachineRuntime, parts: &Parts) -> Option<String> {
    let query = parts.uri.query().unwrap_or_default();
    let ticketed = query_param(query, "wsTicket").is_some_and(|t| m.auth.check_ticket(&t, TicketUse::Media));
    (ticketed || client_authorized(m, &parts.headers))
        .then(|| format!("{}?{}", parts.uri.path(), query_without(query, &["wsTicket"])))
}

/// Passes frames both ways until either side ends, close code and reason included: T3 Code
/// reads them to tell a closed tab from a stream to reopen. `tunnel`: the preview tunnel, whose
/// page may run on with nobody there: its data either way counts only while someone is around.
async fn pump(m: Arc<MachineRuntime>, down: WebSocket, up: upstream::Upstream, tunnel: bool) {
    let (mut to_client, mut from_client) = down.split();
    let (mut to_machine, mut from_machine) = up.split();
    let upward = async {
        let mut ping = tokio::time::interval(upstream::PING);
        loop {
            let msg = tokio::select! {
                msg = from_client.next() => {
                    let Some(Ok(msg)) = msg else { break };
                    // A click or a key in the stream is someone using the machine. Watching is
                    // not: an open preview must not keep it from sleeping.
                    if is_input(&msg) {
                        if tunnel {
                            m.tunnel_input();
                        } else {
                            m.user_action();
                        }
                    }
                    machine_message(msg)
                }
                _ = ping.tick() => Some(UpMsg::Ping(Default::default())),
            };
            if let Some(msg) = msg {
                if to_machine.send(msg).await.is_err() {
                    break;
                }
            }
        }
    };
    let downward = async {
        // Pongs count: only a machine that stopped answering falls silent.
        while let Ok(Some(Ok(msg))) = tokio::time::timeout(upstream::SILENCE, from_machine.next()).await {
            // What the page is sent keeps the machine awake too: server-sent events, hot reload.
            if tunnel && matches!(msg, UpMsg::Text(_) | UpMsg::Binary(_)) {
                m.tunnel_output();
            }
            if let Some(msg) = client_message(msg) {
                if to_client.send(msg).await.is_err() {
                    break;
                }
            }
        }
    };
    tokio::select! {
        _ = upward => {}
        _ = downward => {}
    }
}

fn is_input(msg: &DownMsg) -> bool {
    match msg {
        DownMsg::Text(text) => text.as_str() != FRAME_ACK,
        DownMsg::Binary(_) => true,
        _ => false,
    }
}

/// Each side answers its own pings; the rest crosses over as it is.
fn machine_message(msg: DownMsg) -> Option<UpMsg> {
    Some(match msg {
        DownMsg::Text(text) => UpMsg::text(text.as_str()),
        DownMsg::Binary(bytes) => UpMsg::Binary(bytes),
        DownMsg::Close(frame) => {
            UpMsg::Close(frame.map(|f| UpClose { code: f.code.into(), reason: f.reason.as_str().into() }))
        }
        DownMsg::Ping(_) | DownMsg::Pong(_) => return None,
    })
}

fn client_message(msg: UpMsg) -> Option<DownMsg> {
    Some(match msg {
        UpMsg::Text(text) => DownMsg::text(text.as_str()),
        UpMsg::Binary(bytes) => DownMsg::Binary(bytes),
        UpMsg::Close(frame) => {
            DownMsg::Close(frame.map(|f| DownClose { code: f.code.into(), reason: f.reason.as_str().into() }))
        }
        UpMsg::Ping(_) | UpMsg::Pong(_) | UpMsg::Frame(_) => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_keeps_its_meaning() {
        let res = UpResponse::builder()
            .status(StatusCode::FORBIDDEN)
            .header(TUNNEL_PORT_REFUSED, "1")
            .header(header::CONTENT_LENGTH, "40")
            .header(header::CONNECTION, "close")
            .body(None)
            .unwrap();
        let answer = machine_refusal(&res);
        assert_eq!(answer.status(), StatusCode::FORBIDDEN);
        assert_eq!(answer.headers()[TUNNEL_PORT_REFUSED], "1");
        assert!(!answer.headers().contains_key(header::CONTENT_LENGTH));
        assert!(!answer.headers().contains_key(header::CONNECTION));
    }

    #[test]
    fn a_sleeping_machine_refuses_the_tunnel_as_t3_does() {
        let answer = port_refused();
        assert_eq!(answer.status(), StatusCode::FORBIDDEN);
        assert_eq!(answer.headers()[TUNNEL_PORT_REFUSED], "1");
    }
}
