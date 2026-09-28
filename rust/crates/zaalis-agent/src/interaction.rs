use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::oneshot;
use zaalis_core::{PermissionAnswer, RequestId, Result, ZaalisError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanAnswer {
    Approve,
    Reject { feedback: Option<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BudgetAnswer {
    pub additional_tokens: Option<u64>,
    pub stop: bool,
}

#[derive(Debug, Default)]
pub struct InteractionHub {
    permissions: Mutex<HashMap<RequestId, oneshot::Sender<PermissionAnswer>>>,
    plans: Mutex<HashMap<RequestId, oneshot::Sender<PlanAnswer>>>,
    budgets: Mutex<HashMap<RequestId, oneshot::Sender<BudgetAnswer>>>,
}

impl InteractionHub {
    pub fn wait_permission(&self, id: RequestId) -> Result<oneshot::Receiver<PermissionAnswer>> {
        insert_waiter(&self.permissions, id)
    }

    pub fn decide_permission(&self, id: &RequestId, answer: PermissionAnswer) -> Result<()> {
        resolve_waiter(&self.permissions, id, answer)
    }

    pub fn wait_plan(&self, id: RequestId) -> Result<oneshot::Receiver<PlanAnswer>> {
        insert_waiter(&self.plans, id)
    }

    pub fn decide_plan(&self, id: &RequestId, answer: PlanAnswer) -> Result<()> {
        resolve_waiter(&self.plans, id, answer)
    }

    pub fn wait_budget(&self, id: RequestId) -> Result<oneshot::Receiver<BudgetAnswer>> {
        insert_waiter(&self.budgets, id)
    }

    pub fn decide_budget(&self, id: &RequestId, answer: BudgetAnswer) -> Result<()> {
        resolve_waiter(&self.budgets, id, answer)
    }

    pub fn cancel_all(&self) {
        self.permissions
            .lock()
            .expect("permission waiters lock poisoned")
            .clear();
        self.plans
            .lock()
            .expect("plan waiters lock poisoned")
            .clear();
        self.budgets
            .lock()
            .expect("budget waiters lock poisoned")
            .clear();
    }
}

fn insert_waiter<T>(
    waiters: &Mutex<HashMap<RequestId, oneshot::Sender<T>>>,
    id: RequestId,
) -> Result<oneshot::Receiver<T>> {
    let (sender, receiver) = oneshot::channel();
    let previous = waiters
        .lock()
        .expect("interaction waiters lock poisoned")
        .insert(id.clone(), sender);
    if previous.is_some() {
        return Err(ZaalisError::internal(format!(
            "demande d'interaction dupliquée : {id}"
        )));
    }
    Ok(receiver)
}

fn resolve_waiter<T>(
    waiters: &Mutex<HashMap<RequestId, oneshot::Sender<T>>>,
    id: &RequestId,
    answer: T,
) -> Result<()> {
    waiters
        .lock()
        .expect("interaction waiters lock poisoned")
        .remove(id)
        .ok_or_else(|| ZaalisError::not_found(format!("demande inconnue : {id}")))?
        .send(answer)
        .map_err(|_| ZaalisError::cancelled())
}
