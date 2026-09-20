import { extendFactAccess } from '../src/reporting/factProvisioning';
import { PUBLISHABLE_METRICS } from '../src/reporting/publishableMetrics';
import { withTransaction, closePool } from '../src/db/pool';
const [scope,capability,approval,...extra]=process.argv.slice(2);
// scope: конкретный grant uuid либо ALL — все действующие допуска этой capability.
async function main() {
  if(extra.length||!scope||!capability||!approval)throw new Error('Usage: extendFactAccess <grant-uuid|ALL> <READ|PUBLISH> <approval>');
  const grants=scope==='ALL'
    ?(await withTransaction(c=>c.query('SELECT grant_id FROM report_fact_access WHERE capability=$1 AND revoked_at IS NULL',[capability]))).rows.map((r:any)=>r.grant_id)
    :[scope];
  for(const g of grants) console.log(JSON.stringify(await extendFactAccess(g,capability,PUBLISHABLE_METRICS,approval)));
}
main().catch(e=>{console.error(String(e.message??e));process.exitCode=1;}).finally(closePool);
