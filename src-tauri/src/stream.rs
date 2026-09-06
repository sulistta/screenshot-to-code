use crate::store::{err, Result};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Accumulates the provider's original message, including opaque thinking
/// signatures and tool IDs needed by the next turn. Deltas cross IPC as soon
/// as they arrive; only complete JSON tool arguments are executed.
pub struct Accumulator {
    kind: String,
    raw: Value,
    blocks: BTreeMap<usize, Value>,
    arguments: BTreeMap<usize, String>,
    complete: bool,
}
impl Accumulator {
    pub fn new(kind: &str) -> Self {
        Self {
            kind: kind.into(),
            raw: json!({}),
            blocks: BTreeMap::new(),
            arguments: BTreeMap::new(),
            complete: false,
        }
    }
    pub fn push(&mut self, event: Value, emit: &(dyn Fn(Value) + Send + Sync)) -> Result<()> {
        if event["type"] == "error" || event["type"] == "response.failed" {
            return Err("The provider reported a streaming error".into());
        }
        match self.kind.as_str() {
            "responses" => match event["type"].as_str() {
                Some("response.output_text.delta") => {
                    emit(json!({"type":"assistant_delta","text":event["delta"]}))
                }
                Some("response.reasoning_summary_text.delta") => {
                    emit(json!({"type":"thinking_delta","text":event["delta"]}))
                }
                Some("response.completed" | "response.incomplete") => {
                    self.raw = event["response"].clone();
                    self.complete = true;
                }
                _ => {}
            },
            "gemini" => {
                if event["usageMetadata"].is_object() {
                    self.raw["usageMetadata"] = event["usageMetadata"].clone();
                }
                if let Some(parts) = event["candidates"][0]["content"]["parts"].as_array() {
                    for part in parts {
                        if part["text"].is_string() {
                            emit(
                                json!({"type":if part["thought"]==true{"thinking_delta"}else{"assistant_delta"},"text":part["text"]}),
                            );
                        }
                        self.blocks.insert(self.blocks.len(), part.clone());
                    }
                }
                if event["candidates"][0]["finishReason"].is_string() {
                    self.raw["finishReason"] = event["candidates"][0]["finishReason"].clone();
                    self.complete = true;
                }
            }
            "anthropic" => match event["type"].as_str() {
                Some("message_start") => self.raw = event["message"].clone(),
                Some("content_block_start") => {
                    self.blocks.insert(
                        event["index"].as_u64().unwrap_or(0) as usize,
                        event["content_block"].clone(),
                    );
                }
                Some("content_block_delta") => {
                    let index = event["index"].as_u64().unwrap_or(0) as usize;
                    let delta = &event["delta"];
                    let block = self.blocks.entry(index).or_insert(json!({}));
                    match delta["type"].as_str() {
                        Some("text_delta") => {
                            append(block, "text", &delta["text"]);
                            emit(json!({"type":"assistant_delta","text":delta["text"]}));
                        }
                        Some("thinking_delta") => {
                            append(block, "thinking", &delta["thinking"]);
                            emit(json!({"type":"thinking_delta","text":delta["thinking"]}));
                        }
                        Some("signature_delta") => append(block, "signature", &delta["signature"]),
                        Some("input_json_delta") => self
                            .arguments
                            .entry(index)
                            .or_default()
                            .push_str(delta["partial_json"].as_str().unwrap_or("")),
                        _ => {}
                    }
                }
                Some("message_delta") => {
                    self.raw["stop_reason"] = event["delta"]["stop_reason"].clone();
                    if let Some(usage) = event["usage"].as_object() {
                        for (k, v) in usage {
                            self.raw["usage"][k] = v.clone();
                        }
                    }
                }
                Some("message_stop") => self.complete = true,
                _ => {}
            },
            _ => {
                if event["usage"].is_object() {
                    self.raw["usage"] = event["usage"].clone();
                }
                if let Some(choices) = event["choices"].as_array() {
                    for choice in choices {
                        if choice["index"] != 0 {
                            continue;
                        }
                        let delta = &choice["delta"];
                        let message = self
                            .blocks
                            .entry(0)
                            .or_insert(json!({"role":"assistant","content":""}));
                        if delta["content"].is_string() {
                            append(message, "content", &delta["content"]);
                            emit(json!({"type":"assistant_delta","text":delta["content"]}));
                        }
                        for field in ["reasoning_content", "reasoning"] {
                            if delta[field].is_string() {
                                append(message, field, &delta[field]);
                                emit(json!({"type":"thinking_delta","text":delta[field]}));
                                break;
                            }
                        }
                        if let Some(calls) = delta["tool_calls"].as_array() {
                            for call in calls {
                                let index = call["index"].as_u64().unwrap_or(0) as usize + 1;
                                let block=self.blocks.entry(index).or_insert(json!({"type":"function","function":{"name":"","arguments":""}}));
                                if call["id"].is_string() {
                                    block["id"] = call["id"].clone();
                                }
                                append(&mut block["function"], "name", &call["function"]["name"]);
                                append(
                                    &mut block["function"],
                                    "arguments",
                                    &call["function"]["arguments"],
                                );
                            }
                        }
                        if !choice["finish_reason"].is_null() {
                            self.raw["finish_reason"] = choice["finish_reason"].clone();
                            self.complete = true;
                        }
                    }
                }
            }
        }
        Ok(())
    }
    pub fn finish(mut self) -> Result<Value> {
        if !self.complete {
            return Err("Provider stream ended before completing the response".into());
        }
        match self.kind.as_str() {
            "responses" => {}
            "gemini" => {
                self.raw["candidates"] = json!([{"content":{"role":"model","parts":self.blocks.into_values().collect::<Vec<_>>()},"finishReason":self.raw["finishReason"]}]);
            }
            "anthropic" => {
                for (index, args) in self.arguments {
                    self.blocks.get_mut(&index).ok_or("Missing tool block")?["input"] =
                        serde_json::from_str(&args).map_err(err)?;
                }
                self.raw["content"] = json!(self.blocks.into_values().collect::<Vec<_>>());
            }
            _ => {
                let mut message = self
                    .blocks
                    .remove(&0)
                    .unwrap_or(json!({"role":"assistant","content":""}));
                if !self.blocks.is_empty() {
                    message["tool_calls"] = json!(self.blocks.into_values().collect::<Vec<_>>());
                }
                self.raw["choices"] =
                    json!([{"message":message,"finish_reason":self.raw["finish_reason"]}]);
            }
        }
        Ok(self.raw)
    }
}
fn append(value: &mut Value, key: &str, part: &Value) {
    if let Some(part) = part.as_str() {
        if let Some(Value::String(text)) = value.get_mut(key) {
            text.push_str(part);
        } else {
            value[key] = json!(part);
        }
    }
}
struct TextBatch<'a> {
    pending: std::sync::Mutex<Vec<Value>>,
    emit: &'a (dyn Fn(Value) + Send + Sync),
}
impl TextBatch<'_> {
    fn push(&self, event: Value) {
        let mut events = self.pending.lock().unwrap();
        if let Some(last) = events.last_mut() {
            if last["type"] == event["type"] && event["text"].is_string() {
                append(last, "text", &event["text"]);
                return;
            }
        }
        events.push(event);
    }
    fn flush(&self) {
        let events = std::mem::take(&mut *self.pending.lock().unwrap());
        for event in events {
            (self.emit)(event);
        }
    }
}
impl Drop for TextBatch<'_> {
    fn drop(&mut self) {
        self.flush();
    }
}

