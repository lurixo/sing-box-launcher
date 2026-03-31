use std::collections::HashMap;
use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;
use tracing::{info, warn};

use crate::error::AppError;

const DEFAULT_TEST_URL: &str = "https://www.gstatic.com/generate_204";
const DEFAULT_TEST_TIMEOUT: u32 = 5000;
const MAX_RETRIES: u32 = 10;
const RETRY_DELAY_MS: u64 = 500;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProxyGroup {
    pub name: String,
    pub r#type: String,
    pub now: String,
    pub all: Vec<String>,
}

#[derive(Deserialize)]
struct ProxiesResponse {
    proxies: HashMap<String, ProxyEntry>,
}

#[derive(Deserialize)]
struct ProxyEntry {
    r#type: String,
    now: Option<String>,
    all: Option<Vec<String>>,
}

#[derive(Clone)]
pub struct ClashClient {
    base_url: String,
    secret: String,
    client: Client,
}

impl ClashClient {
    pub fn new(addr: &str, secret: &str) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .expect("failed to build HTTP client");

        Self {
            base_url: format!("http://{addr}"),
            secret: secret.to_string(),
            client,
        }
    }

    /// Get all Selector-type proxy groups with retry logic.
    /// Retries up to 10 times with 500ms interval to wait for sing-box startup.
    pub async fn get_selector_groups(&self) -> Result<Vec<ProxyGroup>, AppError> {
        let mut last_err = AppError::ClashApi("not attempted".into());

        for attempt in 1..=MAX_RETRIES {
            match self.fetch_groups().await {
                Ok(groups) => {
                    info!(attempt, count = groups.len(), "fetched selector groups");
                    return Ok(groups);
                }
                Err(e) => {
                    warn!(attempt, error = %e, "clash API not ready");
                    last_err = e;
                    tokio::time::sleep(Duration::from_millis(RETRY_DELAY_MS)).await;
                }
            }
        }

        Err(AppError::ClashApi(format!(
            "after {MAX_RETRIES} retries: {last_err}"
        )))
    }

    async fn fetch_groups(&self) -> Result<Vec<ProxyGroup>, AppError> {
        let url = format!("{}/proxies", self.base_url);
        let resp: ProxiesResponse = self
            .client
            .get(&url)
            .headers(self.auth_headers())
            .send()
            .await?
            .json()
            .await?;

        let groups: Vec<ProxyGroup> = resp
            .proxies
            .into_iter()
            .filter(|(_, entry)| entry.r#type == "Selector")
            .map(|(name, entry)| ProxyGroup {
                name,
                r#type: entry.r#type,
                now: entry.now.unwrap_or_default(),
                all: entry.all.unwrap_or_default(),
            })
            .collect();

        Ok(groups)
    }

    /// Switch the selected proxy in a Selector group
    pub async fn switch_proxy(&self, group: &str, proxy: &str) -> Result<(), AppError> {
        let url = format!(
            "{}/proxies/{}",
            self.base_url,
            urlencoding::encode(group)
        );
        let body = serde_json::json!({ "name": proxy });

        let resp = self
            .client
            .put(&url)
            .headers(self.auth_headers())
            .json(&body)
            .send()
            .await?;

        if resp.status().is_client_error() || resp.status().is_server_error() {
            return Err(AppError::ClashApi(format!("HTTP {}", resp.status())));
        }

        info!(group, proxy, "proxy switched");
        Ok(())
    }

    /// Test delay for all proxies in a group.
    /// Returns map of proxy_name → delay_ms. 0 means timeout/error.
    pub async fn test_group_delay(
        &self,
        group: &str,
    ) -> Result<HashMap<String, i32>, AppError> {
        let url = format!(
            "{}/group/{}/delay?url={}&timeout={}",
            self.base_url,
            urlencoding::encode(group),
            urlencoding::encode(DEFAULT_TEST_URL),
            DEFAULT_TEST_TIMEOUT,
        );

        let resp = self
            .client
            .get(&url)
            .headers(self.auth_headers())
            .send()
            .await?;

        let result: HashMap<String, i32> = resp.json().await?;
        info!(group, tested = result.len(), "delay test complete");
        Ok(result)
    }

    fn auth_headers(&self) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        if !self.secret.is_empty() {
            headers.insert(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {}", self.secret).parse().unwrap(),
            );
        }
        headers
    }
}
