use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tokio::sync::broadcast;
use zaalis_core::{now_ms, AgentId, SegmentId, SessionId, ToolCallId};
use zaalis_protocol::{Event, EventFrame};

#[derive(Debug)]
pub struct EventBus {
    session_id: SessionId,
    sequence: AtomicU64,
    sender: broadcast::Sender<EventFrame>,
    segments: Mutex<HashMap<SegmentId, AgentId>>,
    tools: Mutex<HashMap<ToolCallId, AgentId>>,
}

impl EventBus {
    pub fn new(session_id: SessionId, capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity.max(16));
        Self {
            session_id,
            sequence: AtomicU64::new(0),
            sender,
            segments: Mutex::new(HashMap::new()),
            tools: Mutex::new(HashMap::new()),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EventFrame> {
        self.sender.subscribe()
    }

    pub fn emit(&self, event: Event) -> EventFrame {
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let inferred_agent = match &event {
            Event::SegmentStarted { segment } => {
                self.segments
                    .lock()
                    .expect("segment map poisoned")
                    .insert(segment.id.clone(), segment.agent_id.clone());
                Some(segment.agent_id.clone())
            }
            Event::SegmentCompleted { segment_id, .. }
            | Event::TextDelta { segment_id, .. }
            | Event::ReasoningDelta { segment_id, .. } => self
                .segments
                .lock()
                .expect("segment map poisoned")
                .get(segment_id)
                .cloned(),
            Event::ToolStarted {
                segment_id,
                call_id,
                ..
            } => {
                let agent = self
                    .segments
                    .lock()
                    .expect("segment map poisoned")
                    .get(segment_id)
                    .cloned();
                if let Some(agent) = &agent {
                    self.tools
                        .lock()
                        .expect("tool map poisoned")
                        .insert(call_id.clone(), agent.clone());
                }
                agent
            }
            Event::ToolProgress { call_id, .. } | Event::ToolCompleted { call_id, .. } => self
                .tools
                .lock()
                .expect("tool map poisoned")
                .get(call_id)
                .cloned(),
            _ => None,
        };
        let remove_segment = match &event {
            Event::SegmentCompleted { segment_id, .. } => Some(segment_id.clone()),
            _ => None,
        };
        let remove_tool = match &event {
            Event::ToolCompleted { call_id, .. } => Some(call_id.clone()),
            _ => None,
        };
        let mut frame = EventFrame::new(self.session_id.clone(), sequence, now_ms(), event);
        if frame.agent_id.is_none() {
            frame.agent_id = inferred_agent;
        }
        let _ = self.sender.send(frame.clone());
        if let Some(segment) = remove_segment {
            self.segments
                .lock()
                .expect("segment map poisoned")
                .remove(&segment);
        }
        if let Some(call) = remove_tool {
            self.tools.lock().expect("tool map poisoned").remove(&call);
        }
        frame
    }

    pub fn current_sequence(&self) -> u64 {
        self.sequence.load(Ordering::SeqCst)
    }
}
