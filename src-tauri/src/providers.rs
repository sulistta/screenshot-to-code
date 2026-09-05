use crate::{
    state::AppState,
    store::{err, Result},
};
use serde_json::{json, Value};

#[derive(Clone)]
pub struct Provider {
    pub kind: String,
    pub base: String,
    pub key: String,
    pub model: String,
    pub headers: Value,
    pub effort: Option<String>,
}
#[derive(Clone)]
pub struct Reply {
    pub text: String,
    pub calls: Vec<Call>,
    pub raw: Value,
    pub cost: f64,
}
#[derive(Clone)]
pub struct Call {
    pub id: String,
    pub name: String,
    pub input: Value,
}
fn string(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or("").trim().to_string()
}

pub fn select(settings: &Value, requested: &str) -> Result<Provider> {
    if let Some(providers) = settings["customProviders"].as_array() {
        if let Some(p) = providers
            .iter()
            .find(|p| p["id"] == settings["activeCustomProviderId"] && p["enabled"] == true)
        {
            if requested.is_empty() || requested.starts_with("custom:") {
                let model = if requested.is_empty() {
                    p["models"][0]["id"].as_str().unwrap_or("")
                } else {
                    requested.trim_start_matches("custom:")
                };
                if model.is_empty() {
                    return Err("Configure a model for the selected provider".into());
                }
                let base = string(p, "baseUrl");
                validate_url(&base)?;
                return Ok(Provider {
                    kind: string(p, "protocol"),
                    base,
                    key: string(p, "apiKey"),
                    model: model.into(),
                    headers: p["headers"].clone(),
                    effort: None,
                });
            }
        }
    }
    if requested.starts_with("custom:") {
        return Err("The selected custom provider is disabled or missing".into());
    }
    let model = if requested.is_empty() {
        if !string(settings, "geminiApiKey").is_empty() {
            "gemini-3.1-pro-preview (high thinking)"
        } else if !string(settings, "anthropicApiKey").is_empty() {
            "claude-sonnet-4-6"
        } else {
            "gpt-5.5 (high thinking)"
        }
    } else {
        requested
    };
    let catalog: Vec<Value> = serde_json::from_str(include_str!("models.json")).map_err(err)?;
    let entry = catalog
        .iter()
        .find(|m| m["value"] == model)
        .ok_or("Select a model from the available catalogue")?;
    let effort = entry["effort"].as_str().map(String::from);
    let model = entry["model"].as_str().ok_or("Invalid catalogue model")?;
    let (kind, base, key) = if model.starts_with("claude-") {
        (
            "anthropic",
            "https://api.anthropic.com/v1",
            string(settings, "anthropicApiKey"),
        )
    } else if model.starts_with("gemini-") {
        (
            "gemini",
            "https://generativelanguage.googleapis.com/v1beta",
            string(settings, "geminiApiKey"),
        )
    } else {
        (
            "responses",
            "https://api.openai.com/v1",
            string(settings, "openAiApiKey"),
        )
    };
    if key.is_empty() {
        return Err(format!("Add a {kind} API key in Settings to use {model}"));
    }
    Ok(Provider {
        kind: kind.into(),
        base: base.into(),
        key,
        model: model.into(),
        headers: json!({}),
        effort,
    })
}
pub fn validate_url(base: &str) -> Result<()> {
    let url = reqwest::Url::parse(base).map_err(err)?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Use an API base URL without credentials, query or fragment".into());
    }
    if url.scheme() != "https"
        && !(url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    {
        return Err("Use HTTPS, or HTTP for a local provider".into());
    }
    Ok(())
}

