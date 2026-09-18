// Local synthetic DB only; run once with the new app, once with old app.
const assert=require('node:assert/strict');
const path=require('node:path');
if(process.env.NODE_ENV!=='test'||process.env.PGHOST!=='127.0.0.1'||process.env.PGPORT!=='5433'||
   !['fresh_beta_upgrade','fresh_beta_restore'].includes(process.env.PGDATABASE))
  throw Error('Local rehearsal database required');
const root=path.resolve(process.argv[2]||'');
const {pool}=require(path.join(root,'server/dist/src/db/pool'));
const {createSession,SESSION_COOKIE_NAME}=require(path.join(root,'server/dist/src/auth/session'));
const {createApp}=require(path.join(root,'server/dist/src/app'));
(async()=>{
  const server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;let checks=0;
  try{
    for(const endpoint of ['/api/v1/me','/api/v1/work-items','/api/v1/organization/tree','/api/v1/report-batches']){
      assert.equal((await fetch(base+endpoint)).status,401);checks++;
    }
    const users=(await pool.query('SELECT id FROM app_users ORDER BY login')).rows;
    for(const user of users){
      const c=await pool.connect();let session;
      try{session=await createSession(c,user.id);}finally{c.release();}
      const headers={cookie:`${SESSION_COOKIE_NAME}=${session.rawToken}`};
      for(const endpoint of ['/api/v1/me','/api/v1/work-items','/api/v1/organization/tree']){
        assert.equal((await fetch(base+endpoint,{headers})).status,200);checks++;
      }
    }
    console.log(JSON.stringify({status:'PASS',checks,accounts:users.length,database:process.env.PGDATABASE,app:path.basename(root)}));
  }finally{await new Promise(r=>server.close(r));await pool.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
