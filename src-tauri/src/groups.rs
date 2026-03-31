use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::clash::{ClashClient, ProxyGroup};
use crate::error::AppError;

/// Shared proxy group state
pub struct GroupState {
    pub groups: Vec<ProxyGroup>,
    pub client: Option<ClashClient>,
}

pub type Groups = Arc<Mutex<GroupState>>;

pub fn new_groups() -> Groups {
    Arc::new(Mutex::new(GroupState {
        groups: Vec::new(),
        client: None,
    }))
}

impl GroupState {
    /// Fetch selector groups from the Clash API and cache them
    pub async fn load(&mut self, client: ClashClient) -> Result<Vec<ProxyGroup>, AppError> {
        let groups = client.get_selector_groups().await?;
        self.groups = groups.clone();
        self.client = Some(client);
        Ok(groups)
    }

    /// Switch proxy and update local state
    pub async fn switch(&mut self, group: &str, proxy: &str) -> Result<(), AppError> {
        let client = self
            .client
            .as_ref()
            .ok_or_else(|| AppError::ClashApi("not connected".into()))?;

        client.switch_proxy(group, proxy).await?;

        // Update local state
        if let Some(g) = self.groups.iter_mut().find(|g| g.name == group) {
            g.now = proxy.to_string();
        }

        Ok(())
    }

    /// Test delay for a group and return results
    pub async fn test_delay(&self, group: &str) -> Result<HashMap<String, i32>, AppError> {
        let client = self
            .client
            .as_ref()
            .ok_or_else(|| AppError::ClashApi("not connected".into()))?;

        client.test_group_delay(group).await
    }

    /// Clear state (called on core stop)
    pub fn clear(&mut self) {
        self.groups.clear();
        self.client = None;
    }
}
