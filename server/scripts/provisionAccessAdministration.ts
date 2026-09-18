import { provisionAccessAdministration } from '../src/domain/accessProvisioning';
import { closePool } from '../src/db/pool';
provisionAccessAdministration(process.env.ACCESS_ADMIN_LOGIN??'',process.env.ACCESS_ADMIN_APPROVAL??'')
  .then(result=>console.log(JSON.stringify(result)))
  .catch(()=>{console.error('Access administration provisioning refused; no credentials logged.');process.exitCode=1;})
  .finally(closePool);
