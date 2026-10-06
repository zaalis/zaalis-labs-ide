//! Reservations bound concurrent branches. Input is conservatively estimated;
//! provider-reported consumption replaces the reservation when available.
use std::sync::Arc;
use crate::session::SessionInner;
use zaalis_core::{Result, Usage, ZaalisError, ErrorCode};
#[derive(Debug,Default)]
pub(crate) struct Envelope {pub spent:u64,pub reserved:u64}
#[derive(Debug)]
pub(crate) struct Reservation {session:Arc<SessionInner>,amount:u64,settled:bool}
impl Reservation {
    pub async fn acquire(session:Arc<SessionInner>,input:u64,output:u32) -> Result<(Self,u32)> {
        let limit={let tree=session.tree.lock().await;tree.roots().iter().filter_map(|id|tree.get(id).and_then(|n|n.budget.max_tokens)).min()};
        let mut envelope=session.envelope.lock().await;
        let available=limit.map(|l|l.saturating_sub(envelope.spent.saturating_add(envelope.reserved))).unwrap_or(u64::MAX);
        if available<=input {return Err(ZaalisError::new(ErrorCode::BudgetExceeded,"budget commun insuffisant pour le prochain contexte"));}
        let output=output.min((available-input).min(u32::MAX as u64) as u32);
        let amount=input.saturating_add(output as u64);envelope.reserved=envelope.reserved.saturating_add(amount);drop(envelope);
        Ok((Self{session,amount,settled:false},output))
    }
    pub async fn settle(&mut self,usage:Option<Usage>) {
        let mut e=self.session.envelope.lock().await;e.reserved=e.reserved.saturating_sub(self.amount);
        e.spent=e.spent.saturating_add(usage.map(|u|u.total_tokens()).unwrap_or(self.amount));self.settled=true;
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {if !self.settled {let session=Arc::clone(&self.session);let amount=self.amount;
        tokio::spawn(async move {let mut e=session.envelope.lock().await;e.reserved=e.reserved.saturating_sub(amount);e.spent=e.spent.saturating_add(amount);});}}
}
