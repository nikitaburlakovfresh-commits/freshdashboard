import { provisionOrganizationEditor } from '../src/domain/orgEditorProvisioning';
import { closePool } from '../src/db/pool';
provisionOrganizationEditor(process.env.ORG_EDITOR_LOGIN ?? '',process.env.ORG_EDITOR_APPROVAL ?? '')
  .then(result=>console.log(JSON.stringify(result)))
  .catch(()=>{ console.error('Organization editor provisioning refused; no credentials or database details logged.'); process.exitCode=1; })
  .finally(closePool);
