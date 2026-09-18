import { provisionFactAdministrator } from '../src/reporting/factAdminProvisioning';
import { closePool } from '../src/db/pool';
const [login,approval,...extra]=process.argv.slice(2);
if(extra.length||!login||!approval) {
 console.error('Usage: provisionFactAdministrator <existing-bootstrap-login> <explicit-approval-reference>');
 process.exitCode=1;
}else{
 provisionFactAdministrator(login,approval).then(r=>console.log(JSON.stringify(r)))
   .catch(()=>{console.error('Fact administration provisioning refused; no automatic regrant.');process.exitCode=1;})
   .finally(closePool);
}
