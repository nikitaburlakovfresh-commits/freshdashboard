import { provisionBranchActivation } from '../src/domain/branchActivationProvisioning';
import { closePool } from '../src/db/pool';
provisionBranchActivation(process.env.ACTIVATION_LOGIN ?? '', process.env.ACTIVATION_APPROVAL ?? '')
  .then(result => console.log(JSON.stringify(result)))
  .catch(() => { console.error('Branch activation provisioning refused; no credentials or database details logged.'); process.exitCode = 1; })
  .finally(closePool);
