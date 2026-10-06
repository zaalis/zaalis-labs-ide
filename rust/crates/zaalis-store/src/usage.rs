use crate::{sql_error, Store};
use rusqlite::params;
use serde_json::{json, Value};
use zaalis_core::{Result, Usage, ZaalisError};

impl Store {
    /// One row per provider request. Streaming snapshots replace the row;
    /// cumulative session totals never enter this ledger.
    pub fn record_usage(&self, id: &str, session: &str, provider: &str, model: &str,
        started: u64, status: &str, measured: bool, usage: Usage) -> Result<()> {
        self.connection.lock().expect("store lock poisoned").execute(
            "INSERT INTO usage_calls(id,session_id,provider,model,started_ms,status,measured,input,output,cached,reasoning)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(id) DO UPDATE SET status=excluded.status,measured=excluded.measured,
             input=excluded.input,output=excluded.output,cached=excluded.cached,reasoning=excluded.reasoning",
            params![id,session,provider,model,started as i64,status,measured,
                usage.input_tokens as i64,usage.output_tokens as i64,usage.cached_tokens as i64,usage.reasoning_tokens as i64]
        ).map_err(sql_error)?;
        Ok(())
    }

    pub fn usage_summary(&self, from: u64, to: u64) -> Result<Value> {
        if to <= from || to - from > 367 * 86_400_000 {
            return Err(ZaalisError::invalid("période de consommation invalide"));
        }
        let connection = self.connection.lock().expect("store lock poisoned");
        let mut statement = connection.prepare(
            "SELECT provider,model,COUNT(*),SUM(input),SUM(output),SUM(cached),SUM(reasoning),
             SUM(CASE WHEN measured=0 THEN 1 ELSE 0 END),SUM(CASE WHEN status!='completed' THEN 1 ELSE 0 END)
             FROM usage_calls WHERE started_ms>=?1 AND started_ms<?2 GROUP BY provider,model ORDER BY SUM(input+output) DESC"
        ).map_err(sql_error)?;
        let rows = statement.query_map(params![from as i64,to as i64], |r| Ok(json!({
            "provider":r.get::<_,String>(0)?,"model":r.get::<_,String>(1)?,
            "calls":r.get::<_,i64>(2)?,"input":r.get::<_,i64>(3)?,"output":r.get::<_,i64>(4)?,
            "cached":r.get::<_,i64>(5)?,"reasoning":r.get::<_,i64>(6)?,
            "unmeasured":r.get::<_,i64>(7)?,"unfinished":r.get::<_,i64>(8)?
        }))).map_err(sql_error)?;
        let models = rows.collect::<std::result::Result<Vec<_>,_>>().map_err(sql_error)?;
        let mut total = json!({"input":0,"output":0,"cached":0,"reasoning":0,"calls":0,"unmeasured":0,"unfinished":0});
        for row in &models {
            for key in ["input","output","cached","reasoning","calls","unmeasured","unfinished"] {
                total[key]=json!(total[key].as_u64().unwrap_or(0)+row[key].as_u64().unwrap_or(0));
            }
        }
        let mut daily = connection.prepare("SELECT started_ms/86400000, SUM(input), SUM(output)
            FROM usage_calls WHERE started_ms>=?1 AND started_ms<?2 GROUP BY started_ms/86400000 ORDER BY 1").map_err(sql_error)?;
        let days = daily.query_map(params![from as i64,to as i64],|r| Ok(json!({"day":r.get::<_,i64>(0)?,"input":r.get::<_,i64>(1)?,"output":r.get::<_,i64>(2)?})))
            .map_err(sql_error)?.collect::<std::result::Result<Vec<_>,_>>().map_err(sql_error)?;
        let lifetime: i64 = connection.query_row("SELECT COALESCE(SUM(input+output),0) FROM usage_calls", [], |r| r.get(0)).map_err(sql_error)?;
        let mut all_days = connection.prepare("SELECT started_ms/86400000, SUM(input+output) FROM usage_calls WHERE measured=1 AND input+output>0 GROUP BY started_ms/86400000 ORDER BY 1").map_err(sql_error)?;
        let activity = all_days.query_map([], |r| Ok((r.get::<_,i64>(0)?, r.get::<_,i64>(1)?)))
            .map_err(sql_error)?.collect::<std::result::Result<Vec<_>,_>>().map_err(sql_error)?;
        let (mut longest, mut streak, mut previous, mut peak) = (0, 0, -2, 0);
        for (day, tokens) in &activity {
            streak = if *day == previous + 1 { streak + 1 } else { 1 };
            longest = longest.max(streak); peak = peak.max(*tokens); previous = *day;
        }
        let today = (zaalis_core::now_ms() / 86_400_000) as i64;
        let current = if previous >= today - 1 { streak } else { 0 };
        let profile = json!({"total":lifetime,"peak":peak,"activeDays":activity.len(),"longestStreak":longest,"currentStreak":current,"dayTimezone":"UTC"});
        Ok(json!({"from":from,"to":to,"total":total,"models":models,"days":days,"profile":profile,"basis":"provider_reported","historicalBackfill":false}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ledger_survives_restart_deduplicates_streams_and_respects_periods() {
        let d=tempfile::tempdir().unwrap(); let p=d.path().join("store.sqlite");
        let s=Store::open(&p).unwrap();
        s.record_usage("a","s","mistral","small",1000,"running",true,Usage{input_tokens:10,..Usage::default()}).unwrap();
        s.record_usage("a","s","mistral","small",1000,"completed",true,Usage{input_tokens:10,output_tokens:5,..Usage::default()}).unwrap();
        s.record_usage("b","s","mistral","small",2000,"interrupted",false,Usage::default()).unwrap();
        drop(s); let s=Store::open(&p).unwrap();
        let v=s.usage_summary(999,2001).unwrap();
        assert_eq!(v["total"]["input"],10); assert_eq!(v["total"]["output"],5);
        assert_eq!(v["total"]["calls"],2); assert_eq!(v["total"]["unmeasured"],1);
        assert_eq!(s.usage_summary(1001,2000).unwrap()["total"]["calls"],0);
        assert!(s.usage_summary(2000,1000).is_err());
    }
}