pub fn initial(
    provider: &Provider,
    system: &str,
    context: &str,
    images: &[String],
) -> Result<Vec<Value>> {
    let mut media = vec![];
    for image in images {
        let (head, data) = image.split_once(",").ok_or("Invalid reference image")?;
        let mime = head
            .strip_prefix("data:")
            .and_then(|s| s.strip_suffix(";base64"))
            .ok_or("Images must be base64 data URLs")?;
        if !matches!(
            mime,
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        ) || data.len() > 20 * 1024 * 1024
        {
            return Err("Use PNG, JPEG, WebP or GIF references under 15 MiB".into());
        }
        media.push(match provider.kind.as_str() {
            "anthropic" => {
                json!({"type":"image","source":{"type":"base64","media_type":mime,"data":data}})
            }
            "gemini" => json!({"inlineData":{"mimeType":mime,"data":data}}),
            "responses" => json!({"type":"input_image","image_url":image}),
            _ => json!({"type":"image_url","image_url":{"url":image}}),
        });
    }
    Ok(match provider.kind.as_str() {
        "anthropic" => {
            media.insert(0, json!({"type":"text","text":context}));
            vec![json!({"role":"user","content":media})]
        }
        "gemini" => {
            media.insert(0, json!({"text":context}));
            vec![json!({"role":"user","parts":media})]
        }
        "responses" => {
            media.insert(0, json!({"type":"input_text","text":context}));
            vec![
                json!({"role":"system","content":system}),
                json!({"role":"user","content":media}),
            ]
        }
        _ => {
            media.insert(0, json!({"type":"text","text":context}));
            vec![
                json!({"role":"system","content":system}),
                json!({"role":"user","content":media}),
            ]
        }
    })
}

