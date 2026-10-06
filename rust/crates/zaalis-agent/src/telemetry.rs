use std::sync::Arc;
use zaalis_core::{now_ms, RequestId, Usage};
use zaalis_store::Store;

#[derive(Debug)]
pub(crate) struct ProviderCall {
    store: Option<Arc<Store>>, id: String, session: String, provider: String, model: String,
    started: u64, usage: Usage, measured: bool, completed: bool,
}
impl ProviderCall {
    pub fn new(store: Option<Arc<Store>>, session: String, provider: String, model: String) -> Self {
        let value=Self{store,id:RequestId::new().to_string(),session,provider,model,started:now_ms(),usage:Usage::default(),measured:false,completed:false};
        value.persist("started"); value
    }
    fn persist(&self, status: &str) {
        if let Some(store)=&self.store {
            if let Err(e)=store.record_usage(&self.id,&self.session,&self.provider,&self.model,self.started,status,self.measured,self.usage) {
                eprintln!("usage ledger: {}", e.message);
            }
        }
    }
    pub fn observe(&mut self, usage: Usage) { self.usage=usage;self.measured=true;self.persist("running"); }
    pub fn complete(&mut self) { self.completed=true;self.persist("completed"); }
}
impl Drop for ProviderCall {
    fn drop(&mut self) { if !self.completed { self.persist("interrupted"); } }
}
