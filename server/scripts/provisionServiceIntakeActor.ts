import { provisionServiceIntakeActor, revokeServiceIntakeActor } from '../src/domain/serviceIntakeProvisioning';
import { closePool } from '../src/db/pool';
const [mode,...rest]=process.argv.slice(2);
const usage='Usage: provisionServiceIntakeActor create <code> <display-name> <purpose> <metric,metric> <approval-reference> <authorizing-admin-login>\n       provisionServiceIntakeActor revoke <code> <reason>';
const run=async()=>{
  if(mode==='create') {
    const [code,name,purpose,metrics,approval,login,...extra]=rest;
    if(extra.length||!code||!name||!purpose||!metrics||!approval||!login) throw new Error(usage);
    return provisionServiceIntakeActor(code,name,purpose,metrics.split(','),approval,login);
  }
  if(mode==='revoke') {
    const [code,reason,...extra]=rest;
    if(extra.length||!code||!reason) throw new Error(usage);
    return revokeServiceIntakeActor(code,reason);
  }
  throw new Error(usage);
};
run().then(r=>console.log(JSON.stringify(r)))
  .catch(e=>{console.error(String(e instanceof Error?e.message:e));process.exitCode=1;})
  .finally(closePool);
