import { provisionBranchReader } from '../src/reporting/branchReaderProvisioning';
import { closePool } from '../src/db/pool';
const [login,role,list,approval,...extra]=process.argv.slice(2);
if(extra.length||!login||!role||!list||!approval) {
  console.error('Usage: provisionBranchReader <login> <ROLE_CODE> <metric,metric> <explicit-approval-reference>');
  process.exitCode=1;
} else {
  provisionBranchReader(login,role,list.split(','),approval).then(r=>console.log(JSON.stringify(r,null,1)))
    .catch(e=>{console.error('Branch reader refused:',e?.message??'');process.exitCode=1;}).finally(closePool);
}
