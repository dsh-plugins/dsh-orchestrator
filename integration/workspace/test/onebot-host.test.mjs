import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GatewayState, principal } from '@dsh-prism/dsh-im-gateway'
import { completeText, explicitText, privateText } from './fixture-model.mjs'
import { model, startHost, waitFor } from './host-helpers.mjs'

test('signed, paired OneBot DM reaches a real DSH L1 and returns only explicit replies and scoped task cards', {timeout:160_000}, async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(),'prism-onebot-')))
  const self = '10293', user = '72615', other = '73617', inbound = randomUUID(), outbound = randomUUID()
  const sends = []
  const actions = createServer(async(req,res) => {
    if (req.headers.authorization !== 'Bearer ' + outbound) { res.writeHead(401); res.end(); return }
    let body=''
    for await (const chunk of req) body+=chunk
    let data
    if (req.url === '/get_login_info') data = {user_id:Number(self)}
    else if (req.url === '/send_private_msg') {
      const args = JSON.parse(body)
      sends.push({user:String(args.user_id),text:args.message[0].data.text})
      data={message_id:sends.length}
    } else {res.writeHead(404);res.end();return}
    res.setHeader('content-type','application/json')
    res.end(JSON.stringify({status:'ok',retcode:0,data}))
  })
  actions.listen(0,'127.0.0.1')
  await once(actions,'listening')
  t.after(()=>new Promise(done=>actions.close(done)))
  try {
    const statePath=join(base,'gateway.sqlite')
    const state=new GatewayState(statePath)
    const code=state.issuePairingCode('onebot/' + self)
    state.close()
    const desk=join(base,'desk'), project=join(base,'code')
    await Promise.all([mkdir(desk),mkdir(project)])
    await writeFile(join(project,'probe.txt'),'IM-EXECUTOR-ONLY')
    const projects = [
      {id:'desk',workspace:desk,principals:'*'},
      {id:'code',workspace:project,principals:[principal('onebot/'+self,{chat:user,user})]},
    ].map(item=>({...item,description:item.id,stack:['TypeScript'],nodeId:'local',permissions:['read']}))
    const host=await startHost(t,base,{
      mesh:{nodeId:'local'}, registry:{projects},
      orchestrator:{defaultProjectId:'desk',models:{L1:[model('flash')],L2:[model('plan')],L3:[model('exec')]}},
      im:{statePath,onebot:{selfId:self,apiBase:'http://127.0.0.1:'+actions.address().port,
        eventSecretEnv:'PRISM_TEST_IM_SIGN',accessTokenEnv:'PRISM_TEST_IM_ACCESS'}},
    }, {PRISM_TEST_IM_SIGN:inbound,PRISM_TEST_IM_ACCESS:outbound})
    async function message(sender, mid, text, secret=inbound) {
      const raw=JSON.stringify({self_id:Number(self),post_type:'message',message_type:'private',
        sub_type:'friend',user_id:Number(sender),sender:{user_id:Number(sender)},message_id:mid,message:text})
      return fetch(host.origin+'/prism/im/onebot',{method:'POST',headers:{
        'content-type':'application/json','x-self-id':self,'x-signature':'sha1='+createHmac('sha1',secret).update(raw).digest('hex'),
      },body:raw})
    }
    const route=await waitFor(async()=>{
      const response=await message(user,1,'/models','incorrect')
      return response.status !== 404 && response
    }, host.diagnostic)
    assert.equal(route.status,401,host.diagnostic())
    assert.equal((await message(user,1,'/pair '+code)).status,200,host.diagnostic())
    assert.equal((await message(other,2,'/pair '+code)).status,200)
    assert.equal((await message(other,3,'unpaired input')).status,200)
    for(let i=0;i<2;i++) assert.equal((await message(user,4,'请检查项目')).status,200,host.diagnostic())
    await waitFor(()=>sends.some(s=>s.text===completeText) && sends.filter(s=>s.text.includes('已完成')&&s.text.includes('/inspect ')).length>=2,
      ()=>host.diagnostic()+'\n'+JSON.stringify(sends),50000)
    assert.equal(sends.filter(s=>s.text===explicitText).length,1)
    assert.equal(sends.filter(s=>s.text===completeText).length,1)
    assert.ok(sends.every(s=>s.user===user && !s.text.includes(privateText) && !s.text.includes(base)))
    const command = /\/inspect (\S+)/.exec(sends.find(s=>s.text.includes('/inspect ')).text)[0]
    assert.equal((await message(user,5,command)).status,200)
    assert.ok(sends.at(-1).text.includes(privateText))
    const view=await (await host.client('/prism/api/view')).json()
    assert.deepEqual(view.messages,[])
    assert.deepEqual(view.tasks,[])
    const probes=(await readFile(host.logFile,'utf8')).trim().split('\n').map(x=>JSON.parse(x))
    assert.deepEqual(new Set(probes.map(r=>r.model)),new Set(['flash','plan','exec']))
    assert.ok(probes.some(r=>r.exchange?.name==='read' && r.exchange.result.includes('IM-EXECUTOR-ONLY')))
  } finally {t.after(()=>rm(base,{recursive:true,force:true}))}
})