pub async fn read(
    mut response: reqwest::Response,
    kind: &str,
    emit: &(dyn Fn(Value) + Send + Sync),
) -> Result<Value> {
    // Persist/send bounded text batches instead of one SQLite transaction and IPC per token.
    let batch = TextBatch {
        pending: std::sync::Mutex::new(Vec::new()),
        emit,
    };
    let collect = |event| batch.push(event);
    let flush = || batch.flush();
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(50));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let result = async {
        let mut accumulator = Accumulator::new(kind);
        let mut buffer = vec![];
        let mut total = 0;
        loop {
            let chunk = tokio::select! {
                chunk = response.chunk() => chunk.map_err(|e| e.without_url().to_string())?,
                _ = tick.tick() => { flush(); continue; }
            };
            let Some(chunk) = chunk else {
                break;
            };
            total += chunk.len();
            if total > 32 * 1024 * 1024 {
                return Err("Provider stream exceeds 32 MiB".into());
            }
            buffer.extend_from_slice(&chunk);
            while let Some(index) = buffer.iter().position(|b| *b == b'\n') {
                let line: Vec<_> = buffer.drain(..=index).collect();
                let text = std::str::from_utf8(&line).map_err(err)?.trim();
                if let Some(data) = text.strip_prefix("data:") {
                    let data = data.trim();
                    if data != "[DONE]" && !data.is_empty() {
                        accumulator.push(serde_json::from_str(data).map_err(err)?, &collect)?;
                    }
                }
            }
        }
        accumulator.finish()
    }
    .await;
    // Also retain the final partial text on a failed/disconnected provider stream.
    flush();
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn text_batches_flush_on_cancellation_drop_without_mixing_kinds() {
        let events = std::sync::Mutex::new(Vec::new());
        let emit = |event| events.lock().unwrap().push(event);
        {
            let batch = TextBatch {
                pending: std::sync::Mutex::new(Vec::new()),
                emit: &emit,
            };
            for _ in 0..1000 {
                batch.push(json!({"type":"thinking_delta","text":"x"}));
            }
            batch.push(json!({"type":"assistant_delta","text":"Done"}));
            assert!(events.lock().unwrap().is_empty());
        }
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["text"], "x".repeat(1000));
        assert_eq!(events[1]["text"], "Done");
    }
    #[test]
    fn tool_fragments_are_only_parsed_after_completion() {
        let mut a = Accumulator::new("chat_completions");
        let emit = |_: Value| {};
        a.push(json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"id","function":{"name":"read_file","arguments":"{\"pa"}}]}}]}),&emit).unwrap();
        a.push(json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"index.html\"}"}}]},"finish_reason":"tool_calls"}]}),&emit).unwrap();
        let raw = a.finish().unwrap();
        assert_eq!(
            raw["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
            "{\"path\":\"index.html\"}"
        );
    }
    #[test]
    fn chat_reasoning_is_emitted_before_completion_and_preserved() {
        let events = std::sync::Mutex::new(Vec::new());
        let emit = |event| events.lock().unwrap().push(event);
        let mut a = Accumulator::new("chat_completions");
        a.push(
            json!({"choices":[{"index":0,"delta":{"reasoning_content":"Inspect "}}]}),
            &emit,
        )
        .unwrap();
        a.push(
            json!({"choices":[{"index":0,"delta":{"reasoning_content":"files"}}]}),
            &emit,
        )
        .unwrap();
        assert_eq!(
            events.lock().unwrap()[0],
            json!({"type":"thinking_delta","text":"Inspect "})
        );
        assert_eq!(events.lock().unwrap().len(), 2);
        a.push(
            json!({"choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}),
            &emit,
        )
        .unwrap();
        assert_eq!(
            a.finish().unwrap()["choices"][0]["message"]["reasoning_content"],
            "Inspect files"
        );
    }
    #[test]
    fn disconnected_stream_does_not_commit_partial_output() {
        assert!(Accumulator::new("responses").finish().is_err());
    }
}
