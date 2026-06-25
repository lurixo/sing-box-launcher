use std::collections::HashMap;
use std::time::Duration;

use tonic::metadata::MetadataValue;
use tonic::transport::Channel;
use tonic::Request;
use tracing::{info, warn};

use crate::error::AppError;

pub mod pb {
    tonic::include_proto!("daemon");
}

use pb::started_service_client::StartedServiceClient;

const MAX_RETRIES: u32 = 10;
const RETRY_DELAY_MS: u64 = 500;
const DELAY_TEST_WINDOW_SECS: u64 = 8;

/// Selector group exposed to the frontend (shape matches the former Clash client).
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProxyGroup {
    pub name: String,
    pub r#type: String,
    pub now: String,
    pub all: Vec<String>,
}

#[derive(Clone)]
pub struct NativeClient {
    channel: Channel,
    secret: String,
}

impl NativeClient {
    pub fn new(addr: &str, secret: &str) -> Result<Self, AppError> {
        let channel = Channel::from_shared(format!("http://{addr}"))
            .map_err(|e| AppError::ClashApi(format!("invalid api address: {e}")))?
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .connect_lazy();
        Ok(Self {
            channel,
            secret: secret.to_string(),
        })
    }

    fn client(&self) -> StartedServiceClient<Channel> {
        StartedServiceClient::new(self.channel.clone())
    }

    fn req<T>(&self, msg: T) -> Request<T> {
        let mut request = Request::new(msg);
        if !self.secret.is_empty() {
            if let Ok(value) = MetadataValue::try_from(format!("Bearer {}", self.secret)) {
                request.metadata_mut().insert("authorization", value);
            }
        }
        request
    }

    /// Fetch the current selector groups, retrying while the core API starts up.
    pub async fn get_selector_groups(&self) -> Result<Vec<ProxyGroup>, AppError> {
        let mut last_err = AppError::ClashApi("not attempted".into());
        for attempt in 1..=MAX_RETRIES {
            match self.first_groups().await {
                Ok(groups) => {
                    let mapped: Vec<ProxyGroup> = groups
                        .group
                        .into_iter()
                        .filter(|g| g.selectable)
                        .map(|g| ProxyGroup {
                            name: g.tag,
                            r#type: g.r#type,
                            now: g.selected,
                            all: g.items.into_iter().map(|i| i.tag).collect(),
                        })
                        .collect();
                    info!(attempt, count = mapped.len(), "fetched selector groups");
                    return Ok(mapped);
                }
                Err(e) => {
                    warn!(attempt, error = %e, "native API not ready");
                    last_err = e;
                    tokio::time::sleep(Duration::from_millis(RETRY_DELAY_MS)).await;
                }
            }
        }
        Err(AppError::ClashApi(format!(
            "after {MAX_RETRIES} retries: {last_err}"
        )))
    }

    /// Take the first snapshot from the SubscribeGroups server stream.
    async fn first_groups(&self) -> Result<pb::Groups, AppError> {
        let resp = self
            .client()
            .subscribe_groups(self.req(pb::Empty {}))
            .await
            .map_err(status)?;
        resp.into_inner()
            .message()
            .await
            .map_err(status)?
            .ok_or_else(|| AppError::ClashApi("groups stream closed".into()))
    }

    pub async fn switch_proxy(&self, group: &str, proxy: &str) -> Result<(), AppError> {
        self.client()
            .select_outbound(self.req(pb::SelectOutboundRequest {
                group_tag: group.to_string(),
                outbound_tag: proxy.to_string(),
            }))
            .await
            .map_err(status)?;
        info!(group, proxy, "proxy switched");
        Ok(())
    }

    /// Trigger a URL test for the group and collect node delays from group updates.
    pub async fn test_group_delay(&self, group: &str) -> Result<HashMap<String, i32>, AppError> {
        self.client()
            .url_test(self.req(pb::UrlTestRequest {
                outbound_tag: group.to_string(),
            }))
            .await
            .map_err(status)?;

        let resp = self
            .client()
            .subscribe_groups(self.req(pb::Empty {}))
            .await
            .map_err(status)?;
        let mut stream = resp.into_inner();

        let mut result: HashMap<String, i32> = HashMap::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(DELAY_TEST_WINDOW_SECS);
        while let Ok(Ok(Some(groups))) = tokio::time::timeout_at(deadline, stream.message()).await {
            if let Some(g) = groups.group.iter().find(|g| g.tag == group) {
                for item in &g.items {
                    if item.url_test_delay > 0 {
                        result.insert(item.tag.clone(), item.url_test_delay);
                    }
                }
                if !g.items.is_empty() && result.len() >= g.items.len() {
                    break;
                }
            }
        }
        info!(group, tested = result.len(), "delay test complete");
        Ok(result)
    }
}

fn status(s: tonic::Status) -> AppError {
    AppError::ClashApi(s.to_string())
}
