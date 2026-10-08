import assert from 'node:assert/strict';
import bridge from './worker.js';

const connections = new Map();
const donations = new Map();
const env = {
  ROBLOX_API_KEY: 'fake-integration-test-key',
  TOKEN_HASH_PEPPER: 'test-hmac-secret-at-least-32-characters-abcdefgh',
  ADMIN_KEY: 'admin-test-secret',
  SOCIA_VERIFY_MODE: 'TOKEN',
  DB: {
    prepare(sql) {
      const params = [];
      const query = {
        bind(...values) { params.push(...values); return this; },
        async first() {
          if (sql.includes('WHERE user_id = ?')) return connections.get(params[0]) || null;
          if (sql.includes('WHERE token_hash = ?')) return [...connections.values()].find(x => x.token_hash === params[0]) || null;
          if (sql.includes('WHERE connection_id=?')) return [...connections.values()].find(x => x.connection_id === params[0]) || null;
          throw new Error('unexpected first ' + sql);
        },
        async run() {
          if (sql.includes('INSERT INTO connections')) {
            const [user_id,connection_id,token_hash,token_last4,webhook_secret,created_at,updated_at] = params;
            connections.set(user_id,{user_id,connection_id,token_hash,token_last4,webhook_secret,created_at,updated_at,status:'pending'});
            return {meta:{changes:1}};
          }
          if (sql.includes('DELETE FROM connections')) { connections.delete(params[0]); return {meta:{changes:1}}; }
          if (sql.includes('INSERT OR IGNORE INTO donations')) {
            if (donations.has(params[0])) return {meta:{changes:0}};
            donations.set(params[0],{id:params[0],username:params[1],amount:params[2],message:params[3],currency:params[4],created_at:params[5],
              created_at_iso:params[6],raw_hash:params[7],recipient_user_id:params[8],connection_id:params[9],state:'queued',attempts:0});
            return {meta:{changes:1}};
          }
          if (sql.includes('UPDATE connections SET status')) {
            let row=connections.get(params[5]); if(row) Object.assign(row,{status:params[0],verified_at:params[1],last_webhook_at:params[2],verification:params[3],updated_at:params[4]});
            return {meta:{changes:1}};
          }
          if (sql.includes("UPDATE donations SET state='dead'")) return {meta:{changes:0}};
          if (sql.includes("UPDATE donations SET state='done'")) {
            let d=donations.get(params[1]);if(d&&d.lease_token===params[2])d.state='done';return {meta:{changes:1}};
          }
          throw new Error('unexpected run ' + sql);
        },
        async all() {
          if (sql.includes("UPDATE donations SET state='leased'")) {
            const list = [...donations.values()].filter(d=>d.state==='queued').slice(0,params[4]);
            list.forEach(d=>Object.assign(d,{state:'leased',lease_token:params[0],attempts:d.attempts+1}));
            return {results:list};
          }
          throw new Error('unexpected all ' + sql);
        }
      };
      return query;
    },
    async batch(stmts) { for(const s of stmts) await s.run(); }
  }
};

async function req(route, body={}, headers={}) {
  const response = await bridge.fetch(new Request('https://local.test'+route,{
    method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)
  }),env);
  return {status:response.status, body:await response.json()};
}
const api={'x-api-key':env.ROBLOX_API_KEY};
const a=await req('/api/connect',{userId:1234,token:'tok_ABC123456789'},api);
assert.equal(a.status,200);
assert.equal(a.body.connection.status,'pending');
const url=new URL(a.body.connection.webhookUrl);
assert.equal((await req(url.pathname,{amount:10000,token:'wrong-token',id:'txn1'})).status,401);
const donation={id:'txn1',token:'tok_ABC123456789',supporter_name:'Tester',amount:10000,message:'test'};
const first=await req(url.pathname,donation);
assert.equal(first.status,200);assert.equal(first.body.queued,true);
const repeat=await req(url.pathname,donation);
assert.equal(repeat.status,200);assert.equal(repeat.body.duplicate,true);
const b=await req('/api/connection/status',{userId:1234},api);
assert.equal(b.body.connection.status,'connected');
const pulled=await req('/api/pull',{serverId:'a',limit:5},api);
assert.equal(pulled.body.items.length,1);assert.equal(pulled.body.items[0].recipientUserId,1234);
const ack=await req('/api/ack',{items:[{id:pulled.body.items[0].id,leaseToken:pulled.body.items[0].leaseToken,status:'done'}]},api);
assert.equal(ack.body.ok,true);assert.equal([...donations.values()][0].state,'done');
const duplicate=await req('/api/connect',{userId:5555,token:'tok_ABC123456789'},api);
assert.equal(duplicate.status,409);
console.log('WORKER_CONNECT_OK');
console.log('WEBHOOK_TOKEN_REJECT_OK');
console.log('WEBHOOK_ACCEPT_ONCE_OK');
console.log('PULL_RECIPIENT_OK');
console.log('ACK_OK');
console.log('TOKEN_DUPLICATE_BLOCK_OK');
