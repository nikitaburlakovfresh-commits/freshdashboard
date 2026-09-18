import { provisionFactAccess } from '../src/reporting/factProvisioning';
import { closePool } from '../src/db/pool';
const [grant,capability,list,approval,...extra]=process.argv.slice(2);
if(extra.length||!grant||!capability||!list||!approval) {
  console.error('Usage: provisionFactAccess <existing-grant-uuid> <READ|PUBLISH> <metric,metric> <explicit-approval-reference>');
  process.exitCode=1;
} else {
  provisionFactAccess(grant,capability,list.split(','),approval).then(r=>console.log(JSON.stringify(r)))
    .catch(()=>{console.error('Fact access refused. No role-wide permissions changed.');process.exitCode=1;}).finally(closePool);
}
