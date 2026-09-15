import { provisionReportStaging } from '../src/reporting/provisioning';
import { closePool } from '../src/db/pool';

const [login,approval,...extra]=process.argv.slice(2);
if(extra.length || !login || !approval) {
  console.error('Usage: provisionReportStaging <existing-login> <explicit-bounded-approval-reference>');
  process.exitCode=1;
} else {
  provisionReportStaging(login,approval).then(result=>console.log(JSON.stringify(result)))
    .catch(()=>{console.error('Staging provisioning refused; no password or role-wide permissions changed.');process.exitCode=1;})
    .finally(closePool);
}
