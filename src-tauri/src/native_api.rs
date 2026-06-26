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

use pb::outbound_trace_service_client::OutboundTraceServiceClient;
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

/// Outbound IP details resolved through the native trace service.
#[derive(Debug, Clone, serde::Serialize)]
pub struct OutboundIpInfo {
    pub ip: String,
    pub country: String,
    pub asn: String,
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

    fn trace_client(&self) -> OutboundTraceServiceClient<Channel> {
        OutboundTraceServiceClient::new(self.channel.clone())
    }

    async fn get_outbound_trace(&self, ipv6: bool) -> Result<String, AppError> {
        let resp = self
            .trace_client()
            .get_outbound_trace(self.req(pb::OutboundTraceRequest { ipv6 }))
            .await
            .map_err(status)?;
        Ok(resp.into_inner().json)
    }

    async fn get_domain_strategy(&self) -> Result<String, AppError> {
        let resp = self
            .trace_client()
            .get_domain_strategy(self.req(pb::Empty {}))
            .await
            .map_err(status)?;
        Ok(resp.into_inner().value)
    }

    async fn trace_info(&self, ipv6: bool) -> Option<OutboundIpInfo> {
        let raw = self.get_outbound_trace(ipv6).await.ok()?;
        parse_trace(&raw, ipv6)
    }

    /// Resolve the current outbound IP(s), honouring the domain strategy so a
    /// v4-only or v6-only outbound is not probed for the family it lacks.
    pub async fn get_outbound_ip(&self) -> Result<Vec<OutboundIpInfo>, AppError> {
        let strategy = self.get_domain_strategy().await.unwrap_or_default();
        let mut out = Vec::new();
        if strategy != "ipv6_only" {
            if let Some(info) = self.trace_info(false).await {
                out.push(info);
            }
        }
        if strategy != "ipv4_only" {
            if let Some(info) = self.trace_info(true).await {
                out.push(info);
            }
        }
        Ok(out)
    }
}

/// Parse a trace payload `{ip, country_code, asn}`, rejecting the wrong family.
fn parse_trace(raw: &str, ipv6: bool) -> Option<OutboundIpInfo> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let ip = v.get("ip").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    if ip.is_empty() {
        return None;
    }
    if ipv6 && !ip.contains(':') {
        return None;
    }
    let asn = match v.get("asn").and_then(|x| x.as_i64()).unwrap_or(0) {
        n if n > 0 => format!("AS{n}"),
        _ => String::new(),
    };
    let country = v
        .get("country_code")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    Some(OutboundIpInfo { ip, country, asn })
}

fn status(s: tonic::Status) -> AppError {
    AppError::ClashApi(s.to_string())
}
