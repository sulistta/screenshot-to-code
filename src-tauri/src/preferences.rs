use crate::{
    state::AppState,
    store::{err, Result},
};
use serde_json::{json, Value};
use tauri::State;

const SERVICE: &str = "com.screenshottocode.studio";
/// All credentials live in the OS credential store; SQLite contains only UI
/// preferences. Fail visibly when the keychain is locked instead of silently
/// falling back to plaintext storage.
fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, "provider-credentials").map_err(err)
}
fn credentials() -> Result<Value> {
    match entry()?.get_password() {
        Ok(raw) => serde_json::from_str(&raw).map_err(err),
        Err(keyring::Error::NoEntry) => Ok(json!({})),
        Err(e) => Err(format!("Cannot read the system keychain: {e}")),
    }
}
fn split(value: &Value) -> (Value, Value) {
    let mut public = value.clone();
    let mut secret = json!({});
    for key in [
        "openAiApiKey",
        "anthropicApiKey",
        "geminiApiKey",
        "replicateApiKey",
    ] {
        if let Some(v) = public.as_object_mut().and_then(|o| o.remove(key)) {
            secret[key] = v;
        }
    }
    if let Some(providers) = public["customProviders"].as_array_mut() {
        for provider in providers {
            let id = provider["id"].as_str().unwrap_or("").to_string();
            if let Some(obj) = provider.as_object_mut() {
                // Custom headers can contain tokens too.
                secret["customProviders"][&id] =
                    json!({"apiKey":obj.remove("apiKey"),"headers":obj.remove("headers")});
            }
        }
    }
    (public, secret)
}
#[tauri::command]
pub async fn load_preferences(state: State<'_, AppState>, key: String) -> Result<Value> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || load(&state, &key))
        .await
        .map_err(err)?
}
fn load(state: &AppState, key: &str) -> Result<Value> {
    if !matches!(key, "setting" | "app-theme") {
        return Err("Unknown preference".into());
    }
    let mut value = state.lock()?.store.preference(key)?;
    if key == "setting" && !value.is_null() {
        let secret = if value["credentialsStored"] == true {
            credentials()?
        } else {
            json!({})
        };
        for field in [
            "openAiApiKey",
            "anthropicApiKey",
            "geminiApiKey",
            "replicateApiKey",
        ] {
            value[field] = secret[field].clone();
        }
        if let Some(providers) = value["customProviders"].as_array_mut() {
            for provider in providers {
                let id = provider["id"].as_str().unwrap_or("").to_string();
                provider["apiKey"] = secret["customProviders"][&id]["apiKey"].clone();
                provider["headers"] = secret["customProviders"][&id]["headers"]
                    .as_object()
                    .map(|o| json!(o))
                    .unwrap_or(json!({}));
            }
        }
    }
    Ok(value)
}
#[tauri::command]
pub async fn save_preferences(state: State<'_, AppState>, key: String, value: Value) -> Result<()> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || save(&state, &key, value))
        .await
        .map_err(err)?
}
fn has_secret(v: &Value) -> bool {
    match v {
        Value::String(s) => !s.is_empty(),
        Value::Object(o) => o.values().any(has_secret),
        Value::Array(a) => a.iter().any(has_secret),
        _ => false,
    }
}
fn save(state: &AppState, key: &str, value: Value) -> Result<()> {
    if !matches!(key, "setting" | "app-theme") {
        return Err("Unknown preference".into());
    }
    if key == "setting" && !value.is_object() {
        return Err("Settings must be an object".into());
    }
    if key == "app-theme" && !matches!(value.as_str(), Some("system" | "light" | "dark")) {
        return Err("Unknown theme".into());
    }
    let value = if key == "setting" {
        let (mut public, secret) = split(&value);
        let present = has_secret(&secret);
        if present {
            entry()?
                .set_password(&secret.to_string())
                .map_err(|e| format!("Cannot save credentials in the system keychain: {e}"))?;
        } else if state.lock()?.store.preference(key)?["credentialsStored"] == true {
            match entry()?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(e) => return Err(err(e)),
            }
        }
        public["credentialsStored"] = json!(present);
        public
    } else {
        value
    };
    state.lock()?.store.set_preference(key, &value)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keys_and_custom_headers_never_enter_public_preferences() {
        let (public, secret) = split(
            &json!({"openAiApiKey":"secret","customProviders":[{"id":"one","apiKey":"token","headers":{"Authorization":"private"},"baseUrl":"https://example.com"}]}),
        );
        let raw = public.to_string();
        assert!(!raw.contains("secret"));
        assert!(!raw.contains("private"));
        assert!(!raw.contains("token"));
        assert_eq!(
            secret["customProviders"]["one"]["headers"]["Authorization"],
            "private"
        );
    }
}
