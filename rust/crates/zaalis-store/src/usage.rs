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
        self.usage_summary_in_zone(from, to, &[])
    }

    /// Same summary, with days and streaks counted in the caller's local
    /// calendar. `zone` lists `(from_ms, offset_ms)` pairs sorted by time:
    /// the UTC offset that applies from that instant on (daylight saving
    /// included). An empty list means UTC.
    pub fn usage_summary_in_zone(&self, from: u64, to: u64, zone: &[(i64, i64)]) -> Result<Value> {
        if to <= from || to - from > 367 * 86_400_000 {
            return Err(ZaalisError::invalid("période de consommation invalide"));
        }
        if zone.len() > 2000 || zone.windows(2).any(|w| w[0].0 > w[1].0) || zone.iter().any(|(_, o)| o.abs() > 18 * 3_600_000) {
            return Err(ZaalisError::invalid("fuseau horaire invalide"));
        }
        let local_day = |ms: i64| -> i64 {
            let offset = match zone.partition_point(|(start, _)| *start <= ms) {
                0 => zone.first().map(|(_, o)| *o).unwrap_or(0),
                i => zone[i - 1].1,
            };
            (ms + offset).div_euclid(86_400_000)
        };
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
        let mut daily = std::collections::BTreeMap::<i64, (i64, i64)>::new();
        let mut period = connection.prepare("SELECT started_ms,input,output FROM usage_calls WHERE started_ms>=?1 AND started_ms<?2").map_err(sql_error)?;
        for row in period.query_map(params![from as i64,to as i64], |r| Ok((r.get::<_,i64>(0)?, r.get::<_,i64>(1)?, r.get::<_,i64>(2)?))).map_err(sql_error)? {
            let (started, input, output) = row.map_err(sql_error)?;
            let day = daily.entry(local_day(started)).or_default();
            day.0 += input; day.1 += output;
        }
        let days = daily.into_iter().map(|(day,(input,output))| json!({"day":day,"input":input,"output":output})).collect::<Vec<_>>();
        let lifetime: i64 = connection.query_row("SELECT COALESCE(SUM(input+output),0) FROM usage_calls", [], |r| r.get(0)).map_err(sql_error)?;
        let mut active = std::collections::BTreeMap::<i64, i64>::new();
        let mut all_calls = connection.prepare("SELECT started_ms,input+output FROM usage_calls WHERE measured=1 AND input+output>0").map_err(sql_error)?;
        for row in all_calls.query_map([], |r| Ok((r.get::<_,i64>(0)?, r.get::<_,i64>(1)?))).map_err(sql_error)? {
            let (started, tokens) = row.map_err(sql_error)?;
            *active.entry(local_day(started)).or_default() += tokens;
        }
        let (mut longest, mut streak, mut previous, mut peak) = (0, 0, i64::MIN, 0);
        for (day, tokens) in &active {
            streak = if previous != i64::MIN && *day == previous + 1 { streak + 1 } else { 1 };
            longest = longest.max(streak); peak = peak.max(*tokens); previous = *day;
        }
        let today = local_day(zaalis_core::now_ms() as i64);
        let current = if previous != i64::MIN && previous >= today - 1 { streak } else { 0 };
        let timezone = if zone.is_empty() { "UTC" } else { "local" };
        let profile = json!({"total":lifetime,"peak":peak,"activeDays":active.len(),"longestStreak":longest,"currentStreak":current,"dayTimezone":timezone,"today":today});
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

    #[test]
    fn days_follow_the_local_calendar_including_daylight_saving() {
        let d=tempfile::tempdir().unwrap(); let s=Store::open(&d.path().join("store.sqlite")).unwrap();
        let day=86_400_000u64; let base=20_000*day; // a UTC midnight
        // 23:30 UTC is already the next day in Paris (UTC+1 then UTC+2).
        s.record_usage("a","s","p","m",base-30*60_000,"completed",true,Usage{input_tokens:5,..Usage::default()}).unwrap();
        s.record_usage("b","s","p","m",base+day-30*60_000,"completed",true,Usage{input_tokens:7,..Usage::default()}).unwrap();
        let utc=s.usage_summary(base-day,base+2*day).unwrap();
        assert_eq!(utc["days"].as_array().unwrap().iter().map(|d| d["day"].as_i64().unwrap()).collect::<Vec<_>>(),vec![19_999,20_000]);
        let zone=[(0i64,3_600_000i64),((base+day/2) as i64,7_200_000i64)];
        let local=s.usage_summary_in_zone(base-day,base+2*day,&zone).unwrap();
        assert_eq!(local["days"].as_array().unwrap().iter().map(|d| d["day"].as_i64().unwrap()).collect::<Vec<_>>(),vec![20_000,20_001]);
        assert_eq!(local["profile"]["longestStreak"],2);
        assert!(s.usage_summary_in_zone(0,day,&[(10,0),(5,0)]).is_err());
    }
}