pub async fn request(
    state: &AppState,
    p: &Provider,
    system: &str,
    messages: &[Value],
    tools: &[Value],
    emit: &(dyn Fn(Value) + Send + Sync),
) -> Result<Reply> {
    let (route, mut body) = match p.kind.as_str() {
        "anthropic" => (
            "messages".to_string(),
            json!({"model":p.model,"max_tokens":16384,"system":system,"messages":messages,
            "tools":tools.iter().map(|t|json!({"name":t["name"],"description":t["description"],"input_schema":t["parameters"]})).collect::<Vec<_>>()}),
        ),
        "gemini" => (
            format!("models/{}:streamGenerateContent?alt=sse", p.model),
            json!({"systemInstruction":{"parts":[{"text":system}]},"contents":messages,
            "tools":[{"functionDeclarations":tools}],"generationConfig":{"maxOutputTokens":16384}}),
        ),
        "responses" => (
            "responses".to_string(),
            json!({"model":p.model,"input":messages,"max_output_tokens":16384,"store":false,
            "tools":tools.iter().map(|t|{let mut t=t.clone();t["type"]=json!("function");t}).collect::<Vec<_>>()}),
        ),
        _ => (
            "chat/completions".to_string(),
            json!({"model":p.model,"messages":messages,
            "tools":tools.iter().map(|t|json!({"type":"function","function":t})).collect::<Vec<_>>() }),
        ),
    };
    if let Some(effort) = &p.effort {
        match p.kind.as_str() {
            "responses" => body["reasoning"] = json!({"effort":effort}),
            "anthropic" => {
                body["thinking"] = json!({"type":"adaptive"});
                body["output_config"] = json!({"effort":effort});
            }
            "gemini" => {
                body["generationConfig"]["thinkingConfig"] =
                    json!({"thinkingLevel":effort.to_uppercase()})
            }
            _ => {}
        }
    }
    if tools.is_empty() {
        body.as_object_mut()
            .ok_or("Invalid request")?
            .remove("tools");
    }
    if p.kind != "gemini" {
        body["stream"] = json!(true);
    }
    let mut request = state
        .client
        .post(format!("{}/{}", p.base.trim_end_matches('/'), route))
        .json(&body);
    if !p.key.is_empty() {
        request = match p.kind.as_str() {
            "anthropic" => request
                .header("x-api-key", &p.key)
                .header("anthropic-version", "2023-06-01"),
            "gemini" => request.header("x-goog-api-key", &p.key),
            _ => request.bearer_auth(&p.key),
        };
    }
    if let Some(headers) = p.headers.as_object() {
        for (key, value) in headers {
            if let Some(v) = value.as_str() {
                request = request.header(key, v);
            }
        }
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("Provider request failed: {}", e.without_url()))?;
    if !response.status().is_success() {
        // Provider bodies may reflect authorization headers or user data.
        return Err(format!("Provider returned HTTP {}. Check the model, credentials, quota and endpoint in Settings.",response.status()));
    }
    if response
        .content_length()
        .is_some_and(|n| n > 32 * 1024 * 1024)
    {
        return Err("Provider response is too large".into());
    }
    let streaming = response
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.contains("text/event-stream"));
    let raw: Value = if streaming {
        crate::stream::read(response, &p.kind, emit).await?
    } else {
        response.json().await.map_err(err)?
    };
    let reply = parse(p, &raw)?;
    if !streaming && !reply.text.is_empty() {
        emit(json!({"type":"assistant_delta","text":reply.text}));
    }
    Ok(reply)
}
pub fn parse(p: &Provider, raw: &Value) -> Result<Reply> {
    let mut calls = vec![];
    let mut text = String::new();
    let message = match p.kind.as_str() {
        "anthropic" => {
            if raw["stop_reason"] == "max_tokens" {
                return Err("Provider output was truncated. Try a smaller change.".into());
            }
            json!({"role":"assistant","content":raw["content"]})
        }
        "gemini" => {
            if raw["candidates"][0]["finishReason"] == "MAX_TOKENS" {
                return Err("Provider output was truncated. Try a smaller change.".into());
            }
            raw["candidates"][0]["content"].clone()
        }
        "responses" => {
            if raw["status"] == "incomplete" {
                return Err("Provider output was truncated. Try a smaller change.".into());
            }
            raw["output"].clone()
        }
        _ => {
            if raw["choices"][0]["finish_reason"] == "length" {
                return Err("Provider output was truncated. Try a smaller change.".into());
            }
            raw["choices"][0]["message"].clone()
        }
    };
    match p.kind.as_str() {
        "anthropic" => {
            for part in raw["content"]
                .as_array()
                .ok_or("Empty Anthropic response")?
            {
                if part["type"] == "text" {
                    text.push_str(part["text"].as_str().unwrap_or(""));
                }
                if part["type"] == "tool_use" {
                    calls.push(Call {
                        id: string(part, "id"),
                        name: string(part, "name"),
                        input: part["input"].clone(),
                    });
                }
            }
        }
        "gemini" => {
            for part in message["parts"]
                .as_array()
                .ok_or("Gemini returned no content (possibly blocked)")?
            {
                if part["thought"] != true {
                    text.push_str(part["text"].as_str().unwrap_or(""));
                }
                if part["functionCall"].is_object() {
                    let f = &part["functionCall"];
                    calls.push(Call {
                        id: crate::store::id(),
                        name: string(f, "name"),
                        input: f["args"].clone(),
                    });
                }
            }
        }
        "responses" => {
            for part in message.as_array().ok_or("Empty Responses API output")? {
                if part["type"] == "function_call" {
                    calls.push(Call {
                        id: string(part, "call_id"),
                        name: string(part, "name"),
                        input: serde_json::from_str(&string(part, "arguments")).map_err(err)?,
                    });
                }
                if let Some(parts) = part["content"].as_array() {
                    for p in parts {
                        text.push_str(p["text"].as_str().unwrap_or(""));
                    }
                }
            }
        }
        _ => {
            text = message["content"].as_str().unwrap_or("").into();
            if let Some(tools) = message["tool_calls"].as_array() {
                for t in tools {
                    calls.push(Call {
                        id: string(t, "id"),
                        name: string(&t["function"], "name"),
                        input: serde_json::from_str(&string(&t["function"], "arguments"))
                            .map_err(err)?,
                    });
                }
            }
        }
    }
    if text.is_empty() && calls.is_empty() {
        return Err("Provider returned neither text nor tool calls".into());
    }
    Ok(Reply {
        cost: cost(p, raw),
        text,
        calls,
        raw: message,
    })
}
pub fn append(p: &Provider, messages: &mut Vec<Value>, reply: &Reply, results: &[Value]) {
    let images: Vec<String> = results
        .iter()
        .filter_map(|r| r["image"].as_str().map(String::from))
        .collect();
    let results: Vec<Value> = results
        .iter()
        .map(|r| {
            if r["image"].is_string() {
                json!({"captured":true})
            } else {
                r.clone()
            }
        })
        .collect();
    if p.kind == "responses" {
        if let Some(items) = reply.raw.as_array() {
            messages.extend(items.iter().cloned());
        }
    } else {
        messages.push(reply.raw.clone());
    }
    if results.is_empty() {
        return;
    }
    match p.kind.as_str() {
        "anthropic"=>messages.push(json!({"role":"user","content":reply.calls.iter().zip(&results).map(|(c,r)|json!({"type":"tool_result","tool_use_id":c.id,"content":r.to_string()})).collect::<Vec<_>>()})),
        "gemini"=>messages.push(json!({"role":"user","parts":reply.calls.iter().zip(&results).map(|(c,r)|json!({"functionResponse":{"name":c.name,"response":r}})).collect::<Vec<_>>()})),
        "responses"=>for (c,r) in reply.calls.iter().zip(&results) {messages.push(json!({"type":"function_call_output","call_id":c.id,"output":r.to_string()}));},
        _=>for (c,r) in reply.calls.iter().zip(&results) {messages.push(json!({"role":"tool","tool_call_id":c.id,"content":r.to_string()}));}
    }
    if !images.is_empty() {
        if let Ok(visual) = initial(p, "", "Tool screenshots of the current workspace:", &images) {
            messages.extend(visual.into_iter().filter(|m| m["role"] != "system"));
        }
    }
}
#[tauri::command]
pub fn list_models() -> Vec<Value> {
    serde_json::from_str(include_str!("models.json")).expect("bundled model catalogue")
}
#[tauri::command]
pub async fn test_provider(state: tauri::State<'_, AppState>, request: Value) -> Result<Value> {
    let p = Provider {
        kind: string(&request, "protocol"),
        base: string(&request, "baseUrl"),
        key: string(&request, "apiKey"),
        model: string(&request, "modelId"),
        headers: request["headers"].clone(),
        effort: None,
    };
    validate_url(&p.base)?;
    let mut discovery = state
        .client
        .get(format!("{}/models", p.base.trim_end_matches('/')));
    if !p.key.is_empty() {
        discovery = discovery.bearer_auth(&p.key);
    }
    if let Some(headers) = p.headers.as_object() {
        for (name, value) in headers {
            if let Some(value) = value.as_str() {
                discovery = discovery.header(name, value);
            }
        }
    }
    let mut models = vec![];
    if let Ok(response) = discovery.send().await {
        if response.status().is_success() {
            if let Ok(value) = response.json::<Value>().await {
                if let Some(entries) = value["data"].as_array() {
                    models = entries
                        .iter()
                        .filter_map(|m| m["id"].as_str().map(String::from))
                        .collect();
                }
            }
        }
    }
    if p.model.is_empty() {
        return Ok(
            json!({"ok":!models.is_empty(),"models":models,"detail":"Select a discovered model to test generation."}),
        );
    }
    let messages = initial(&p, "Reply briefly.", "Reply with OK.", &[])?;
    match self::request(&state, &p, "Reply briefly.", &messages, &[], &|_: Value| {}).await {
        Ok(_) => {
            if !models.contains(&p.model) {
                models.push(p.model);
            }
            Ok(json!({"ok":true,"models":models}))
        }
        Err(error) => Ok(json!({"ok":false,"error":error,"models":models})),
    }
}

