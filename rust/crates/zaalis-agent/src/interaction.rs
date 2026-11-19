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
    clarifications: Mutex<HashMap<RequestId, oneshot::Sender<zaalis_protocol::ClarificationAnswers>>>,
    questions: Mutex<HashMap<RequestId, Vec<zaalis_protocol::ClarificationQuestion>>>,
}

impl InteractionHub {
    pub fn wait_clarification(&self, id: RequestId, questions: Vec<zaalis_protocol::ClarificationQuestion>) -> Result<oneshot::Receiver<zaalis_protocol::ClarificationAnswers>> {
        let receiver=insert_waiter(&self.clarifications, id.clone())?;
        self.questions.lock().expect("questions lock poisoned").insert(id,questions);
        Ok(receiver)
    }
    pub fn decide_clarification(&self, id: &RequestId, answer: zaalis_protocol::ClarificationAnswers) -> Result<()> {
        let mut questions=self.questions.lock().expect("questions lock poisoned");
        let pending=questions.get(id).ok_or_else(||ZaalisError::not_found("question inconnue"))?;
        if answer.len()!=pending.len() || pending.iter().any(|question|answer.get(&question.id).is_none_or(|text|
            text.trim().is_empty() || text.len()>8000 || (!question.allow_free_text && !question.options.iter().any(|option|option.label==*text)))) {
            return Err(ZaalisError::invalid("réponses manquantes ou incompatibles avec les questions"));
        }
        questions.remove(id);
        resolve_waiter(&self.clarifications, id, answer)
    }
    pub fn cancel_clarification(&self, id: &RequestId) {
        self.questions.lock().expect("questions lock poisoned").remove(id);
        self.clarifications.lock().expect("clarification waiters lock poisoned").remove(id);
    }
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
        self.questions.lock().expect("questions lock poisoned").clear();
        self.clarifications.lock().expect("clarification waiters lock poisoned").clear();
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
