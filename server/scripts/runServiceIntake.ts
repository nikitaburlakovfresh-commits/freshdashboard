import { readFileSync } from 'fs';
import path from 'path';
import { runServiceIntake, type RunPlan } from '../src/domain/serviceIntakeRun';
import { closePool } from '../src/db/pool';
const [planPath,sourceDir,...extra]=process.argv.slice(2);
if(extra.length||!planPath||!sourceDir) {
  console.error('Usage: runServiceIntake <plan.json> <source-directory-with-xlsx>');
  process.exitCode=1;
} else {
  const plan=JSON.parse(readFileSync(path.resolve(planPath),'utf8')) as RunPlan;
  runServiceIntake(plan,path.resolve(sourceDir)).then(r=>console.log(JSON.stringify(r,null,2)))
    .catch(e=>{console.error(String(e instanceof Error?e.message:e));process.exitCode=1;})
    .finally(closePool);
}