fn cost(provider: &Provider, raw: &Value) -> f64 {
    let prices: Value =
        serde_json::from_str(include_str!("pricing.json")).expect("bundled pricing");
    let price = &prices[&provider.model];
    let number = |v: &Value| v.as_f64().unwrap_or(0.0);
    let usage = &raw["usage"];
    let (input, output, read, write) = match provider.kind.as_str() {
        "anthropic" => (
            number(&usage["input_tokens"]),
            number(&usage["output_tokens"]),
            number(&usage["cache_read_input_tokens"]),
            number(&usage["cache_creation_input_tokens"]),
        ),
        "gemini" => {
            let u = &raw["usageMetadata"];
            let cached = number(&u["cachedContentTokenCount"]);
            (
                (number(&u["promptTokenCount"]) - cached).max(0.0),
                number(&u["candidatesTokenCount"]) + number(&u["thoughtsTokenCount"]),
                cached,
                0.0,
            )
        }
        _ => {
            let cached = number(&usage["input_tokens_details"]["cached_tokens"]);
            (
                (number(&usage["input_tokens"]) - cached).max(0.0),
                number(&usage["output_tokens"]),
                cached,
                0.0,
            )
        }
    };
    (input * number(&price["input"])
        + output * number(&price["output"])
        + read * number(&price["cache_read"])
        + write * number(&price["cache_write"]))
        / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    struct Seen {
        method: String,
        path: String,
        auth: Option<String>,
        has_bearer: bool,
        body: Vec<u8>,
    }

    struct Script {
        status: u16,
        content_type: &'static str,
        writes: Vec<&'static [u8]>,
    }

    /// Deterministic local HTTP fixture. Records the request line, which auth
    /// header *name* was sent (never its value), and the body; then replays
    /// the scripted writes, optionally fragmented across TCP segments.
    fn serve(scripts: Vec<Script>) -> (String, Arc<Mutex<Vec<Seen>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_thread = seen.clone();
        std::thread::spawn(move || {
            for script in scripts {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    match stream.read(&mut byte) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => head.push(byte[0]),
                    }
                    if head.len() > 64 * 1024 {
                        break;
                    }
                }
                let text = String::from_utf8_lossy(&head).into_owned();
                let mut lines = text.lines();
                let request_line = lines.next().unwrap_or("").to_string();
                let mut content_length = 0usize;
                let mut auth: Option<String> = None;
                let mut has_bearer = false;
                for line in lines {
                    let lower = line.to_lowercase();
                    if lower.starts_with("content-length:") {
                        content_length = lower
                            .split(':')
                            .nth(1)
                            .unwrap_or("")
                            .trim()
                            .parse()
                            .unwrap_or(0);
                    }
                    if lower.starts_with("x-api-key:") {
                        auth = Some("x-api-key".into());
                    }
                    if lower.starts_with("x-goog-api-key:") {
                        auth = Some("x-goog-api-key".into());
                    }
                    if lower.starts_with("authorization:") {
                        auth = Some("authorization".into());
                        has_bearer = lower.contains("bearer");
                    }
                }
                let mut body = vec![0u8; content_length.min(8 * 1024 * 1024)];
                let _ = stream.read_exact(&mut body);
                let mut parts = request_line.split_whitespace();
                seen_thread.lock().unwrap().push(Seen {
                    method: parts.next().unwrap_or("").into(),
                    path: parts.next().unwrap_or("").into(),
                    auth,
                    has_bearer,
                    body,
                });
                let reason = match script.status {
                    200 => "OK",
                    401 => "Unauthorized",
                    429 => "Too Many Requests",
                    _ => "Error",
                };
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 {} {}\r\ncontent-type: {}\r\nconnection: close\r\n\r\n",
                        script.status, reason, script.content_type
                    )
                    .as_bytes(),
                );
                for chunk in script.writes {
                    if stream.write_all(chunk).is_err() {
                        break;
                    }
                    let _ = stream.flush();
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
        });
        (url, seen)
    }

    fn state() -> AppState {
        AppState::new(tempfile::tempdir().unwrap().keep()).unwrap()
    }

    fn provider(kind: &str, base: &str) -> Provider {
        Provider {
            kind: kind.into(),
            base: base.into(),
            key: "secret-key-DISTINCT-123".into(),
            model: "test-model".into(),
            headers: Value::Null,
            effort: None,
        }
    }

    fn deltas() -> (Arc<Mutex<Vec<String>>>, impl Fn(Value) + Send + Sync) {
        let texts = Arc::new(Mutex::new(Vec::new()));
        let moved = texts.clone();
        let emit = move |event: Value| {
            if event["type"] == "assistant_delta" {
                if let Some(text) = event["text"].as_str() {
                    moved.lock().unwrap().push(text.to_string());
                }
            }
        };
        (texts, emit)
    }

    #[tokio::test]
    async fn chat_completions_reassembles_fragmented_tool_calls() {
        let (url, seen) = serve(vec![Script {
            status: 200,
            content_type: "text/event-stream",
            writes: vec![
                b"data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hi\"}}]}\n\n",
                b"data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"type\":\"function\",\"function\":{\"name\":\"read_fi",
                b"le\",\"arguments\":\"{\\\"path\\\":\\\"ind\"}}]}}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"ex.html\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n",
            ],
        }]);
        let state = state();
        let (texts, emit) = deltas();
        let reply = request(
            &state,
            &provider("chat_completions", &url),
            "sys",
            &[],
            &[],
            &emit,
        )
        .await
        .unwrap();
        assert_eq!(reply.text, "Hi");
        assert_eq!(reply.calls.len(), 1);
        assert_eq!(reply.calls[0].id, "call-1");
        assert_eq!(reply.calls[0].name, "read_file");
        assert_eq!(reply.calls[0].input["path"], "index.html");
        assert_eq!(texts.lock().unwrap().concat(), "Hi");
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].method, "POST");
        assert_eq!(seen[0].path, "/chat/completions");
        assert!(seen[0].has_bearer);
        assert!(
            String::from_utf8_lossy(&seen[0].body).contains("test-model"),
            "the configured model must reach the provider"
        );
    }

    #[tokio::test]
    async fn chat_completions_reads_plain_text_replies() {
        let (url, _) = serve(vec![Script {
            status: 200,
            content_type: "application/json",
            writes: vec![b"{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"Done.\"},\"finish_reason\":\"stop\"}]}"],
        }]);
        let state = state();
        let reply = request(
            &state,
            &provider("chat_completions", &url),
            "sys",
            &[],
            &[],
            &|_: Value| {},
        )
        .await
        .unwrap();
        assert_eq!(reply.text, "Done.");
        assert!(reply.calls.is_empty());
    }

    #[tokio::test]
    async fn responses_protocol_preserves_call_identity() {
        let (url, seen) = serve(vec![Script {
            status: 200,
            content_type: "text/event-stream",
            writes: vec![
                b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"Working\"}\n\n",
                b"data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"function_call\",\"call_id\":\"call-9\",\"name\":\"edit_file\",\"arguments\":\"{\\\"path\\\":\\\"a\\\"}\"}]}}\n\ndata: [DONE]\n\n",
            ],
        }]);
        let state = state();
        let reply = request(
            &state,
            &provider("responses", &url),
            "sys",
            &[],
            &[],
            &|_: Value| {},
        )
        .await
        .unwrap();
        assert_eq!(reply.calls.len(), 1);
        assert_eq!(reply.calls[0].id, "call-9");
        assert_eq!(reply.calls[0].input["path"], "a");
        assert_eq!(seen.lock().unwrap()[0].path, "/responses");
    }

    #[tokio::test]
    async fn anthropic_uses_its_headers_and_tool_format() {
        let (url, seen) = serve(vec![Script {
            status: 200,
            content_type: "application/json",
            writes: vec![b"{\"content\":[{\"type\":\"text\",\"text\":\"Hi\"},{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"read_file\",\"input\":{\"path\":\"a\"}}],\"stop_reason\":\"end_turn\"}"],
        }]);
        let state = state();
        let reply = request(
            &state,
            &provider("anthropic", &url),
            "sys",
            &[],
            &[],
            &|_: Value| {},
        )
        .await
        .unwrap();
        assert_eq!(reply.text, "Hi");
        assert_eq!(reply.calls[0].id, "t1");
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].path, "/messages");
        assert_eq!(seen[0].auth.as_deref(), Some("x-api-key"));
    }

    #[tokio::test]
    async fn gemini_streams_parts_and_rejects_blocked_replies() {
        let (url, seen) = serve(vec![Script {
            status: 200,
            content_type: "text/event-stream",
            writes: vec![b"data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hello\"}]},\"finishReason\":\"STOP\"}]}\n\ndata: [DONE]\n\n"],
        }]);
        let state = state();
        let reply = request(
            &state,
            &provider("gemini", &url),
            "sys",
            &[],
            &[],
            &|_: Value| {},
        )
        .await
        .unwrap();
        assert_eq!(reply.text, "Hello");
        assert!(seen.lock().unwrap()[0]
            .path
            .contains("streamGenerateContent"));

        let blocked = Provider {
            kind: "gemini".into(),
            base: "".into(),
            key: "".into(),
            model: "".into(),
            headers: Value::Null,
            effort: None,
        };
        assert!(parse(&blocked, &json!({"candidates":[{}]})).is_err());
    }

    #[tokio::test]
    async fn http_errors_are_sanitized() {
        for status in [401u16, 429u16] {
            let (url, _) = serve(vec![Script {
                status,
                content_type: "application/json",
                writes: vec![b"{\"error\":\"bad key secret-key-DISTINCT-123\"}"],
            }]);
            let state = state();
            let error = match request(
                &state,
                &provider("chat_completions", &url),
                "sys",
                &[],
                &[],
                &|_: Value| {},
            )
            .await
            {
                Ok(_) => panic!("expected HTTP {status} to fail"),
                Err(error) => error,
            };
            assert!(error.contains(&status.to_string()), "unexpected: {error}");
            assert!(!error.contains("secret-key-DISTINCT-123"), "leak: {error}");
        }
    }

    #[tokio::test]
    async fn malformed_and_truncated_responses_error() {
        let (url, _) = serve(vec![Script {
            status: 200,
            content_type: "application/json",
            writes: vec![b"{\"choices\":"],
        }]);
        let state = state();
        assert!(request(
            &state,
            &provider("chat_completions", &url),
            "sys",
            &[],
            &[],
            &|_: Value| {}
        )
        .await
        .is_err());

        let (url, _) = serve(vec![Script {
            status: 200,
            content_type: "text/event-stream",
            writes: vec![
                b"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n",
            ],
        }]);
        assert!(request(
            &state,
            &provider("chat_completions", &url),
            "sys",
            &[],
            &[],
            &|_: Value| {}
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn transport_failures_omit_urls_and_secrets() {
        let state = state();
        let error = match request(
            &state,
            &provider("chat_completions", "http://127.0.0.1:1/v1"),
            "sys",
            &[],
            &[],
            &|_: Value| {},
        )
        .await
        {
            Ok(_) => panic!("expected a connection failure"),
            Err(error) => error,
        };
        assert!(
            error.starts_with("Provider request failed:"),
            "unexpected: {error}"
        );
        assert!(!error.contains("secret-key-DISTINCT-123"), "leak: {error}");
    }

    #[test]
    fn truncation_is_reported_per_protocol() {
        let kinds = [
            (
                "chat_completions",
                json!({"choices":[{"message":{},"finish_reason":"length"}]}),
            ),
            (
                "anthropic",
                json!({"content":[],"stop_reason":"max_tokens"}),
            ),
            (
                "gemini",
                json!({"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[]}}]}),
            ),
            ("responses", json!({"status":"incomplete","output":[]})),
        ];
        for (kind, raw) in kinds {
            let p = Provider {
                kind: kind.into(),
                base: "".into(),
                key: "".into(),
                model: "".into(),
                headers: Value::Null,
                effort: None,
            };
            assert!(parse(&p, &raw).is_err(), "{kind} should report truncation");
        }
    }

    #[test]
    fn select_resolves_custom_providers_and_best_available() {
        let custom = |enabled: bool| {
            json!({
                "customProviders": [{
                    "id": "local", "enabled": enabled, "baseUrl": "http://127.0.0.1:11434/v1",
                    "apiKey": null, "protocol": "chat_completions", "headers": {},
                    "models": [{"id": "qwen", "name": "Qwen"}],
                }],
                "activeCustomProviderId": "local",
                "openAiApiKey": null, "anthropicApiKey": null, "geminiApiKey": null,
            })
        };
        let p = select(&custom(true), "").unwrap();
        assert_eq!(
            (p.kind.as_str(), p.model.as_str()),
            ("chat_completions", "qwen")
        );
        let p = select(&custom(true), "custom:qwen").unwrap();
        assert_eq!(p.model, "qwen");
        assert!(select(&custom(false), "custom:qwen").is_err());
        assert!(select(&json!({"customProviders": []}), "custom:qwen").is_err());
        assert!(select(&json!({"customProviders": []}), "").is_err());

        let anthropic = select(
            &json!({"customProviders": [], "anthropicApiKey": "k", "openAiApiKey": null, "geminiApiKey": null}),
            "",
        )
        .unwrap();
        assert_eq!(anthropic.kind, "anthropic");
        let openai = select(
            &json!({"customProviders": [], "openAiApiKey": "k", "anthropicApiKey": null, "geminiApiKey": null}),
            "gpt-5.5 (high thinking)",
        )
        .unwrap();
        assert_eq!(openai.kind, "responses");
        assert!(select(&json!({"customProviders": []}), "no-such-model").is_err());
    }

    #[test]
    fn initial_validates_reference_images_per_protocol() {
        let image = "data:image/png;base64,aGk=";
        let chat = Provider {
            kind: "chat_completions".into(),
            base: "".into(),
            key: "".into(),
            model: "".into(),
            headers: Value::Null,
            effort: None,
        };
        let messages = initial(&chat, "sys", "ctx", &[image.into()]).unwrap();
        assert_eq!(messages.len(), 2);
        assert!(initial(&chat, "sys", "ctx", &["not-a-data-url".into()]).is_err());
        assert!(initial(&chat, "sys", "ctx", &["data:image/bmp;base64,aGk=".into()]).is_err());
        let huge = format!("data:image/png;base64,{}", "a".repeat(21 * 1024 * 1024));
        assert!(initial(&chat, "sys", "ctx", &[huge]).is_err());

        for kind in ["anthropic", "gemini", "responses"] {
            let p = Provider {
                kind: kind.into(),
                ..chat.clone()
            };
            assert!(initial(&p, "sys", "ctx", &[image.into()]).is_ok(), "{kind}");
        }
    }
    #[test]
    fn responses_tools_preserve_call_identity() {
        let p = Provider {
            kind: "responses".into(),
            base: "".into(),
            key: "".into(),
            model: "".into(),
            headers: Value::Null,
            effort: None,
        };
        let r=parse(&p,&json!({"output":[{"type":"function_call","call_id":"call-1","name":"read_file","arguments":"{\"path\":\"index.html\"}"}]})).unwrap();
        let mut messages = vec![];
        append(&p, &mut messages, &r, &[json!({"content":"x"})]);
        assert_eq!(messages[1]["call_id"], "call-1");
    }
    #[test]
    fn credentials_require_encrypted_transport_except_loopback() {
        assert!(validate_url("http://evil.example/v1").is_err());
        assert!(validate_url("https://user:secret@example.com").is_err());
        assert!(validate_url("http://127.0.0.1:11434/v1").is_ok());
    }
}
